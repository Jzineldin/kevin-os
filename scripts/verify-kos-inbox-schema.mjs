#!/usr/bin/env node
/**
 * verify-kos-inbox-schema.mjs — Plan 02-07 operator verifier.
 *
 * Reads the KOS Inbox Notion database (UUID from scripts/.notion-db-ids.json
 * key `kosInbox`) and asserts that all 9 D-13 + MergedInto properties exist
 * with the correct types. Exits 0 on success, 1 on schema drift.
 *
 * Inputs:
 *   NOTION_TOKEN  (fallback: aws secretsmanager get-secret-value --secret-id kos/notion-token)
 *
 * Usage:
 *   NOTION_TOKEN=secret_xxx node scripts/verify-kos-inbox-schema.mjs
 *   # or rely on the AWS Secrets Manager fallback (matches bootstrap-notion-dbs.mjs)
 */
import { Client } from '@notionhq/client';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_FILE = resolve(__dirname, '.notion-db-ids.json');

function getToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    return execSync(
      'aws secretsmanager get-secret-value --secret-id kos/notion-token --query SecretString --output text',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();
  } catch (err) {
    console.error(
      '[ERR] NOTION_TOKEN not set and Secrets Manager fallback failed (kos/notion-token).',
    );
    console.error('       ', err && err.message ? err.message : String(err));
    process.exit(2);
  }
}

const token = getToken();
let ids;
try {
  ids = JSON.parse(readFileSync(ID_FILE, 'utf8'));
} catch (err) {
  console.error('[ERR] Could not read', ID_FILE, '—', err.message);
  process.exit(1);
}

if (!ids.kosInbox) {
  console.error(
    '[ERR] scripts/.notion-db-ids.json missing kosInbox key — run scripts/bootstrap-notion-dbs.mjs first',
  );
  process.exit(1);
}

const client = new Client({ auth: token });
const db = await client.databases.retrieve({ database_id: ids.kosInbox });

// 8 D-13 properties + MergedInto (Plan 02-07 extra for D-14 merge path).
const expected = [
  ['Proposed Entity Name', 'title'],
  ['Type', 'select'],
  ['Candidate Matches', 'relation'],
  ['Source Capture ID', 'rich_text'],
  ['Status', 'select'],
  ['Confidence', 'number'],
  ['Raw Context', 'rich_text'],
  ['Created', 'date'],
  ['MergedInto', 'relation'],
];

let ok = true;
for (const [name, type] of expected) {
  const prop = db.properties[name];
  if (!prop) {
    console.error(`[ERR] missing property: ${name}`);
    ok = false;
    continue;
  }
  if (prop.type !== type) {
    console.error(`[ERR] property ${name} has type=${prop.type}, expected ${type}`);
    ok = false;
  }
}

// Cross-check Status select options include the four Plan 02-07 / D-13 values.
const statusProp = db.properties.Status;
if (statusProp && statusProp.type === 'select') {
  const optionNames = (statusProp.select?.options ?? []).map((o) => o.name);
  for (const required of ['Pending', 'Approved', 'Merged', 'Rejected']) {
    if (!optionNames.includes(required)) {
      console.error(`[ERR] Status select missing option: ${required} (have: ${optionNames.join(', ')})`);
      ok = false;
    }
  }
}

// Cross-check Type select options include the four D-13 values.
const typeProp = db.properties.Type;
if (typeProp && typeProp.type === 'select') {
  const optionNames = (typeProp.select?.options ?? []).map((o) => o.name);
  for (const required of ['Person', 'Project', 'Org', 'Other']) {
    if (!optionNames.includes(required)) {
      console.error(`[ERR] Type select missing option: ${required} (have: ${optionNames.join(', ')})`);
      ok = false;
    }
  }
}

if (!ok) {
  console.error('');
  console.error('[FAIL] KOS Inbox schema verification failed — re-run scripts/bootstrap-notion-dbs.mjs');
  process.exit(1);
}

console.log('[OK] KOS Inbox DB schema verified: 9 properties (8 D-13 + MergedInto)');
console.log('     database_id:', ids.kosInbox);
