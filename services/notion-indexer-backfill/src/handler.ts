/**
 * notion-indexer-backfill — D-10 one-shot full-scan loader.
 *
 * Queries the watched DB WITHOUT a last_edited_time filter, paginates 100
 * per page with a 350 ms leaky-bucket sleep between Notion requests (Notion
 * rate limit is 3 req/s per integration), and routes each page through the
 * same upsert helpers as the steady-state indexer. On a second run, every
 * page's stored `notion_last_edited_time` will match and rows_inserted = 0.
 *
 * Event: { dbId, dbKind } — same shape as the indexer.
 * Returns: { dbId, dbKind, rows_seen, rows_inserted, rows_updated, rows_skipped }
 *
 * Phase 1 caveat (documented in SUMMARY): this Lambda still uses password
 * auth via RDS_SECRET_ARN. Migrating to IAM auth (parity with the steady-state
 * indexer) lands in Phase 2 once the backfill is no longer the fast path.
 */

import { Client as NotionClient } from '@notionhq/client';
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  upsertEntity,
  upsertProject,
  upsertKevinContextSection,
  type DbExec,
} from '../../notion-indexer/src/upsert.js';

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const NOTION_TOKEN_SECRET_ARN = process.env.NOTION_TOKEN_SECRET_ARN;
const RDS_ENDPOINT = process.env.RDS_ENDPOINT;
const RDS_USER = process.env.RDS_USER ?? 'kos_admin';
const RDS_DATABASE = process.env.RDS_DATABASE ?? 'kos';
const RDS_PORT = Number(process.env.RDS_PORT ?? 5432);

let cachedToken: string | null = null;
let cachedPool: Pool | null = null;
let smClient: SecretsManagerClient | null = null;

async function getNotionToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (!NOTION_TOKEN_SECRET_ARN) throw new Error('NOTION_TOKEN_SECRET_ARN not set');
  smClient ??= new SecretsManagerClient({ region: REGION });
  const out = await smClient.send(new GetSecretValueCommand({ SecretId: NOTION_TOKEN_SECRET_ARN }));
  if (!out.SecretString) throw new Error('Notion token secret is empty');
  cachedToken = out.SecretString.trim();
  return cachedToken;
}

async function getPool(): Promise<Pool> {
  if (cachedPool) return cachedPool;
  if (!RDS_ENDPOINT) throw new Error('RDS_ENDPOINT not set');
  const signer = new Signer({
    hostname: RDS_ENDPOINT,
    port: RDS_PORT,
    username: RDS_USER,
    region: REGION,
  });
  cachedPool = new Pool({
    host: RDS_ENDPOINT,
    port: RDS_PORT,
    user: RDS_USER,
    password: async () => signer.getAuthToken(),
    database: RDS_DATABASE,
    ssl: { rejectUnauthorized: true },
    max: 2,
  });
  return cachedPool;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type BackfillEvent = {
  dbId: string;
  dbKind: 'entities' | 'projects' | 'kevin_context' | 'command_center';
};

export type BackfillResult = {
  dbId: string;
  dbKind: string;
  rows_seen: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
};

export async function runBackfill(
  event: BackfillEvent,
  deps: { notion?: any; db?: DbExec } = {},
): Promise<BackfillResult> {
  const notion: any = deps.notion ?? new NotionClient({ auth: await getNotionToken() });
  const db: DbExec = deps.db ?? (await getPool());

  const stats: BackfillResult = {
    dbId: event.dbId,
    dbKind: event.dbKind,
    rows_seen: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_skipped: 0,
  };

  let startCursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: event.dbId,
      page_size: 100,
      start_cursor: startCursor,
    });

    for (const page of res.results ?? []) {
      stats.rows_seen += 1;
      let outcome;
      if (event.dbKind === 'entities') outcome = await upsertEntity(db, page);
      else if (event.dbKind === 'projects') outcome = await upsertProject(db, page);
      else if (event.dbKind === 'kevin_context') {
        // For backfill we treat the Kevin Context page itself as the unit;
        // its section blocks are walked by the steady-state indexer on first
        // poll. Record a skip for consistency with the indexer's accounting.
        outcome = await upsertKevinContextSection(
          db,
          page.id,
          'BACKFILL-PLACEHOLDER',
          '',
          page.last_edited_time,
        );
      } else {
        // command_center: no steady-state processing yet in Phase 1.
        outcome = { action: 'skipped' as const };
      }
      if (outcome.action === 'inserted') stats.rows_inserted += 1;
      else if (outcome.action === 'updated') stats.rows_updated += 1;
      else stats.rows_skipped += 1;
    }

    startCursor = res.next_cursor ?? undefined;
    if (startCursor) await sleep(350); // leaky bucket — Notion rate limit 3 req/s
  } while (startCursor);

  return stats;
}

export const handler = async (event: BackfillEvent): Promise<BackfillResult> => runBackfill(event);
