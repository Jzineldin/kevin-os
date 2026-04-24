/**
 * @kos/service-transcript-extractor — AGT-06 (Phase 6 Plan 06-02).
 *
 * EventBridge target on `kos.capture` consuming `transcript.available`
 * (emitted by Plan 06-01 granola-poller). Reads transcript body from
 * Notion, calls Sonnet 4.6 via direct AnthropicBedrock SDK with `tool_use`
 * for structured output, then:
 *   1. Writes action items into Kevin's Command Center in Swedish schema
 *      (Uppgift / Typ / Prioritet / Anteckningar / Status) with [Granola:
 *      <title>] provenance prefix.
 *   2. Bulk-inserts mention_events rows so the dashboard timeline picks up
 *      Granola mentions immediately (entity_id NULL — resolver attaches
 *      canonical ids downstream).
 *   3. Emits one `entity.mention.detected` per extracted entity to
 *      `kos.agent` so the existing Phase 2 entity-resolver Lambda processes
 *      them through its 3-stage pipeline unchanged.
 *   4. Records a transcripts_indexed audit row (agent_runs with agent_name
 *      = 'transcript-indexed') for Plan 06-03's azure-search-indexer-transcripts
 *      to consume as its delta cursor source.
 *
 * D-21 idempotency: prior `agent_runs` row with status='ok' for
 * (capture_id, agent_name='transcript-extractor', owner_id) → short-circuit.
 *
 * D-28 instrumentation: initSentry + setupOtelTracingAsync +
 * tagTraceWithCaptureId(transcript_id) + langfuseFlush() in finally.
 *
 * Wave-2 placeholder (per CONTEXT D-13): `loadKevinContextBlockOnce` is a
 * temporary in-package copy of the Phase 2 helper; Plan 06-05 will replace
 * with `@kos/context-loader::loadContext` for full entity dossier wiring.
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-02-PLAN.md
 *            .planning/phases/06-granola-semantic-memory/06-CONTEXT.md
 */
import { Client as NotionClient } from '@notionhq/client';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import {
  TranscriptAvailableSchema,
  type TranscriptAvailable,
} from '@kos/contracts/context';
import { runExtractorAgent } from './agent.js';
import {
  readTranscriptBody,
  writeActionItemsToCommandCenter,
} from './notion.js';
import {
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  loadKevinContextBlockOnce,
  writeMentionEvents,
  writeTranscriptIndexed,
  publishMentionsDetected,
  getPool,
} from './persist.js';
// Phase 6 Plan 06-05 (AGT-04): explicit loadContext() replaces the Wave-2
// placeholder loadKevinContextBlockOnce. The full library returns a
// ContextBundle with Kevin Context + entity dossiers + Azure semantic
// chunks (using transcript text as the rawText for the degraded path,
// since the resolver downstream is the one that converts attendees →
// entity_ids). Falls back to the legacy markdown-only block on failure.
import { loadContext } from '@kos/context-loader';

// Bedrock direct SDK requires this — we DO NOT use the Claude Agent SDK
// per Locked Decision #3 (revised 2026-04-23). The flag is harmless when
// AnthropicBedrock is the only client.
process.env.CLAUDE_CODE_USE_BEDROCK = '1';
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

let notion: NotionClient | null = null;

async function getNotion(): Promise<NotionClient> {
  if (notion) return notion;
  const arn = process.env.NOTION_TOKEN_SECRET_ARN;
  const direct = process.env.NOTION_TOKEN;
  if (direct) {
    notion = new NotionClient({ auth: direct });
    return notion;
  }
  if (!arn) throw new Error('NOTION_TOKEN_SECRET_ARN env var not set');
  const sm = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const token = res.SecretString ?? '';
  if (!token || token === 'PLACEHOLDER') {
    throw new Error('NOTION_TOKEN secret is empty or PLACEHOLDER');
  }
  notion = new NotionClient({ auth: token });
  return notion;
}

// EventBridge envelope shape — matches the AWS Lambda destination contract.
// We avoid `aws-lambda` types here so the package needs no extra @types/*
// install (mirrors services/granola-poller/src/handler.ts).
interface EBEvent {
  source: string;
  'detail-type': string;
  detail: unknown;
  time?: string;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();

  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    if (event['detail-type'] !== 'transcript.available') {
      return { skipped: event['detail-type'] };
    }
    const detail: TranscriptAvailable = TranscriptAvailableSchema.parse(event.detail);
    tagTraceWithCaptureId(detail.transcript_id);

    // D-21 idempotency.
    if (await findPriorOkRun(detail.capture_id, 'transcript-extractor', ownerId)) {
      return { idempotent: detail.capture_id };
    }

    const runId = await insertAgentRun({
      ownerId,
      captureId: detail.capture_id,
      agentName: 'transcript-extractor',
      status: 'started',
    });

