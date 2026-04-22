/**
 * Entity-resolver Lambda (AGT-03 / ENT-09) — EventBridge target on
 * `kos.agent` consuming `entity.mention.detected` events emitted by
 * voice-capture (Plan 02-04).
 *
 * Realises the 3-stage ENT-09 pipeline (D-09 / D-10 / D-11 / D-12):
 *   1. Embed mention + context (Cohere Embed Multilingual v3, 1024 dim)
 *   2. Find top-20 candidates via @kos/resolver hybrid SQL
 *   3. Dual-read KOS Inbox for Approved + Pending rows of the same
 *      normalised proposed name (Resolved Open Question 5)
 *   4. Route by stage:
 *        approvedPageId    → mention_events with entityId=NULL + Approved hint
 *        auto-merge + cooc → mention_events + entity_merge audit row
 *        auto-merge no co  → demote to llm-disambig (D-11 gate)
 *        llm-disambig      → Sonnet 4.6 disambig + retry-once + Inbox fallback
 *        inbox / empty     → append to Pending (Pitfall 7) OR createInboxRow
 *   5. Emit `mention.resolved` to kos.agent for observability
 *   6. agent_runs primary row + (on merge) entity-resolver.merge audit row
 *   7. langfuseFlush in finally
 *
 * Idempotency key: capture_id + agent_name='entity-resolver:<mention_text>'.
 * Multiple mentions per capture map to multiple agent_runs rows; each is
 * independently idempotent.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  EntityMentionDetectedSchema,
  MentionResolvedSchema,
} from '@kos/contracts';
import {
  embedBatch,
  findCandidates,
  hasProjectCooccurrence,
  type Candidate,
} from '@kos/resolver';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import {
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  insertMentionEvent,
  writeMergeAuditRow,
  getCaptureProjectIds,
  getPool,
} from './persist.js';
import {
  findApprovedOrPendingInbox,
  createInboxRow,
  appendCaptureIdToPending,
} from './inbox.js';
import { runDisambigWithRetry } from './disambig.js';

process.env.CLAUDE_CODE_USE_BEDROCK = '1';
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: 'eu-north-1' });

interface EBEvent {
  detail: unknown;
}

type Stage = 'auto-merge' | 'llm-disambig' | 'inbox';
type Outcome = 'matched' | 'inbox-new' | 'inbox-appended' | 'approved-inbox' | 'unknown';

interface RouteResult {
  stage: Stage;
  outcome: Outcome;
  matchedEntityId?: string;
  inboxPageId?: string;
}

async function resolveCandidateNotionPageIds(
  pool: Awaited<ReturnType<typeof getPool>>,
  cs: Candidate[],
): Promise<string[]> {
  if (cs.length === 0) return [];
  const r = await pool.query(
    `SELECT id, notion_page_id FROM entity_index WHERE id = ANY($1::uuid[])`,
    [cs.map((c) => c.id)],
  );
  const map = new Map<string, string>();
  for (const row of r.rows as Array<{ id: string; notion_page_id: string }>) {
    map.set(String(row.id), String(row.notion_page_id));
  }
  return cs.map((c) => map.get(c.id)).filter((x): x is string => Boolean(x));
}

interface CompleteDisambigInput {
  ownerId: string;
  detail: ReturnType<typeof EntityMentionDetectedSchema.parse>;
  candidates: Candidate[];
  lookup: { approvedPageId?: string; pendingPageId?: string };
  pool: Awaited<ReturnType<typeof getPool>>;
}

/**
 * Drives the disambig→merge OR fall-through-to-Inbox path. Used for both the
 * native llm-disambig stage AND the demoted-from-auto-merge case (D-11).
 */
