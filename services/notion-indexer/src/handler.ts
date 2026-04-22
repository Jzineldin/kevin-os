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
import {
  upsertEntity,
  upsertProject,
  upsertKevinContextSection,
  handleArchivedOrMissing,
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
  dbKind: 'entities' | 'projects' | 'kevin_context' | 'command_center';
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
          } else if (event.dbKind === 'kevin_context') {
            // For kevin_context, indexer walks the *page* to find heading_2 +
            // following paragraph pairs and upserts each as a section row.
            outcome = await indexKevinContextPage(db, notion, page);
          } else {
            // command_center: Phase 2+ takes over full processing. For now we
            // record the observation so dashboards can count pages.
            await db.query(
              `INSERT INTO event_log (kind, detail)
               VALUES ('notion-indexed-other',
                       jsonb_build_object('notion_page_id', $1::text, 'kind', $2::text))`,
              [page.id, event.dbKind],
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

export const handler = async (event: IndexerEvent): Promise<IndexerResult> => {
  return runIndexer(event);
};
