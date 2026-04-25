#!/usr/bin/env node
/**
 * discover-notion-dbs.mjs — operator runbook script for Phase 6.
 *
 * Discovers a Notion database by case-insensitive title match using
 * `notion.search` and merges its UUID into `scripts/.notion-db-ids.json`.
 * Phase 6 ships this for the `transkripten` key (granola-poller). The same
 * pattern handles future per-DB discovery (`--db <key>`).
 *
 * Inputs:
 *   --db <name>                      (required — JSON key + title heuristic)
 *   NOTION_TOKEN                     (env; fallback: `aws secretsmanager get-secret-value`)
 *
 * Outputs:
 *   scripts/.notion-db-ids.json      (idempotent merge of <name>: <uuid>)
 *
 * Post-discovery operator runbook (printed on success):
 *   1. UPDATE notion_indexer_cursor SET db_id='<uuid>' WHERE db_kind='<name>';
 *   2. cdk deploy KosIntegrations
 *   3. aws lambda invoke --function-name KosIntegrations-GranolaPoller* /tmp/r.json
 *
 * Usage:
 *   node scripts/discover-notion-dbs.mjs --db transkripten
 */
import { Client } from '@notionhq/client';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_FILE = resolve(__dirname, '.notion-db-ids.json');

// --- Argument parsing -------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--db') out.db = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/discover-notion-dbs.mjs --db <name>\n\n' +
          '  --db <name>     The DB key in scripts/.notion-db-ids.json (e.g. transkripten).\n' +
          '                  The value is also used as a case-insensitive title heuristic.\n',
      );
      process.exit(0);
    }
  }
  if (!out.db) {
    console.error('FATAL: --db <name> is required (e.g. --db transkripten)');
    process.exit(2);
  }
  return out;
}

// --- Notion token resolution ------------------------------------------------

function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    const raw = execSync(
      'aws secretsmanager get-secret-value --secret-id kos/notion-token --query SecretString --output text',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();
    if (!raw || raw === 'null') throw new Error('secret is empty');
    return raw;
  } catch (err) {
    throw new Error(
      'NOTION_TOKEN not set and Secrets Manager fallback failed (kos/notion-token). ' +
        'Seed the secret first via scripts/seed-secrets.sh or export NOTION_TOKEN. ' +
        'Underlying error: ' +
        (err && err.message ? err.message : String(err)),
    );
  }
}

// --- Discovery --------------------------------------------------------------

async function discoverByTitle(notion, key) {
  // Search returns up to 100 results; case-insensitive substring match.
  const wantedLower = key.toLowerCase();
  const res = await notion.search({
    query: key,
    filter: { property: 'object', value: 'database' },
    page_size: 50,
  });
  const dbs = (res.results ?? []).filter((r) => r?.object === 'database');
  // Exact-title narrowing first.
  const exact = dbs.filter((d) => {
    const titleArr = Array.isArray(d.title) ? d.title : [];
    const title = titleArr
      .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
      .join('')
      .trim()
      .toLowerCase();
    return title === wantedLower;
  });
  if (exact.length === 1) return { id: exact[0].id, title: exact[0].title?.[0]?.plain_text ?? key };
  if (exact.length > 1) {
    throw new Error(
      `Ambiguous: ${exact.length} databases titled exactly "${key}" found. ` +
        `Candidate UUIDs: ${exact.map((d) => d.id).join(', ')}. ` +
        `Resolve by deleting/archiving duplicates in Notion, or update scripts/.notion-db-ids.json manually.`,
    );
  }
  // Fall back to substring match if no exact hit.
  const partial = dbs.filter((d) => {
    const titleArr = Array.isArray(d.title) ? d.title : [];
    const title = titleArr
      .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
      .join('')
      .toLowerCase();
    return title.includes(wantedLower);
  });
  if (partial.length === 1) return { id: partial[0].id, title: partial[0].title?.[0]?.plain_text ?? key };
  if (partial.length === 0) {
    throw new Error(
      `No database matching "${key}" found in workspace. ` +
        `Check that the integration has access to the DB (Notion → Settings → Connections).`,
    );
  }
  throw new Error(
    `Ambiguous: ${partial.length} databases matching "${key}" (substring) found. ` +
      `Candidates: ${partial.map((d) => `${d.id} (${(d.title?.[0]?.plain_text ?? '?').trim()})`).join(', ')}. ` +
      `Edit scripts/.notion-db-ids.json manually with the correct UUID.`,
  );
}

// --- ID file merge ----------------------------------------------------------

function readIdFile() {
  if (!existsSync(ID_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ID_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeIdFile(merged) {
  writeFileSync(ID_FILE, JSON.stringify(merged, null, 2) + '\n');
}

// --- Main -------------------------------------------------------------------

async function main() {
  const { db } = parseArgs();
  const token = getNotionToken();
  const notion = new Client({ auth: token });

  console.log(`[discover-notion-dbs] Searching for database "${db}"...`);
  const { id, title } = await discoverByTitle(notion, db);
  console.log(`[discover-notion-dbs] Found: "${title}" → ${id}`);

  const existing = readIdFile();
  const before = existing[db];
  if (before === id) {
    console.log(`[discover-notion-dbs] scripts/.notion-db-ids.json already has ${db}=${id} (no change).`);
  } else {
    existing[db] = id;
    writeIdFile(existing);
    console.log(
      `[discover-notion-dbs] Updated scripts/.notion-db-ids.json: ${db}=${id}` +
        (before ? ` (was: ${before})` : ' (new entry)'),
    );
  }

  // Operator runbook reminder.
  console.log('');
  console.log('--- Next steps -------------------------------------------------');
  console.log(`  1. UPDATE notion_indexer_cursor SET db_id='${id}' WHERE db_kind='${db}';`);
  console.log('  2. cdk deploy KosIntegrations');
  console.log(`  3. aws lambda invoke --function-name KosIntegrations-GranolaPoller* /tmp/r.json`);
  console.log('-----------------------------------------------------------------');
}

main().catch((err) => {
  console.error('FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
