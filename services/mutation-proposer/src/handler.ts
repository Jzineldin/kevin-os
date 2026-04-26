/**
 * mutation-proposer Lambda (AGT-08, Plan 08-04).
 *
 * Consumes capture.received events on kos.capture (kind in {text, voice_transcribed}),
 * runs the 3-stage classifier, and writes pending_mutations rows + emits
 * pending_mutation.proposed on kos.agent for the dashboard Approve gate.
 *
 * Stages:
 *   1. detectImperative()      — bilingual regex pre-filter
 *   2. classifyMutation()      — Haiku 4.5 confirmation + mutation_type
 *      (gated: only advance to Sonnet if is_mutation && confidence >= 0.7)
 *   3. gatherTargetCandidates  — pull candidates from 4 source tables
 *      decideTarget()          — Sonnet 4.6 picks single target or
 *                                up-to-5 alternatives
 *
 * Idempotency: (owner_id, capture_id, agent_name='mutation-proposer',
 * status='ok') in agent_runs short-circuits replays. Additionally
 * insertPendingMutation enforces (capture_id, mutation_type) uniqueness
 * in code.
 *
 * Per CONTEXT D-27: this Lambda never writes to Command Center, never
 * publishes to Postiz, never sends email, never calls Google Calendar.
 *
 * Race-fix (P-9): pending_mutations row is INSERTed BEFORE the
 * pending_mutation.proposed event fires — voice-capture's
 * `hasPendingMutation` race-check sees it on the next read.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PendingMutationProposedSchema } from '@kos/contracts';
import { randomUUID } from 'node:crypto';
import { detectImperative } from './regex.js';
import { classifyMutation, decideTarget } from './classifier.js';
import { gatherTargetCandidates } from './target-resolver.js';
import {
  findPriorOkRun,
  getPool,
  insertAgentRun,
  insertPendingMutation,
  updateAgentRun,
} from './persist.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: process.env.AWS_REGION });

const AGENT_BUS_NAME = process.env.AGENT_BUS_NAME ?? 'kos.agent';

interface EBEvent {
  source?: string;
  'detail-type'?: string;
  detail?: unknown;
}

type CaptureDetail = {
  capture_id?: string;
  kind?: string;
  text?: string;
  raw_text?: string;
  source_text?: string;
  entity_ids?: string[];
};

/** Load Kevin Context block, degrades to '' on failure. */
async function safeLoadKevinContext(ownerId: string): Promise<string> {
  try {
    const mod = await import('@kos/context-loader');
    const pool = await getPool();
    return await mod.loadKevinContextMarkdown(ownerId, pool);
  } catch (err) {
    console.warn('[mutation-proposer] loadKevinContext failed; degrading', err);
    return '';
  }
}