    try {
      // 1. Read transcript body from Notion. The TranscriptAvailable event
      //    envelope only carries raw_length (per shipped contract), so the
      //    extractor re-fetches the body via the page id.
      const notionClient = await getNotion();
      const body = await readTranscriptBody(notionClient, detail.notion_page_id);
      if (!body || body.trim().length === 0) {
        await updateAgentRun(runId, {
          status: 'ok',
          outputJson: { skipped: 'empty_transcript', transcript_id: detail.transcript_id },
        });
        return {
          status: 'skipped',
          reason: 'empty_transcript',
          transcript_id: detail.transcript_id,
        };
      }

      // 2. Load context bundle (Plan 06-05 AGT-04). Degraded path uses
      //    transcript text for Azure semantic search since attendees haven't
      //    been resolved to entity_ids yet (resolver does that downstream
      //    via entity.mention.detected). Falls back to Kevin-Context-only
      //    on any subfetch failure (loadContext is non-throwing — it
      //    surfaces errors via partial=true / partial_reasons).
      let contextBlock: string;
      try {
        const pool = await getPool();
        const bundle = await loadContext({
          entityIds: [],
          agentName: 'transcript-extractor',
          captureId: detail.capture_id,
          ownerId,
          // Truncate transcript for the semantic-search degraded path. The
          // full body is still passed to Sonnet via runExtractorAgent.
          rawText: body.slice(0, 2000),
          maxSemanticChunks: 8,
          pool,
        });
        contextBlock = bundle.assembled_markdown;
      } catch (err) {
        console.warn(
          '[transcript-extractor] loadContext failed, falling back to Kevin Context only:',
          err,
        );
        contextBlock = await loadKevinContextBlockOnce(ownerId);
      }

      // 3. Run Sonnet 4.6 with tool_use for structured extraction.
      const { extract, usage, rawToolInput, degraded } = await runExtractorAgent({
        transcriptText: body,
        title: detail.title ?? 'untitled',
        contextBlock,
      });
      console.log('[transcript-extractor] tool_use input', {
        captureId: detail.capture_id,
        transcriptId: detail.transcript_id,
        actionItems: extract.action_items.length,
        mentions: extract.mentioned_entities.length,
        degraded,
        rawToolInput,
      });

      // 4. Write action items → Command Center (Swedish schema, Granola provenance).
      const ccDbId = process.env.NOTION_COMMAND_CENTER_DB_ID;
      if (!ccDbId) throw new Error('NOTION_COMMAND_CENTER_DB_ID env var not set');
      const transcriptNotionUrl = `https://www.notion.so/${detail.notion_page_id.replace(/-/g, '')}`;
      const createdPageIds = await writeActionItemsToCommandCenter({
        notion: notionClient,
        commandCenterDbId: ccDbId,
        detail,
        transcriptNotionUrl,
        items: extract.action_items,
      });

      // 5. Bulk-insert mention_events (Phase 2 schema columns: source/context).
      const pool = await getPool();
      const mentionsWritten = await writeMentionEvents({
        pool,
        detail,
        mentions: extract.mentioned_entities,
      });

      // 6. transcripts_indexed audit row (Plan 06-03 cursor source).
      await writeTranscriptIndexed({
        pool,
        detail,
        extraction: extract,
        recordedAt: new Date(detail.last_edited_time),
      });

      // 7. PutEvents — entity.mention.detected per mention. The first
      //    Command Center page id (if any) is attached for cross-agent
      //    traceability; absent if the LLM extracted no action items.
      const mentionsPublished = await publishMentionsDetected({
        detail,
        mentions: extract.mentioned_entities,
        commandCenterPageId: createdPageIds[0],
      });

      await updateAgentRun(runId, {
        status: 'ok',
        outputJson: {
          transcript_id: detail.transcript_id,
          notion_page_id: detail.notion_page_id,
          title: detail.title,
          action_items_written: createdPageIds.length,
          mentions_written_db: mentionsWritten,
          mentions_published_eb: mentionsPublished,
          summary: extract.summary.slice(0, 400),
          decisions: extract.decisions,
          open_questions: extract.open_questions,
          degraded,
        },
        tokensInput: usage.inputTokens,
        tokensOutput: usage.outputTokens,
      });

      return {
        status: 'ok',
        transcript_id: detail.transcript_id,
        action_items_written: createdPageIds.length,
        mentions_written: mentionsWritten,
        mentions_published: mentionsPublished,
        summary: extract.summary,
        degraded,
      };
    } catch (err) {
      await updateAgentRun(runId, {
        status: 'error',
        errorMessage: String(err),
      });
      throw err;
    }
  } finally {
    await langfuseFlush();
  }
});

/** Test-only helper to reset the module-scope Notion client. */
export function __resetForTests(): void {
  notion = null;
}
