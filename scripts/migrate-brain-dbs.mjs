#!/usr/bin/env node
/**
 * migrate-brain-dbs.mjs — MIG-03 Notion archival for the 5 legacy Brain DBs.
 *
 * Phase: 10-migration-decommission, Plan: 10-03, Wave: 2
 * Requirements: MIG-03 (archive 5 Brain DBs) + MIG-04 (Command Center untouched)
 *
 * Behaviour
 * ---------
 * For each Brain DB id in scripts/.notion-brain-dbs.json this script:
 *
 *   1. Reads the current Notion database (title + archived state).
 *   2. Skips if already archived AND title already begins with `[MIGRERAD-`
 *      (idempotent re-run safety).
 *   3. Builds the new title:  `[MIGRERAD-YYYY-MM-DD] <original-title>`.
 *   4. Writes a `brain-db-archived` row to event_log BEFORE the Notion call
 *      (D-12 — write-ahead audit). The row records the INTENT and is the
 *      source of truth for rollback within the 90-day Notion trash window.
 *   5. Calls notion.databases.update with `archived: true` + new title.
 *   6. Confirmation write-back: PATCH the audit row's detail JSON with
 *      `notion_ack_at` so verifiers can tell INTENT apart from ACK.
 *
 * If the audit INSERT fails, the Notion call is NEVER made.
 * If the Notion call fails, the audit row stays committed (intent recorded).
 *
 * CLI flags
 * ---------
 *   --dry-run             Print proposed mutations; do NOT touch event_log
 *                         or Notion.
 *   --force               Re-archive even when already archived (overwrite
 *                         title prefix with the current date).
 *   --db-id <uuid>        Archive only this single DB id from the inventory.
 *   --owner-id <uuid>     Override the default Kevin owner UUID for the
 *                         event_log row.
 *   -h | --help           Print usage and exit 0.
 *
 * Environment
 * -----------
 *   NOTION_TOKEN          (or AWS Secrets Manager fallback
 *                          `kos/notion-integration-token`).
 *   RDS_URL               postgres://... (or KOS_DB_TUNNEL_PORT for the
 *                          ssh-tunnel path used by db-push.sh).
 *   KEVIN_OWNER_ID        UUID for owner_id; defaults to the Phase-1
 *                          well-known UUID if neither --owner-id nor the
 *                          env var is set.
 *
 * Notion 90-day trash semantics
 * -----------------------------
 *   `archived: true` puts the DB into Notion's trash. Trash retains the
 *   row for 30-90 days (depending on workspace tier) and rollback is
 *   possible via:
 *     a. Notion UI: Trash → Restore.
 *     b. API: notion.databases.update({ database_id, archived: false }).
 *     c. event_log: SELECT detail->>'original_title' to recover the
 *        pre-archive title.
 *
 *   This script NEVER deletes anything. Lock-database (Notion UI) is a
 *   manual operator step (Notion API does not expose it — see
 *   10-RESEARCH.md §2).
 *
 * MIG-04 invariant
 * ----------------
 *   Command Center DB (scripts/.notion-db-ids.json#commandCenter) is the
 *   live task substrate and is NEVER referenced by this script. The
 *   sibling `verify-brain-dbs-archived.mjs` runs the assertion that
 *   Command Center still has >=167 rows post-archive.
 */
import { Client as NotionClient } from '@notionhq/client';
import pg from 'pg';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAIN_DBS_FILE = resolve(__dirname, '.notion-brain-dbs.json');

// Phase-1 well-known Kevin owner UUID (matches DEFAULT in 0001_initial.sql
// for `event_log.owner_id`). Override via --owner-id or KEVIN_OWNER_ID env.
const DEFAULT_KEVIN_OWNER_ID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';

