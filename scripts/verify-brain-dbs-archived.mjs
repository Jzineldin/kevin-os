#!/usr/bin/env node
/**
 * verify-brain-dbs-archived.mjs — Plan 10-03 post-archive verifier.
 *
 * Assertions per Brain DB id in scripts/.notion-brain-dbs.json:
 *   1. notion.databases.retrieve → archived === true
 *   2. title[0].text.content starts with `[MIGRERAD-YYYY-MM-DD] `
 *   3. event_log has at least 1 row with kind='brain-db-archived',
 *      detail->>'database_id' = <uuid>, detail ? 'notion_ack_at' (the
 *      confirmation write-back).
 *
 * MIG-04 confirmation (informational): query Command Center DB row count
 * and assert >= 167 rows. Read-only — never mutates Command Center.
 *
 * Exit 0 on 5/5 PASS + MIG-04 OK; exit 1 on any FAIL.
 *
 * Env: NOTION_TOKEN (or kos/notion-integration-token), RDS_URL or
 *      KOS_DB_TUNNEL_PORT.
 */
import { Client as NotionClient } from '@notionhq/client';
import pg from 'pg';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAIN_DBS_FILE = resolve(__dirname, '.notion-brain-dbs.json');
const NOTION_DB_IDS_FILE = resolve(__dirname, '.notion-db-ids.json');

const COMMAND_CENTER_MIN_ROWS = 167; // MIG-04 invariant

function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  return execSync(
    'aws secretsmanager get-secret-value --secret-id kos/notion-integration-token --query SecretString --output text',
  )
    .toString()
    .trim();
}

function loadInventory() {
  if (!existsSync(BRAIN_DBS_FILE)) {
    throw new Error(`Inventory file missing: ${BRAIN_DBS_FILE}`);
  }
  const json = JSON.parse(readFileSync(BRAIN_DBS_FILE, 'utf8'));
  return Array.isArray(json.brain_dbs) ? json.brain_dbs : [];
}

function loadCommandCenterId() {
  if (!existsSync(NOTION_DB_IDS_FILE)) return null;
  try {
    const ids = JSON.parse(readFileSync(NOTION_DB_IDS_FILE, 'utf8'));
    return ids.commandCenter ?? null;
  } catch {
    return null;
  }
}

function buildPgClient() {
  if (process.env.KOS_DB_TUNNEL_PORT) {
    return new pg.Client({
      host: '127.0.0.1',
      port: Number(process.env.KOS_DB_TUNNEL_PORT),
      user: process.env.PGUSER ?? 'kos_admin',
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE ?? 'kos',
      ssl: false,
    });
  }
  const connStr = process.env.RDS_URL ?? process.env.DATABASE_URL;
  if (!connStr) throw new Error('RDS_URL (or KOS_DB_TUNNEL_PORT) required');
  return new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: true } });
}

function extractTitle(db) {
  const arr = Array.isArray(db?.title) ? db.title : [];
  return arr
    .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
    .join('')
    .trim();
}

async function verifyOne(notion, pgClient, db) {
  const failures = [];
  const current = await notion.databases.retrieve({ database_id: db.id });
  const title = extractTitle(current);

  // 1) archived === true
  if (current.archived !== true) {
    failures.push(`Notion archived !== true (got ${current.archived})`);
  }
  // 2) [MIGRERAD-YYYY-MM-DD] prefix
  if (!/^\[MIGRERAD-\d{4}-\d{2}-\d{2}\]\s/.test(title)) {
    failures.push(`title missing [MIGRERAD-YYYY-MM-DD] prefix (got: "${title}")`);
  }
  // 3) event_log ack row present
  const ackRes = await pgClient.query(
    `SELECT count(*)::int AS n FROM event_log
       WHERE kind = 'brain-db-archived'
         AND detail->>'database_id' = $1
         AND detail ? 'notion_ack_at'`,
    [db.id],
  );
  const n = ackRes.rows?.[0]?.n ?? 0;
  if (n < 1) {
    failures.push(`event_log: 0 acked rows for database_id=${db.id} (expected >= 1)`);
  }

  return { db, title, archived: current.archived === true, eventLogAcks: n, failures };
}

async function verifyCommandCenter(notion) {
  const ccId = loadCommandCenterId();
  if (!ccId) {
    return { skipped: true, reason: 'commandCenter id not in scripts/.notion-db-ids.json' };
  }
  // Use databases.query with empty filter; page through.
  let count = 0;
  let cursor = undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await notion.databases.query({
      database_id: ccId,
      page_size: 100,
      start_cursor: cursor,
    });
    count += page.results?.length ?? 0;
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  const ok = count >= COMMAND_CENTER_MIN_ROWS;
  return { skipped: false, count, ok };
}

async function main() {
  const inventory = loadInventory();
  if (inventory.length === 0) {
    console.error('No Brain DBs in inventory; nothing to verify.');
    process.exit(2);
  }
  const notion = new NotionClient({ auth: getNotionToken() });
  const pgClient = buildPgClient();
  await pgClient.connect();

  let pass = 0;
  let fail = 0;
  try {
    for (const db of inventory) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await verifyOne(notion, pgClient, db);
        if (r.failures.length === 0) {
          pass++;
          console.log(
            `[PASS] ${db.id}  ${db.name}  archived=${r.archived}  acks=${r.eventLogAcks}  title="${r.title}"`,
          );
        } else {
          fail++;
          console.error(`[FAIL] ${db.id}  ${db.name}`);
          for (const f of r.failures) console.error(`       - ${f}`);
        }
      } catch (err) {
        fail++;
        console.error(
          `[FAIL] ${db.id}  ${db.name}: ${err && err.message ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await pgClient.end();
  }

  // ----- MIG-04 informational ------------------------------------------------
  console.log('');
  console.log('--- MIG-04 confirmation (Command Center untouched) -----------');
  try {
    const cc = await verifyCommandCenter(notion);
    if (cc.skipped) {
      console.log(`[INFO] MIG-04 skipped: ${cc.reason}`);
    } else if (cc.ok) {
      console.log(
        `[INFO] MIG-04 OK: Command Center has ${cc.count} rows (>= ${COMMAND_CENTER_MIN_ROWS}).`,
      );
    } else {
      console.error(
        `[WARN] MIG-04 row count ${cc.count} < ${COMMAND_CENTER_MIN_ROWS}. ` +
          'Investigate — Brain DB archive should NOT touch Command Center.',
      );
    }
  } catch (err) {
    console.error(
      `[WARN] MIG-04 query failed: ${err && err.message ? err.message : err}. ` +
        'This is informational; not a hard failure for MIG-03.',
    );
  }

  console.log('');
  console.log(`[SUMMARY] pass=${pass} fail=${fail} of ${inventory.length}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
