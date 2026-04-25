/**
 * @kos/service-granola-poller — CAP-08 + AUTO-05 (Phase 6 Plan 06-01).
 *
 * Every 15 min (EventBridge Scheduler, Europe/Stockholm), polls the Notion
 * `Transkripten` DB with a `last_edited_time` filter and emits one
 * `transcript.available` event per new transcript to the `kos.capture`
 * EventBridge bus. Idempotent on `transcript_id` (Notion page id) via
 * `agent_runs` rows so retries / manual re-invocations never double-publish.
 *
 * Cursor advance per RESEARCH §6: pass `max(last_edited_time) - 1 minute`
 * to handle Notion's minute-granularity boundary races.
 *
 * Files (Plan 06-01 split):
 *   - notion.ts   — DB id resolution, paginated query, page content reader
 *   - cursor.ts   — notion_indexer_cursor accessor for db_kind='transkripten'
 *   - persist.ts  — RDS pool, agent_runs helpers, PutEvents
 *   - handler.ts  — orchestration (this file)
 *
 * Conventions (D-28):
 *   - initSentry + setupOtelTracingAsync at cold start
 *   - tagTraceWithCaptureId(transcript_id) per page so Langfuse groups every
 *     downstream Bedrock call by transcript
 *   - flush() in finally so Lambda return doesn't lose tail spans
 */
import { Client as NotionClient } from '@notionhq/client';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { TranscriptAvailableSchema } from '@kos/contracts/context';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { setupOtelTracingAsync, flush as langfuseFlush, tagTraceWithCaptureId } from '../../_shared/tracing.js';
import {
  getTranskriptenDbId,
  queryTranskriptenSince,
  readPageContent,
} from './notion.js';
import { getCursor, advanceCursor } from './cursor.js';
import {
  getPool,
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  publishTranscriptAvailable,
} from './persist.js';

// AWS_REGION default for tests + local invocation. Lambda always sets this.
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

let notion: NotionClient | null = null;

async function getNotion(): Promise<NotionClient> {
  if (notion) return notion;
  // Two paths: secret ARN (Lambda) or literal NOTION_TOKEN (local tests).
  const arn = process.env.NOTION_TOKEN_SECRET_ARN;
  let token = process.env.NOTION_TOKEN;
  if (!token && arn) {
    const sm = new SecretsManagerClient({});
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    token = r.SecretString;
  }
  if (!token) {
    throw new Error('NOTION_TOKEN_SECRET_ARN or NOTION_TOKEN must be set');
  }
  notion = new NotionClient({ auth: token });
  return notion;
}

export interface PollerResult {
  processed: number;
  skipped: number;
  errors: number;
  since: string;
  advancedTo: string | null;
}

export const handler = wrapHandler(async (_event: unknown): Promise<PollerResult> => {
  await initSentry();
  await setupOtelTracingAsync();

  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  const notionClient = await getNotion();
  const pool = await getPool();

  const dbId = await getTranskriptenDbId();
  const cursor = await getCursor(pool, ownerId);
  const since = cursor.lastCursorAt;

  let processed = 0;
  let skipped = 0;
  let errorCount = 0;
  let maxLastEdited = since;

  try {
    for await (const page of queryTranskriptenSince(notionClient, dbId, since)) {
      const transcriptId = page.id;
      tagTraceWithCaptureId(transcriptId);

      // D-03: agent_runs idempotency on transcript_id.
      if (await findPriorOkRun(transcriptId, 'granola-poller', ownerId)) {
        skipped++;
        continue;
      }

      const runId = await insertAgentRun({
        ownerId,
        captureId: transcriptId,
        agentName: 'granola-poller',
        status: 'started',
      });

      try {
        const content = await readPageContent(notionClient, transcriptId);
        // Validate the detail against the Phase 6 shipped TranscriptAvailable
        // contract. raw_length is the canonical body-size signal; the actual
        // transcript text is hydrated by transcript-extractor (Plan 06-02)
        // via a second Notion read so the EventBridge envelope stays small.
        const detail = TranscriptAvailableSchema.parse({
          capture_id: transcriptId,
          owner_id: ownerId,
          transcript_id: transcriptId,
          notion_page_id: transcriptId,
          title: content.title,
          source: 'granola' as const,
          last_edited_time: page.last_edited_time,
          raw_length: content.raw_length,
        });

        await publishTranscriptAvailable(detail);
        await updateAgentRun(runId, {
          status: 'ok',
          outputJson: {
            title: content.title,
            raw_length: content.raw_length,
            attendees_n: content.attendees.length,
            recorded_at: content.recorded_at.toISOString(),
            notion_url: content.notion_url,
          },
        });
        processed++;
        const pageEdited = new Date(page.last_edited_time);
        if (pageEdited > maxLastEdited) maxLastEdited = pageEdited;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateAgentRun(runId, { status: 'error', errorMessage: msg });
        errorCount++;
      }
    }

    // Cursor advance only if at least one transcript was processed in this
    // run. RESEARCH §6 caveat 1: subtract 1 minute from max(last_edited_time)
    // to avoid losing transcripts edited at the same minute boundary.
    if (processed > 0) {
      const cursorAdvance = new Date(maxLastEdited.getTime() - 60_000);
      await advanceCursor(pool, ownerId, cursorAdvance);
    }
  } finally {
    await langfuseFlush();
  }

  return {
    processed,
    skipped,
    errors: errorCount,
    since: since.toISOString(),
    advancedTo:
      processed > 0 ? new Date(maxLastEdited.getTime() - 60_000).toISOString() : null,
  };
});