async function completeDisambigOrInbox(
  i: CompleteDisambigInput,
): Promise<RouteResult> {
  const { ownerId, detail, candidates, lookup, pool } = i;
  const res = await runDisambigWithRetry({
    mention: detail.mention_text,
    contextSnippet: detail.context_snippet,
    candidates,
  });
  if (res.matched_id !== 'unknown') {
    const match = candidates.find((c) => c.id === res.matched_id);
    if (match) {
      await insertMentionEvent({
        ownerId,
        entityId: match.id,
        captureId: detail.capture_id,
        source: detail.source,
        context: detail.context_snippet,
        occurredAt: new Date(detail.occurred_at),
      });
      await writeMergeAuditRow({
        ownerId,
        captureId: detail.capture_id,
        sourceEntityId: null,
        targetEntityId: match.id,
        score: match.hybridScore,
        secondarySignal: 'none',
      });
      return { stage: 'llm-disambig', outcome: 'matched', matchedEntityId: match.id };
    }
  }
  // fallthrough → Inbox
  if (lookup.pendingPageId) {
    await appendCaptureIdToPending(lookup.pendingPageId, detail.capture_id);
    await insertMentionEvent({
      ownerId,
      entityId: null,
      captureId: detail.capture_id,
      source: detail.source,
      context: `${detail.mention_text} — inbox=${lookup.pendingPageId}`,
      occurredAt: new Date(detail.occurred_at),
    });
    return { stage: 'inbox', outcome: 'inbox-appended', inboxPageId: lookup.pendingPageId };
  }
  const notionCandidateIds = await resolveCandidateNotionPageIds(pool, candidates.slice(0, 3));
  const newPageId = await createInboxRow({
    proposedName: detail.mention_text,
    candidateType: detail.candidate_type,
    candidateMatchNotionPageIds: notionCandidateIds,
    sourceCaptureId: detail.capture_id,
    confidence: candidates[0]?.hybridScore ?? 0,
    rawContext: detail.context_snippet,
  });
  await insertMentionEvent({
    ownerId,
    entityId: null,
    captureId: detail.capture_id,
    source: detail.source,
    context: `${detail.mention_text} — inbox=${newPageId}`,
    occurredAt: new Date(detail.occurred_at),
  });
  return { stage: 'inbox', outcome: 'inbox-new', inboxPageId: newPageId };
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    const d = EntityMentionDetectedSchema.parse(event.detail);
    const agentKey = `entity-resolver:${d.mention_text}`;

    if (await findPriorOkRun(d.capture_id, agentKey, ownerId)) {
      return { idempotent: d.mention_text };
    }

    // Cross-agent correlation: capture_id → Langfuse session.id (D-25).
    tagTraceWithCaptureId(d.capture_id);

    const runId = await insertAgentRun({
      ownerId,
      captureId: d.capture_id,
      agentName: agentKey,
      status: 'started',
    });

    try {
      // 1. Embed mention + context (Cohere Multilingual v3, 1024-dim)
      const [emb] = await embedBatch(
        [`${d.mention_text} | ${d.context_snippet}`],
        'search_query',
      );
      if (!emb) throw new Error('embedBatch returned empty result');

      // 2. Capture project IDs (D-11 secondary-signal input)
      const captureProjectIds = await getCaptureProjectIds(ownerId, d.capture_id);

      // 3. Candidates
      const pool = await getPool();
      const candidates = await findCandidates(pool, {
        mention: d.mention_text,
        ownerId,
        embedding: emb,
        limit: 20,
      });

      // 4. Dual-read KOS Inbox (Resolved Open Q5)
      const inboxLookup = await findApprovedOrPendingInbox(d.mention_text);

      let route: RouteResult;
      const top = candidates[0];
      const score = top?.hybridScore ?? 0;

      if (inboxLookup.approvedPageId) {
        // Approved Inbox row exists but may not yet be in entity_index (sync
        // race). Write mention_events with entityId=NULL + source_context
        // noting the Notion page ID; indexer backfills entity_id on next sync.
        await insertMentionEvent({
          ownerId,
          entityId: null,
          captureId: d.capture_id,
          source: d.source,
          context: `${d.mention_text} — approved_inbox=${inboxLookup.approvedPageId}`,
          occurredAt: new Date(d.occurred_at),
        });
        route = {
          stage: 'inbox',
          outcome: 'approved-inbox',
          inboxPageId: inboxLookup.approvedPageId,
        };
      } else if (top && top.stage === 'auto-merge') {
        const hasSecondary = hasProjectCooccurrence(top, captureProjectIds);
        if (hasSecondary) {
          // D-11 auto-merge happy path
          await insertMentionEvent({
            ownerId,
            entityId: top.id,
            captureId: d.capture_id,
            source: d.source,
            context: d.context_snippet,
            occurredAt: new Date(d.occurred_at),
          });
          await writeMergeAuditRow({
            ownerId,
            captureId: d.capture_id,
            sourceEntityId: null,
            targetEntityId: top.id,
            score: top.hybridScore,
            secondarySignal: 'project_cooccurrence',
          });
          route = { stage: 'auto-merge', outcome: 'matched', matchedEntityId: top.id };
        } else {
          // D-11 demote to llm-disambig
          route = await completeDisambigOrInbox({
            ownerId,
            detail: d,
            candidates,
            lookup: inboxLookup,
            pool,
          });
        }
      } else if (top && top.stage === 'llm-disambig') {
        route = await completeDisambigOrInbox({
          ownerId,
          detail: d,
          candidates,
          lookup: inboxLookup,
          pool,
        });
      } else {
        // top.stage === 'inbox' OR no candidates at all
        if (inboxLookup.pendingPageId) {
          await appendCaptureIdToPending(inboxLookup.pendingPageId, d.capture_id);
          await insertMentionEvent({
            ownerId,
            entityId: null,
            captureId: d.capture_id,
            source: d.source,
            context: `${d.mention_text} — inbox=${inboxLookup.pendingPageId}`,
            occurredAt: new Date(d.occurred_at),
          });
          route = {
            stage: 'inbox',
            outcome: 'inbox-appended',
            inboxPageId: inboxLookup.pendingPageId,
          };
        } else {
          const notionCandidateIds = await resolveCandidateNotionPageIds(
            pool,
            candidates.slice(0, 3),
          );
          const newPageId = await createInboxRow({
            proposedName: d.mention_text,
            candidateType: d.candidate_type,
            candidateMatchNotionPageIds: notionCandidateIds,
            sourceCaptureId: d.capture_id,
            confidence: score,
            rawContext: d.context_snippet,
          });
          await insertMentionEvent({
            ownerId,
            entityId: null,
            captureId: d.capture_id,
            source: d.source,
            context: `${d.mention_text} — inbox=${newPageId}`,
            occurredAt: new Date(d.occurred_at),
          });
          route = { stage: 'inbox', outcome: 'inbox-new', inboxPageId: newPageId };
        }
      }

      // Emit mention.resolved for observability + Plan 02-11 e2e assertion.
      const resolved = MentionResolvedSchema.parse({
        capture_id: d.capture_id,
        mention_text: d.mention_text,
        stage: route.stage,
        outcome: route.outcome,
        matched_entity_id: route.matchedEntityId,
        inbox_page_id: route.inboxPageId,
        score,
        resolved_at: new Date().toISOString(),
      });
      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.agent',
              Source: 'kos.agent',
              DetailType: 'mention.resolved',
              Detail: JSON.stringify(resolved),
            },
          ],
        }),
      );

      await updateAgentRun(runId, { status: 'ok', outputJson: resolved });
      return { outcome: route.outcome, stage: route.stage };
    } catch (err) {
      await updateAgentRun(runId, { status: 'error', errorMessage: String(err) });
      throw err;
    }
  } finally {
    await langfuseFlush();
  }
});