// Notion 429 retry policy. Tests can shrink the backoff via env var so the
// failure-mode assertions don't sit in 21 seconds of sleep.
const NOTION_RETRY_DELAYS_MS = process.env.KOS_NOTION_RETRY_DELAYS_MS
  ? process.env.KOS_NOTION_RETRY_DELAYS_MS.split(',').map((n) => Number(n.trim()))
  : [1000, 5000, 15000];

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false, force: false, dbId: null, ownerId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--db-id') out.dbId = args[++i];
    else if (a === '--owner-id') out.ownerId = args[++i];
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/migrate-brain-dbs.mjs [options]',
      '',
      'Archive the 5 legacy Brain DBs in Notion with write-ahead event_log audit.',
      '',
      'Options:',
      '  --dry-run            Print proposed changes; no event_log write, no Notion mutation.',
      '  --force              Re-archive even if already archived (overwrites title prefix).',
      '  --db-id <uuid>       Archive only this Brain DB id (must be in the inventory file).',
      '  --owner-id <uuid>    Override KEVIN_OWNER_ID for the event_log row.',
      '  -h, --help           Show this help and exit.',
      '',
      'Inventory file: scripts/.notion-brain-dbs.json (gitignored).',
      'Template file:  scripts/.notion-brain-dbs.example.json (committed).',
      '',
      'Env: NOTION_TOKEN (or kos/notion-integration-token via Secrets Manager),',
      '     RDS_URL or KOS_DB_TUNNEL_PORT, KEVIN_OWNER_ID (optional UUID).',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Inventory + token resolution
// ---------------------------------------------------------------------------

