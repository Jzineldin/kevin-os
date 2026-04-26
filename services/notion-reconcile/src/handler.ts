/**
 * notion-reconcile — weekly Sun 04:00 Europe/Stockholm hard-delete detector.
 *
 * T-01-INDEX-02 mitigation. Notion's databases.query excludes hard-deleted
 * pages, so the 5-min poller cannot see them. This Lambda full-scans every
 * watched DB, diffs against RDS entity_index / project_index, and for any
 * row missing from Notion writes `event_log kind='notion-hard-delete'` +
 * publishes a `kos.system` EventBridge event so dashboards can surface it.
 *
 * Never mutates entity_index / project_index — archive-not-delete (D-09).
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

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const NOTION_TOKEN_SECRET_ARN = process.env.NOTION_TOKEN_SECRET_ARN;
const RDS_ENDPOINT = process.env.RDS_ENDPOINT;
const SYSTEM_BUS_NAME = process.env.SYSTEM_BUS_NAME;
const RDS_USER = process.env.RDS_USER ?? 'kos_admin';
const RDS_DATABASE = process.env.RDS_DATABASE ?? 'kos';
const RDS_PORT = Number(process.env.RDS_PORT ?? 5432);

// Notion DB IDs come in via env (wired by CDK from scripts/.notion-db-ids.json).
const WATCHED = [
  { key: 'entities', envVar: 'NOTION_ENTITIES_DB_ID', table: 'entity_index' },
  { key: 'projects', envVar: 'NOTION_PROJECTS_DB_ID', table: 'project_index' },
  { key: 'kevin_context', envVar: 'NOTION_KEVIN_CONTEXT_PAGE_ID', table: 'kevin_context' },
  { key: 'command_center', envVar: 'NOTION_COMMAND_CENTER_DB_ID', table: null },
] as const;

let cachedToken: string | null = null;
let cachedPool: Pool | null = null;
let smClient: SecretsManagerClient | null = null;
let ebClient: EventBridgeClient | null = null;

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

async function collectAllNotionPageIds(notion: any, dbId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let startCursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: dbId,
      page_size: 100,
      start_cursor: startCursor,
    });
    for (const p of res.results ?? []) ids.add(p.id);
    startCursor = res.next_cursor ?? undefined;
  } while (startCursor);
  return ids;
}

export type ReconcileResult = {
  hardDeletesDetected: number;
  perTable: Record<string, number>;
};

export async function runReconcile(
  deps: {
    notion?: any;
    pool?: Pool;
    putEvents?: (entries: PutEventsRequestEntry[]) => Promise<void>;
  } = {},
): Promise<ReconcileResult> {
  const notion: any = deps.notion ?? new NotionClient({ auth: await getNotionToken() });
  const pool = deps.pool ?? (await getPool());
  const putEvents =
    deps.putEvents ??
    (async (entries: PutEventsRequestEntry[]) => {
      if (entries.length === 0) return;
      ebClient ??= new EventBridgeClient({ region: REGION });
      await ebClient.send(new PutEventsCommand({ Entries: entries }));
    });

  const stats: ReconcileResult = { hardDeletesDetected: 0, perTable: {} };

  for (const w of WATCHED) {
    if (w.table === null) continue; // command_center full processing is Phase 2+
    const dbId = process.env[w.envVar];
    if (!dbId) continue;

    const notionIds = await collectAllNotionPageIds(notion, dbId);
    const rdsRows = await pool.query<{ notion_page_id: string }>(
      `SELECT notion_page_id FROM ${w.table}`,
    );

    const missing: string[] = [];
    for (const row of rdsRows.rows) {
      if (!notionIds.has(row.notion_page_id)) missing.push(row.notion_page_id);
    }

    for (const pid of missing) {
      await pool.query(
        `INSERT INTO event_log (kind, detail)
         VALUES ('notion-hard-delete',
                 jsonb_build_object('notion_page_id', $1::text, 'kind', $2::text, 'detected_at', now()))`,
        [pid, w.key],
      );
    }

    if (SYSTEM_BUS_NAME && missing.length > 0) {
      const entries: PutEventsRequestEntry[] = missing.map((pid) => ({
        EventBusName: SYSTEM_BUS_NAME,
        Source: 'kos.notion-reconcile',
        DetailType: 'notion-hard-delete-detected',
        Detail: JSON.stringify({ notionPageId: pid, dbKind: w.key }),
      }));
      for (let i = 0; i < entries.length; i += 10) await putEvents(entries.slice(i, i + 10));
    }

    stats.perTable[w.key] = missing.length;
    stats.hardDeletesDetected += missing.length;
  }

  return stats;
}

export const handler = async (): Promise<ReconcileResult> => runReconcile();