async function safeLoadAdditionalContext(args: {
  ownerId: string;
  captureId: string;
  entityIds: string[];
  rawText: string;
}): Promise<string> {
  try {
    const mod = await import('@kos/context-loader');
    const pool = await getPool();
    const bundle = await mod.loadContext({
      entityIds: args.entityIds,
      agentName: 'mutation-proposer',
      captureId: args.captureId,
      ownerId: args.ownerId,
      rawText: args.rawText,
      maxSemanticChunks: 6,
      pool,
    });
    return bundle.assembled_markdown ?? '';
  } catch (err) {
    console.warn('[mutation-proposer] loadContext failed; degrading', err);
    return '';
  }
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    const detail = (event?.detail ?? {}) as CaptureDetail;
    if (!detail.capture_id) return { skipped: 'no_capture_id' };

    const kind = detail.kind ?? '';
    // Accept text-bearing capture kinds. voice_transcribed is the post-
    // Transcribe shape; text comes from Telegram-text + dashboard captures.
    const supportedKinds = new Set(['text', 'voice_transcribed', 'telegram-text', 'dashboard-text']);
    if (!supportedKinds.has(kind)) return { skipped: `kind=${kind}` };

    tagTraceWithCaptureId(detail.capture_id);
    const text: string = detail.text ?? detail.raw_text ?? detail.source_text ?? '';
    if (!text.trim()) return { skipped: 'empty_text' };

    // Stage 1: regex
    const impMatch = detectImperative(text);
    if (!impMatch.matched) return { skipped: 'not_imperative' };

    // Idempotency
    if (await findPriorOkRun(detail.capture_id, 'mutation-proposer', ownerId)) {
      return { idempotent: true, capture_id: detail.capture_id };
    }

    const runId = await insertAgentRun({
      ownerId,
      captureId: detail.capture_id,
      agentName: 'mutation-proposer',
      status: 'started',
    });

    try {
      // Stage 2: Haiku
      const kevinContext = await safeLoadKevinContext(ownerId);
      const haikuResult = await classifyMutation(text, kevinContext);

      if (!haikuResult.is_mutation || haikuResult.confidence < 0.7) {
        await updateAgentRun(runId, {
          status: 'ok',
          outputJson: {
            decision: !haikuResult.is_mutation ? 'false_positive' : 'low_confidence',
            haiku: haikuResult,
            stripped_text: impMatch.stripped_text,
            matched_verb: impMatch.matched_verb,
            lang: impMatch.lang,
          },
        });
        return {
          skipped: !haikuResult.is_mutation ? 'false_positive' : 'low_confidence',
          haiku_confidence: haikuResult.confidence,
        };
      }

      // mutation_type 'other' / 'none' don't dispatch even if is_mutation=true.
      if (haikuResult.mutation_type === 'none' || haikuResult.mutation_type === 'other') {
        await updateAgentRun(runId, {
          status: 'ok',
          outputJson: { decision: 'unsupported_mutation_type', haiku: haikuResult },
        });
        return { skipped: `unsupported_type:${haikuResult.mutation_type}` };
      }

      // Stage 3: Sonnet — gather candidates first.
      const pool = await getPool();
      const entityIds = Array.isArray(detail.entity_ids) ? detail.entity_ids : [];
      const candidates = await gatherTargetCandidates({
        pool,
        ownerId,
        mutationType: haikuResult.mutation_type,
        entityIds,
        recentText: text,
      });

      if (candidates.length === 0) {
        await updateAgentRun(runId, {
          status: 'ok',
          outputJson: { decision: 'no_target_candidates', haiku: haikuResult },
        });
        return { skipped: 'no_target_candidates' };
      }

      const additionalContext = await safeLoadAdditionalContext({
        ownerId,
        captureId: detail.capture_id,
        entityIds,
        rawText: text,
      });

      const sonnetResult = await decideTarget({
        text,
        haikuResult,
        kevinContext,
        additionalContext,
        candidates,
      });

      if (
        !sonnetResult.selected_target &&
        sonnetResult.alternatives.length === 0
      ) {
        await updateAgentRun(runId, {
          status: 'ok',
          outputJson: {
            decision: 'no_confident_target',
            haiku: haikuResult,
            sonnet: sonnetResult,
          },
        });
        return { skipped: 'no_confident_target' };
      }

      // Persist + emit
      const mutationId = randomUUID();
      const primary =
        sonnetResult.selected_target ??
        // No primary — promote the top alternative as the row's "target_*"
        // anchor; the dashboard will surface alternatives as the
        // disambiguation list to pick from.
        ({
          kind: sonnetResult.alternatives[0]?.kind ?? 'unknown',
          id: sonnetResult.alternatives[0]?.id ?? 'unknown',
          display:
            sonnetResult.alternatives[0]?.display ??
            'ambiguous — see alternatives',
          confidence: sonnetResult.alternatives[0]?.confidence ?? 0,
        } as const);

      const persisted = await insertPendingMutation(pool, {
        id: mutationId,
        ownerId,
        captureId: detail.capture_id,
        mutationType: haikuResult.mutation_type,
        targetKind: primary.kind,
        targetId: primary.id,
        targetDisplay: primary.display,
        confidence: primary.confidence,
        reasoning: sonnetResult.reasoning,
        alternatives: sonnetResult.alternatives,
      });

      const finalMutationId = persisted.id;
      const proposedPayload = PendingMutationProposedSchema.parse({
        mutation_id: finalMutationId,
        capture_id: detail.capture_id,
        mutation_type: haikuResult.mutation_type,
        target_ref: { kind: primary.kind, id: primary.id, display: primary.display },
        confidence: primary.confidence,
        reasoning: sonnetResult.reasoning,
        proposed_at: new Date().toISOString(),
        ...(sonnetResult.alternatives.length
          ? {
              alternatives: sonnetResult.alternatives.map((a) => ({
                target_ref: { kind: a.kind, id: a.id, display: a.display },
                confidence: a.confidence,
              })),
            }
          : {}),
      });

      try {
        await eb.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: AGENT_BUS_NAME,
                Source: 'kos.agent',
                DetailType: 'pending_mutation.proposed',
                Detail: JSON.stringify(proposedPayload),
              },
            ],
          }),
        );
      } catch (err) {
        // Emit failure does NOT roll back — the row is durable; dashboard
        // polls /api/inbox separately so Kevin still sees it.
        console.warn('[mutation-proposer] PutEvents failed (row already persisted)', err);
      }

      await updateAgentRun(runId, {
        status: 'ok',
        outputJson: {
          decision: persisted.alreadyExists ? 'idempotent_emit' : 'proposed',
          mutation_id: finalMutationId,
          haiku: haikuResult,
          sonnet: sonnetResult,
        },
      });

      return {
        proposed: finalMutationId,
        idempotent: persisted.alreadyExists,
      };
    } catch (err) {
      await updateAgentRun(runId, { status: 'error', errorMessage: String(err) });
      throw err;
    }
  } finally {
    await langfuseFlush();
  }
});
