/**
 * notion-indexer Lambda handler — D-08 steady-state 5-min poller.
 *
 * Invoked by EventBridge Scheduler (Europe/Stockholm, rate(5 minutes)) with
 * `{ dbId, dbKind }` payload per watched DB (D-11: entities, projects,
 * kevin_context, command_center).
 *
 * Auth path: IAM auth to RDS Proxy via @aws-sdk/rds-signer (T-01-PROXY-01).
 *  - NOTION_TOKEN_SECRET_ARN   → NOTION token pulled once per cold start
 *  - RDS_ENDPOINT              → RDS Proxy endpoint (iamAuth: true)
 *  - RDS_CA_BUNDLE (optional)  → RDS CA PEM; if absent, TLS still enforced
 *                                via rejectUnauthorized=true (AWS default CA)
 *  - CAPTURE_BUS_NAME          → EventBridge bus for `notion-write-confirmed`
 *
 * Overlap math: Notion clock skew (Pitfall 3) — every query looks back
 * `2 * 60 * 1000` ms past the stored cursor. Idempotent upserts absorb the
 * duplicate work.
 */

import { Client as NotionClient } from '@notionhq/client';
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from '@aws-sdk/client-eventbridge';
import { ulid } from 'ulid';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import {
  upsertEntity,
  upsertProject,
  upsertKevinContextSection,
  handleArchivedOrMissing,
  processKosInboxBatch,
  type DbExec,
} from './upsert.js';

// --- Config -----------------------------------------------------------------

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const NOTION_TOKEN_SECRET_ARN = process.env.NOTION_TOKEN_SECRET_ARN;
const RDS_ENDPOINT = process.env.RDS_ENDPOINT;
const CAPTURE_BUS_NAME = process.env.CAPTURE_BUS_NAME;
// RDS user mapped to the Lambda's IAM role via RDS DB authentication.
const RDS_USER = process.env.RDS_USER ?? 'kos_admin';
const RDS_DATABASE = process.env.RDS_DATABASE ?? 'kos';
const RDS_PORT = Number(process.env.RDS_PORT ?? 5432);

// --- Module-scope caches (survive warm-start invocations) -------------------

let cachedNotionToken: string | null = null;
let cachedPool: Pool | null = null;
let secretsClient: SecretsManagerClient | null = null;
let ebClient: EventBridgeClient | null = null;

function getSecretsClient(): SecretsManagerClient {
  if (!secretsClient) secretsClient = new SecretsManagerClient({ region: REGION });
  return secretsClient;
}

function getEbClient(): EventBridgeClient {
  if (!ebClient) ebClient = new EventBridgeClient({ region: REGION });
  return ebClient;
}

async function getNotionToken(): Promise<string> {
  if (cachedNotionToken) return cachedNotionToken;
  if (!NOTION_TOKEN_SECRET_ARN) throw new Error('NOTION_TOKEN_SECRET_ARN not set');
  const out = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: NOTION_TOKEN_SECRET_ARN }),
  );
  if (!out.SecretString) throw new Error('Notion token secret is empty');
  cachedNotionToken = out.SecretString.trim();
  return cachedNotionToken;
}

/**
 * Build a pg Pool backed by IAM auth tokens (RDS Proxy).
 * T-01-PROXY-01: the Proxy SG is open, but only an IAM-signed token is a
 * valid credential. No password path.
 */
