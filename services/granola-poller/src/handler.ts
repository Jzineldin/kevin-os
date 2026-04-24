/**
 * @kos/service-granola-poller — CAP-08 + AUTO-05 (Phase 6).
 *
 * Every 15 min (EventBridge Scheduler, Europe/Stockholm), polls the Notion
 * `Transkripten` DB with a `last_edited_time > last_cursor` filter. Emits
 * `transcript.available` events to `kos.capture` for each new transcript —
 * consumed by `services/transcript-extractor`.
 *
 * Cursor persistence: `notion_indexer_cursor` table, keyed by
 * `db_name = 'transkripten'` (reuse existing infra).
 *
 * Idempotency: `capture_id = ulid()` per poll; per-transcript dedup via
 * `transcript.available` consumer's `transcript_id = page.id`.
 *
 * Spec: .planning/phases/06-granola-semantic-memory/06-01-PLAN.md
 */
import { Client as NotionClient } from '@notionhq/client';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ulid } from 'ulid';
import type { Pool as PgPool } from 'pg';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { TranscriptAvailableSchema } from '@kos/contracts/context';
import { getPool } from './db.js';

const OWNER_ID = process.env.KOS_OWNER_ID ?? '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const CURSOR_DB_NAME = 'transkripten';
const SOURCE = 'kos.capture';
const DETAIL_TYPE = 'transcript.available';
const MAX_PAGES_PER_RUN = 20;

let notion: NotionClient | null = null;
let ebClient: EventBridgeClient | null = null;

async function getNotion(): Promise<NotionClient> {
  if (notion) return notion;
  const arn = process.env.NOTION_TOKEN_SECRET_ARN;
  if (!arn) throw new Error('NOTION_TOKEN_SECRET_ARN env var not set');
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const token = res.SecretString;
  if (!token) throw new Error('Notion token secret is empty');
  notion = new NotionClient({ auth: token });
  return notion;
}

function getEventBridge(): EventBridgeClient {
  if (!ebClient) ebClient = new EventBridgeClient({});
  return ebClient;
}

export const handler = wrapHandler(async (): Promise<{
  polled: number;
  emitted: number;
  cursor: string | null;
}> => {
  await initSentry();
  const capture_id = `granola-poll-${ulid()}`;
  tagTraceWithCaptureId(capture_id);

  const transkriptenDbId = process.env.NOTION_TRANSKRIPTEN_DB_ID;
  if (!transkriptenDbId) {
    throw new Error('NOTION_TRANSKRIPTEN_DB_ID env var not set');
  }
  const eventBusName = process.env.KOS_CAPTURE_BUS_NAME;
  if (!eventBusName) throw new Error('KOS_CAPTURE_BUS_NAME env var not set');

  const pool = await getPool();
  const notionClient = await getNotion();

  // 1. Read cursor from notion_indexer_cursor (reuses Phase 1 table).
  const cursor = await readCursor(pool);

  // 2. Query Transkripten DB with last_edited_time filter + overlap.
  const response = await notionClient.databases.query({
    database_id: transkriptenDbId,
    page_size: MAX_PAGES_PER_RUN,
    sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    ...(cursor
      ? {
          filter: {
            timestamp: 'last_edited_time',
            last_edited_time: { on_or_after: cursor },
          },
        }
      : {}),
  });

  // 3. Emit transcript.available for each new page.
  let emitted = 0;
  let maxEdited: string | null = cursor;
  for (const page of response.results) {
    if (!('last_edited_time' in page)) continue;
    const lastEdited = (page as { last_edited_time: string }).last_edited_time;

    const detail = TranscriptAvailableSchema.parse({
      capture_id: ulid(),
      owner_id: OWNER_ID,
      transcript_id: page.id,
      notion_page_id: page.id,
      title: extractTitle(page),
      source: 'granola' as const,
      last_edited_time: lastEdited,
      raw_length: 0, // transcript-extractor hydrates actual body
    });

    await getEventBridge().send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: eventBusName,
            Source: SOURCE,
            DetailType: DETAIL_TYPE,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
    emitted++;
    if (!maxEdited || lastEdited > maxEdited) maxEdited = lastEdited;
  }

  // 4. Advance cursor only if we fully drained (not truncated by page_size).
  if (!response.has_more && maxEdited) {
    await writeCursor(pool, maxEdited);
  }

  return {
    polled: response.results.length,
    emitted,
    cursor: maxEdited,
  };
});

// ---------------------------------------------------------------------------

async function readCursor(pool: PgPool): Promise<string | null> {
  const { rows } = await pool.query<{ last_edited_time: string | null }>(
    `SELECT last_edited_time FROM notion_indexer_cursor WHERE db_name = $1 AND owner_id = $2`,
    [CURSOR_DB_NAME, OWNER_ID],
  );
  return rows[0]?.last_edited_time ?? null;
}

async function writeCursor(pool: PgPool, isoTime: string): Promise<void> {
  await pool.query(
    `INSERT INTO notion_indexer_cursor (db_name, owner_id, last_edited_time, updated_at)
         VALUES ($1, $2, $3::timestamptz, now())
     ON CONFLICT (db_name, owner_id) DO UPDATE
        SET last_edited_time = EXCLUDED.last_edited_time,
            updated_at       = now()`,
    [CURSOR_DB_NAME, OWNER_ID, isoTime],
  );
}

function extractTitle(page: unknown): string | null {
  // Notion page title extraction — schema-agnostic best-effort.
  const props = (page as { properties?: Record<string, unknown> }).properties;
  if (!props) return null;
  for (const val of Object.values(props)) {
    const v = val as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v?.type === 'title' && Array.isArray(v.title)) {
      return v.title.map((t) => t.plain_text ?? '').join('') || null;
    }
  }
  return null;
}
