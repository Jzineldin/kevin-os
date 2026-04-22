#!/usr/bin/env node
/**
 * Plan 02-08 — verify KOS Inbox row count meets the ROADMAP Phase 2 SC4
 * target (≥ 50 candidate dossiers seeded). Exits 0 on success, 1 on shortfall.
 *
 * Usage:
 *   node scripts/verify-inbox-count.mjs            # default --min 50
 *   node scripts/verify-inbox-count.mjs --min 100
 *
 * Reads NOTION_TOKEN from env or `aws secretsmanager get-secret-value
 * --secret-id kos/notion-token` fallback.
 */
import { Client } from '@notionhq/client';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = new Map();
for (let i = 0; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (typeof a === 'string' && a.startsWith('--')) {
    args.set(a.slice(2), process.argv[i + 1]);
  }
}
const MIN = Number(args.get('min') ?? 50);

let token = process.env.NOTION_TOKEN;
if (!token) {
  try {
    token = execSync(
      'aws secretsmanager get-secret-value --secret-id kos/notion-token --query SecretString --output text',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();
  } catch (err) {
    console.error('[ERR] NOTION_TOKEN not set and Secrets Manager fallback failed: ' + (err?.message ?? err));
    process.exit(2);
  }
}

const ids = JSON.parse(readFileSync('scripts/.notion-db-ids.json', 'utf8'));
if (!ids.kosInbox) {
  console.error('[ERR] scripts/.notion-db-ids.json missing "kosInbox" key — run scripts/bootstrap-notion-dbs.mjs first');
  process.exit(2);
}

const client = new Client({ auth: token });
let count = 0;
let cursor;
do {
  const r = await client.databases.query({
    database_id: ids.kosInbox,
    page_size: 100,
    start_cursor: cursor,
  });
  count += (r.results ?? []).length;
  cursor = r.has_more ? r.next_cursor : undefined;
} while (cursor);

console.log(`[i] KOS Inbox total rows: ${count}`);
if (count < MIN) {
  console.error(`[ERR] expected ≥ ${MIN}, got ${count}`);
  process.exit(1);
}
console.log(`[OK] ≥ ${MIN} inbox rows present`);