async function getPool(): Promise<Pool> {
  if (cachedPool) return cachedPool;
  if (!RDS_ENDPOINT) throw new Error('RDS_ENDPOINT not set');

  const signer = new Signer({
    hostname: RDS_ENDPOINT,
    port: RDS_PORT,
    username: RDS_USER,
    region: REGION,
  });
  const token = await signer.getAuthToken();

  cachedPool = new Pool({
    host: RDS_ENDPOINT,
    port: RDS_PORT,
    user: RDS_USER,
    password: token,
    database: RDS_DATABASE,
    ssl: { rejectUnauthorized: true },
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  return cachedPool;
}

// --- Handler ----------------------------------------------------------------

export type IndexerEvent = {
  dbId: string;
  dbKind: 'entities' | 'projects' | 'kevin_context' | 'command_center' | 'kos_inbox';
  /**
   * Plan 02-07 alias: CDK schedule for KOS Inbox emits `dbName: 'kosInbox'`
   * alongside `dbKind: 'kos_inbox'`. Both are honoured (kosInbox name is the
   * operator-friendly key matching scripts/.notion-db-ids.json).
   */
  dbName?: string;
};

export type IndexerResult = {
  dbId: string;
  dbKind: string;
  pagesSeen: number;
  inserted: number;
  updated: number;
  skipped: number;
  hardDeletesLogged: number;
  cursorAdvancedTo: string | null;
};

// For dependency injection in tests — production code uses the real clients.
export interface Deps {
  notion?: { databases: { query: Function }; pages: { retrieve: Function }; blocks: { children: { list: Function } } };
  db?: DbExec;
  putEvents?: (entries: PutEventsRequestEntry[]) => Promise<void>;
}

export async function runIndexer(event: IndexerEvent, deps: Deps = {}): Promise<IndexerResult> {
  const notion: any =
    deps.notion ?? new NotionClient({ auth: await getNotionToken() });
  const pool = deps.db ?? (await getPool());
  const db: DbExec = pool;
  const putEvents =
    deps.putEvents ??
    (async (entries: PutEventsRequestEntry[]) => {
      if (entries.length === 0) return;
      await getEbClient().send(new PutEventsCommand({ Entries: entries }));
    });

  // Cursor lookup --------------------------------------------------------------
  const cursorRes = await db.query(
    'SELECT last_cursor_at FROM notion_indexer_cursor WHERE db_id = $1',
    [event.dbId],
  );
  const lastCursor: Date =
    cursorRes.rows.length > 0 ? new Date(cursorRes.rows[0].last_cursor_at) : new Date(0);

  // D-08: 2-minute overlap to absorb Notion clock skew.
  const overlapFrom = new Date(Math.max(lastCursor.getTime() - 2 * 60 * 1000, 0));

  // --- Plan 02-07: KOS Inbox dispatch (kosInbox / kos_inbox) ----------------
  // The KOS Inbox poll is batch-oriented (returns counters, not per-page upsert
  // outcomes), so it lives in its own short-circuit branch. Cursor advanced
  // after the batch completes successfully — same Phase 1 pattern.
  if (event.dbKind === 'kos_inbox' || event.dbName === 'kosInbox') {
    const entitiesDbId = process.env.NOTION_ENTITIES_DB_ID;
    if (!entitiesDbId) {
      throw new Error(
        'NOTION_ENTITIES_DB_ID env var missing — required for KOS Inbox Approve→create-or-reuse Entities-DB page (Plan 02-07)',
      );
    }
    return runKosInboxIndexer({
      event,
      db,
      notion,
      overlapFrom,
      entitiesDbId,
    });
  }

  const stats: IndexerResult = {
    dbId: event.dbId,
    dbKind: event.dbKind,
    pagesSeen: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    hardDeletesLogged: 0,
    cursorAdvancedTo: null,
  };

  let maxSeenEditedAt = lastCursor;
  let startCursor: string | undefined;
  const pendingEvents: PutEventsRequestEntry[] = [];

  // kevin_context's dbId is a PAGE id (not a database). databases.query would
  // 400 with "Provided ID ... is a page, not a database". Bypass the
  // database-query loop entirely and walk the single page via
  // indexKevinContextPage which uses the blocks API.
  if (event.dbKind === 'kevin_context') {
    try {
      const page: any = await notion.pages.retrieve({ page_id: event.dbId });
      stats.pagesSeen = 1;
      const editedAt = new Date(page.last_edited_time);
      maxSeenEditedAt = editedAt;
      const outcome = await indexKevinContextPage(db, notion, page);
      if (outcome.action === 'inserted') stats.inserted += 1;
      else if (outcome.action === 'updated') stats.updated += 1;
      else if (outcome.action === 'skipped') stats.skipped += 1;
      stats.cursorAdvancedTo = maxSeenEditedAt.toISOString();
      await db.query(
        `INSERT INTO notion_indexer_cursor (db_id, db_kind, last_cursor_at, last_run_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (db_id) DO UPDATE SET
           last_cursor_at = GREATEST(EXCLUDED.last_cursor_at, notion_indexer_cursor.last_cursor_at),
           db_kind = EXCLUDED.db_kind,
           last_run_at = now()`,
        [event.dbId, event.dbKind, maxSeenEditedAt],
      );
    } catch (err) {
      console.error('[notion-indexer] kevin_context page retrieve failed', err);
      throw err;
    }
    return stats;
  }

  try {
    do {
      const res: any = await notion.databases.query({
        database_id: event.dbId,
        filter: {
          timestamp: 'last_edited_time',
          last_edited_time: { after: overlapFrom.toISOString() },
        },
        sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        start_cursor: startCursor,
        page_size: 100,
      });

      for (const page of res.results ?? []) {
        stats.pagesSeen += 1;
        const editedAt = new Date(page.last_edited_time);
        if (editedAt.getTime() > maxSeenEditedAt.getTime()) maxSeenEditedAt = editedAt;

        let outcome;
        try {
          if (event.dbKind === 'entities') {
            outcome = await upsertEntity(db, page);
          } else if (event.dbKind === 'projects') {
            outcome = await upsertProject(db, page);
          } else {
            // kevin_context is handled in the page-retrieval branch above
            // (databases.query would 400 since the dbId is a page).
            // This branch handles command_center: Phase 2+ takes over full
            // processing. For now we record the observation so dashboards
            // can count pages.
            // command_center: Phase 2+ takes over full processing. For now we
            // record the observation so dashboards can count pages.
            await db.query(
              `INSERT INTO event_log (kind, detail, actor, owner_id)
               VALUES ('notion-indexed-other',
                       jsonb_build_object('notion_page_id', $1::text, 'kind', $2::text),
                       'notion-indexer',
                       $3::uuid)`,
              [
                page.id,
                event.dbKind,
                process.env.KEVIN_OWNER_ID ||
                  '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
              ],
            );
            outcome = { action: 'inserted' as const };
          }
        } catch (err) {
          outcome = await handleArchivedOrMissing(db, page.id, event.dbKind, err);
        }

        if (outcome.action === 'inserted') stats.inserted += 1;
        else if (outcome.action === 'updated') stats.updated += 1;
        else if (outcome.action === 'skipped') stats.skipped += 1;
        else if (outcome.action === 'hard-delete-logged') stats.hardDeletesLogged += 1;

        if (
          outcome.action === 'inserted' ||
          outcome.action === 'updated'
        ) {
          if (CAPTURE_BUS_NAME) {
            pendingEvents.push({
              EventBusName: CAPTURE_BUS_NAME,
              Source: 'kos.notion-indexer',
              DetailType: 'notion-write-confirmed',
              Detail: JSON.stringify({
                notionPageId: page.id,
                dbKind: event.dbKind,
                captureId: ulid(),
              }),
            });
          }
        }
      }

      startCursor = res.next_cursor ?? undefined;
    } while (startCursor);

    // Flush events in batches of 10 (EventBridge PutEvents limit).
    for (let i = 0; i < pendingEvents.length; i += 10) {
      await putEvents(pendingEvents.slice(i, i + 10));
    }

    // Advance cursor ONLY on full pagination success.
    await db.query(
      `INSERT INTO notion_indexer_cursor (db_id, db_kind, last_cursor_at, last_run_at, last_error)
       VALUES ($1, $2, $3, now(), NULL)
       ON CONFLICT (db_id) DO UPDATE SET
         last_cursor_at = GREATEST(EXCLUDED.last_cursor_at, notion_indexer_cursor.last_cursor_at),
         db_kind = EXCLUDED.db_kind,
         last_run_at = now(),
         last_error = NULL`,
      [event.dbId, event.dbKind, maxSeenEditedAt.toISOString()],
    );
    stats.cursorAdvancedTo = maxSeenEditedAt.toISOString();
    return stats;
  } catch (err) {
    // Do NOT advance cursor; persist the error for operator visibility.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.query(
        `UPDATE notion_indexer_cursor
            SET last_error = $1, last_run_at = now()
          WHERE db_id = $2`,
        [message.slice(0, 2000), event.dbId],
      );
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/**
 * Walk a Kevin Context Notion page's child blocks. We look for heading_2 blocks
 * and pair each with the immediately following paragraph as the section body.
 */
async function indexKevinContextPage(
  db: DbExec,
  notion: any,
  page: any,
): Promise<{ action: 'inserted' | 'updated' | 'skipped' }> {
  const lastEditedTime: string = page.last_edited_time;
  const children: any = await notion.blocks.children.list({
    block_id: page.id,
    page_size: 100,
  });
  const blocks: any[] = children.results ?? [];

  let lastAction: 'inserted' | 'updated' | 'skipped' = 'skipped';
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b?.type !== 'heading_2') continue;
    const heading = (b.heading_2?.rich_text ?? [])
      .map((t: any) => t?.plain_text ?? '')
      .join('')
      .trim();
    if (!heading) continue;

    // Gather all consecutive paragraph blocks as the section body.
    const bodyParts: string[] = [];
    for (let j = i + 1; j < blocks.length; j += 1) {
      const nb = blocks[j];
      if (nb?.type === 'heading_2') break;
      if (nb?.type === 'paragraph') {
        const txt = (nb.paragraph?.rich_text ?? [])
          .map((t: any) => t?.plain_text ?? '')
          .join('');
        if (txt) bodyParts.push(txt);
      }
    }
    const body = bodyParts.join('\n\n');

    const outcome = await upsertKevinContextSection(db, b.id, heading, body, lastEditedTime);
    if (outcome.action === 'inserted' || outcome.action === 'updated') {
      lastAction = outcome.action;
    }
  }
  return { action: lastAction };
}

/**
 * Plan 02-07: KOS Inbox poll branch.
 *
 * Queries the KOS Inbox DB for rows changed since the last cursor (with the
 * standard 2-min overlap), filtered to Status != Pending so we only see rows
 * Kevin has acted on. Each batch is processed via processKosInboxBatch:
 *   - Approved → create-or-reuse Entities page + flip Inbox to Merged
 *   - Rejected → archive (D-09 archive-not-delete) + event_log
 *   - Merged   → skip (already processed)
 *
 * Cursor advanced after the full pagination + batch completes successfully.
 */
async function runKosInboxIndexer(args: {
  event: IndexerEvent;
  db: DbExec;
  notion: any;
  overlapFrom: Date;
  entitiesDbId: string;
}): Promise<IndexerResult> {
  const { event, db, notion, overlapFrom, entitiesDbId } = args;
  const ownerId = process.env.KEVIN_OWNER_ID ?? '';

  const stats: IndexerResult = {
    dbId: event.dbId,
    dbKind: event.dbKind,
    pagesSeen: 0,
    inserted: 0, // approved → counted as inserted for symmetry with other branches
    updated: 0,
    skipped: 0,
    hardDeletesLogged: 0,
    cursorAdvancedTo: null,
  };

  let maxSeenEditedAt = new Date(Math.max(overlapFrom.getTime(), 0));
  let startCursor: string | undefined;
  const allRows: any[] = [];

  try {
    do {
      const res: any = await notion.databases.query({
        database_id: event.dbId,
        filter: {
          and: [
            {
              timestamp: 'last_edited_time',
              last_edited_time: { after: overlapFrom.toISOString() },
            },
            { property: 'Status', select: { does_not_equal: 'Pending' } },
          ],
        },
        sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        start_cursor: startCursor,
        page_size: 100,
      });

      for (const page of res.results ?? []) {
        stats.pagesSeen += 1;
        const editedAt = new Date(page.last_edited_time);
        if (editedAt.getTime() > maxSeenEditedAt.getTime()) maxSeenEditedAt = editedAt;
        allRows.push(page);
      }
      startCursor = res.next_cursor ?? undefined;
    } while (startCursor);

    const counters = await processKosInboxBatch({
      client: notion,
      db,
      rows: allRows,
      ownerId,
      entitiesDbId,
    });
    stats.inserted = counters.approved;
    stats.updated = counters.rejected; // 'updated' here means 'archived'; reused stat for parity
    stats.skipped = counters.skipped;

    // Advance cursor only after full batch success.
    await db.query(
      `INSERT INTO notion_indexer_cursor (db_id, db_kind, last_cursor_at, last_run_at, last_error)
       VALUES ($1, $2, $3, now(), NULL)
       ON CONFLICT (db_id) DO UPDATE SET
         last_cursor_at = GREATEST(EXCLUDED.last_cursor_at, notion_indexer_cursor.last_cursor_at),
         db_kind = EXCLUDED.db_kind,
         last_run_at = now(),
         last_error = NULL`,
      [event.dbId, event.dbKind, maxSeenEditedAt.toISOString()],
    );
    stats.cursorAdvancedTo = maxSeenEditedAt.toISOString();
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.query(
        `UPDATE notion_indexer_cursor
            SET last_error = $1, last_run_at = now()
          WHERE db_id = $2`,
        [message.slice(0, 2000), event.dbId],
      );
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

export const handler = wrapHandler(async (event: IndexerEvent): Promise<IndexerResult> => {
  await initSentry();
  // Synthetic capture_id keyed on dbName/dbKind + UTC minute so each run
  // shows up as its own session in Langfuse without exploding cardinality.
  const dbLabel = event.dbName ?? event.dbKind;
  const utcMinute = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  tagTraceWithCaptureId(`indexer-${dbLabel}-${utcMinute}`);
  return runIndexer(event);
});