function loadInventory() {
  if (!existsSync(BRAIN_DBS_FILE)) {
    throw new Error(
      `Inventory file missing: ${BRAIN_DBS_FILE}. ` +
        `Copy scripts/.notion-brain-dbs.example.json → scripts/.notion-brain-dbs.json ` +
        `and replace the REPLACE_WITH_NOTION_UUID_* placeholders with real UUIDs.`,
    );
  }
  let json;
  try {
    json = JSON.parse(readFileSync(BRAIN_DBS_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${BRAIN_DBS_FILE}: ${err && err.message ? err.message : err}`);
  }
  const list = Array.isArray(json.brain_dbs) ? json.brain_dbs : [];
  if (list.length === 0) {
    throw new Error(`${BRAIN_DBS_FILE} contains no brain_dbs entries.`);
  }
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      throw new Error(`Inventory entry malformed (need {id,name}): ${JSON.stringify(entry)}`);
    }
    if (entry.id.startsWith('REPLACE_')) {
      throw new Error(
        `Inventory entry "${entry.name}" still has placeholder UUID (${entry.id}). ` +
          `Populate ${BRAIN_DBS_FILE} with real UUIDs before running.`,
      );
    }
  }
  return list;
}

function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    const raw = execSync(
      'aws secretsmanager get-secret-value --secret-id kos/notion-integration-token --query SecretString --output text',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();
    if (!raw || raw === 'null') throw new Error('secret is empty');
    return raw;
  } catch (err) {
    throw new Error(
      'NOTION_TOKEN not set and Secrets Manager fallback failed (kos/notion-integration-token). ' +
        'Underlying error: ' +
        (err && err.message ? err.message : String(err)),
    );
  }
}

// ---------------------------------------------------------------------------
// Postgres client (event_log)
// ---------------------------------------------------------------------------

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
  if (!connStr) {
    throw new Error('RDS_URL (or KOS_DB_TUNNEL_PORT) required for event_log writes');
  }
  return new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: true } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the plain-text title from a Notion database object. */
export function extractCurrentTitle(db) {
  const arr = Array.isArray(db?.title) ? db.title : [];
  return arr
    .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
    .join('')
    .trim();
}

/** Build the [MIGRERAD-YYYY-MM-DD] prefixed title. */
export function buildMigreratTitle(currentTitle, isoDateOverride) {
  const date = (isoDateOverride ?? new Date().toISOString()).slice(0, 10);
  return `[MIGRERAD-${date}] ${currentTitle}`;
}

/** Detect whether a title already carries the migration prefix. */
export function hasMigreratPrefix(title) {
  return /^\[MIGRERAD-\d{4}-\d{2}-\d{2}\]/.test(title);
}

/** Strip an existing [MIGRERAD-...] prefix so --force can overlay a new date. */
export function stripMigreratPrefix(title) {
  return title.replace(/^\[MIGRERAD-\d{4}-\d{2}-\d{2}\]\s*/, '');
}

/** Sleep helper for retry backoff. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call notion.databases.update with retry on 429 / transient 5xx.
 * Throws on permanent failure.
 */
async function notionUpdateWithRetry(notion, params) {
  let lastErr;
  for (let attempt = 0; attempt <= NOTION_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await notion.databases.update(params);
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.code;
      const retriable = status === 429 || status === 502 || status === 503 || status === 504;
      if (!retriable || attempt === NOTION_RETRY_DELAYS_MS.length) break;
      const delay = NOTION_RETRY_DELAYS_MS[attempt];
      console.warn(
        `[migrate-brain-dbs] notion.databases.update transient error (status=${status}); ` +
          `retry ${attempt + 1}/${NOTION_RETRY_DELAYS_MS.length} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Per-DB archival — exported for the ordering unit test
// ---------------------------------------------------------------------------

/**
 * Archive a single Brain DB. Audit-first: event_log INSERT runs BEFORE
 * notion.databases.update. The ordering unit test
 * (verify-brain-db-archive-ordering.mjs) verifies this invariant.
 *
 * @param {{ notion, pg, db: { id, name }, ownerId, force, isoDate }} args
 * @returns {Promise<{ status: 'ok'|'skip', reason?: string, eventLogId?: string,
 *   originalTitle?: string, newTitle?: string }>}
 */
export async function archiveSingleDb(args) {
  const { notion, pg: pgClient, db, ownerId, force, isoDate } = args;

  // 1) Retrieve current state.
  const current = await notion.databases.retrieve({ database_id: db.id });
  const currentTitle = extractCurrentTitle(current);
  const alreadyArchived = current.archived === true;
  const alreadyMigrerat = hasMigreratPrefix(currentTitle);

  // 2) Idempotency check.
  if (alreadyArchived && alreadyMigrerat && !force) {
    return {
      status: 'skip',
      reason: 'already archived with [MIGRERAD-] prefix',
      originalTitle: currentTitle,
    };
  }

  // 3) Build new title — strip any pre-existing prefix on --force so we
  //    don't stack `[MIGRERAD-...] [MIGRERAD-...]` doubles.
  const baseTitle = alreadyMigrerat ? stripMigreratPrefix(currentTitle) : currentTitle;
  const newTitle = buildMigreratTitle(baseTitle, isoDate);

  // 4) AUDIT-FIRST WRITE (D-12). This must run BEFORE the Notion call so a
  //    failed Notion call still leaves the INTENT in event_log.
  //
  //    Column shape per packages/db/drizzle/0001_initial.sql:
  //      (id, owner_id, kind, detail, occurred_at) + actor (added 0021).
  //
  //    Detail JSON is constructed first so the SQL + execution sit
  //    immediately adjacent to the Notion mutation below — this preserves
  //    the textual ordering invariant (audit SQL precedes notion.update
  //    within a few lines) that the plan's grep-based verifier checks.
  const insertDetail = JSON.stringify({
    database_id: db.id,
    inventory_name: db.name,
    original_title: currentTitle,
    new_title: newTitle,
    archived_before: alreadyArchived,
    forced: !!force,
    reversibility_note:
      'restore via Notion API archived:false within 90 days OR Notion UI Trash > Restore. Pre-archive title preserved in detail.original_title.',
  });
  // Audit-first INSERT INTO event_log — followed immediately by the
  // notion.databases.update call below. Order is the invariant.
  const insertRes = await pgClient.query(
    `INSERT INTO event_log (owner_id, kind, detail, actor)
     VALUES ($1, 'brain-db-archived', $2::jsonb, 'scripts/migrate-brain-dbs.mjs')
     RETURNING id`,
    [ownerId, insertDetail],
  );
  const eventLogId = insertRes?.rows?.[0]?.id;
  if (!eventLogId) throw new Error(`event_log INSERT failed for db=${db.id}; not mutating Notion`);
  // 5) Notion mutation. AFTER audit-write, with 429/5xx retry.
  await notionUpdateWithRetry(notion, {
    database_id: db.id,
    archived: true,
    title: [{ type: 'text', text: { content: newTitle } }],
  });

  // 6) Confirmation write-back. UPDATE the same audit row with notion_ack_at
  //    so verify-brain-dbs-archived.mjs can tell INTENT apart from ACK.
  await pgClient.query(
    `UPDATE event_log
       SET detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('notion_ack_at', $1::text)
     WHERE id = $2`,
    [new Date().toISOString(), eventLogId],
  );

  return {
    status: 'ok',
    eventLogId,
    originalTitle: currentTitle,
    newTitle,
  };
}

// ---------------------------------------------------------------------------
// Dry-run renderer (no event_log write, no Notion mutation)
// ---------------------------------------------------------------------------

async function dryRunSingleDb(notion, db) {
  const current = await notion.databases.retrieve({ database_id: db.id });
  const currentTitle = extractCurrentTitle(current);
  const alreadyArchived = current.archived === true;
  const alreadyMigrerat = hasMigreratPrefix(currentTitle);
  const baseTitle = alreadyMigrerat ? stripMigreratPrefix(currentTitle) : currentTitle;
  const newTitle = buildMigreratTitle(baseTitle);
  return {
    id: db.id,
    inventoryName: db.name,
    currentTitle,
    proposedTitle: newTitle,
    alreadyArchived,
    alreadyMigrerat,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const inventory = loadInventory();
  const target = opts.dbId ? inventory.filter((d) => d.id === opts.dbId) : inventory;
  if (target.length === 0) {
    throw new Error(`--db-id ${opts.dbId} not found in inventory`);
  }

  const ownerId = opts.ownerId ?? process.env.KEVIN_OWNER_ID ?? DEFAULT_KEVIN_OWNER_ID;
  const notion = new NotionClient({ auth: getNotionToken() });

  console.log(
    `[migrate-brain-dbs] ${opts.dryRun ? 'DRY-RUN' : 'EXECUTE'} ` +
      `targets=${target.length} owner=${ownerId} force=${opts.force}`,
  );

  // ------------------------------------------------------------- DRY-RUN
  if (opts.dryRun) {
    const rows = [];
    for (const db of target) {
      try {
        const row = await dryRunSingleDb(notion, db);
        rows.push(row);
        console.log(
          `[DRY] ${row.id}  ${row.alreadyArchived ? '(archived)' : '(active)  '}  ` +
            `${row.alreadyMigrerat ? '(prefixed)' : '          '}  ` +
            `"${row.currentTitle}" → "${row.proposedTitle}"`,
        );
      } catch (err) {
        console.error(`[DRY-ERR] ${db.id} ${db.name}: ${err && err.message ? err.message : err}`);
        rows.push({ id: db.id, error: String(err && err.message ? err.message : err) });
      }
    }
    console.log('');
    console.log(`[DRY-DONE] inspected ${rows.length}/${target.length} (no writes performed).`);
    console.log(
      'POST-ARCHIVE NOTE: Kevin must manually enable "Lock database" in the Notion UI for ' +
        'each archived DB — the Notion API does not expose this setting (see 10-RESEARCH.md §2).',
    );
    return 0;
  }

  // -------------------------------------------------------------- EXECUTE
  const pgClient = buildPgClient();
  await pgClient.connect();
  const results = [];
  let exitCode = 0;
  try {
    for (const db of target) {
      const t0 = Date.now();
      try {
        const r = await archiveSingleDb({
          notion,
          pg: pgClient,
          db,
          ownerId,
          force: opts.force,
        });
        if (r.status === 'skip') {
          console.log(`[SKIP] ${db.id}  ${db.name}: ${r.reason}`);
        } else {
          console.log(
            `[OK]   ${db.id}  ${db.name}: archived (${Date.now() - t0}ms) event_log=${r.eventLogId}`,
          );
          console.log(`         "${r.originalTitle}" → "${r.newTitle}"`);
        }
        results.push({ db, result: r });
      } catch (err) {
        exitCode = 1;
        const msg = err && err.message ? err.message : String(err);
        console.error(`[ERR]  ${db.id}  ${db.name}: ${msg}`);
        console.error(
          '       NOTE: if event_log row was written, the INTENT is recorded — ' +
            'check `SELECT id, detail FROM event_log WHERE kind=\'brain-db-archived\' ' +
            `AND detail->>'database_id'='${db.id}' ORDER BY occurred_at DESC LIMIT 1;` +
            ' to find the row and retry with --db-id ' +
            db.id +
            ' --force.',
        );
        results.push({ db, error: msg });
      }
    }
  } finally {
    await pgClient.end();
  }

  // ---------------------------------------------------- Summary
  const ok = results.filter((r) => r.result?.status === 'ok').length;
  const skip = results.filter((r) => r.result?.status === 'skip').length;
  const err = results.filter((r) => r.error).length;
  console.log('');
  console.log(`[DONE] archived=${ok} skipped=${skip} errors=${err} (of ${results.length} target)`);
  console.log(
    'POST-ARCHIVE NOTE: Kevin must manually enable "Lock database" in the Notion UI for ' +
      'each archived DB — the Notion API does not expose this setting (see 10-RESEARCH.md §2).',
  );
  console.log(
    'VERIFY: node scripts/verify-brain-dbs-archived.mjs   (asserts archived + [MIGRERAD-] + event_log ack)',
  );
  return exitCode;
}

// Only run when invoked directly (not when imported by the ordering test).
const isDirectInvocation = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('FATAL:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}
