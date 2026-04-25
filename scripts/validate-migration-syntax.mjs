#!/usr/bin/env node
/**
 * scripts/validate-migration-syntax.mjs
 *
 * Phase 4 Plan 04-00 Task 3 — pragmatic migration validator (token grep).
 *
 * Greps the migration file for the Phase 4 required tokens (table names,
 * owner_id columns, the (account_id, message_id) unique constraint, etc.).
 * Exits 0 when every required token is present, exits 1 with a list of
 * missing tokens otherwise.
 *
 * This is intentionally NOT a real SQL parser — pulling in pg-query-parser
 * would add a heavy native devDependency for a one-shot guard. The intent
 * is to catch dropped tokens during scaffolding, not to validate full
 * Postgres grammar (the real DB push step in scripts/db-push.sh exercises
 * the actual parser).
 *
 * Usage:
 *   node scripts/validate-migration-syntax.mjs <path-to-migration.sql>
 *
 * Required tokens (Phase 4 Migration 0016):
 *   - CREATE TABLE ... email_drafts
 *   - CREATE TABLE ... email_send_authorizations
 *   - CREATE TABLE ... agent_dead_letter
 *   - owner_id uuid (must appear in every table)
 *   - UNIQUE ("account_id", "message_id")
 *
 * If a different migration is passed (Phase 6 / 7 backfill check, etc.),
 * the script falls back to a generic balanced-parens + non-empty-content
 * check.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length !== 1) {
  console.error('usage: node scripts/validate-migration-syntax.mjs <path-to-sql>');
  process.exit(1);
}
const path = resolve(argv[0]);
if (!existsSync(path)) {
  console.error(`ERROR: file not found: ${path}`);
  process.exit(1);
}

const sql = readFileSync(path, 'utf8');

/** Strip SQL line comments so token grep doesn't trip on -- ROLLBACK lines. */
function stripLineComments(input) {
  return input
    .split('\n')
    .map((line) => {
      const ix = line.indexOf('--');
      return ix === -1 ? line : line.slice(0, ix);
    })
    .join('\n');
}

const stripped = stripLineComments(sql);

const isPhase4 = /0016_phase_4_email_and_dead_letter\.sql$/.test(path);

const missing = [];

if (isPhase4) {
  // Phase-4-specific token requirements.
  const requiredTokens = [
    { name: 'CREATE TABLE email_drafts', re: /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?email_drafts"?/i },
    {
      name: 'CREATE TABLE email_send_authorizations',
      re: /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?email_send_authorizations"?/i,
    },
    {
      name: 'CREATE TABLE agent_dead_letter',
      re: /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?agent_dead_letter"?/i,
    },
    { name: 'owner_id uuid', re: /"?owner_id"?\s+uuid/i },
    {
      name: 'UNIQUE (account_id, message_id)',
      re: /UNIQUE\s*\(\s*"?account_id"?\s*,\s*"?message_id"?\s*\)/i,
    },
    {
      name: 'index email_drafts_owner_status_idx',
      re: /CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?"?email_drafts_owner_status_idx"?/i,
    },
    {
      name: 'index agent_dead_letter_owner_occurred_idx',
      re: /CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?"?agent_dead_letter_owner_occurred_idx"?/i,
    },
  ];

  for (const t of requiredTokens) {
    if (!t.re.test(stripped)) missing.push(t.name);
  }

  // owner_id uuid must appear at least 3 times — once per table.
  const ownerIdCount = (stripped.match(/"?owner_id"?\s+uuid/gi) ?? []).length;
  if (ownerIdCount < 3) {
    missing.push(
      `owner_id uuid appears ${ownerIdCount}× (need ≥3 — one per table)`,
    );
  }
}

// Generic balance check (always run): paren counts must match.
const opens = (stripped.match(/\(/g) ?? []).length;
const closes = (stripped.match(/\)/g) ?? []).length;
if (opens !== closes) {
  missing.push(`unbalanced parens: ${opens} '(' vs ${closes} ')'`);
}

if (stripped.trim().length === 0) {
  missing.push('migration file body is empty after comment strip');
}

if (missing.length > 0) {
  console.error(`FAIL: ${path}`);
  for (const m of missing) console.error(`  - missing: ${m}`);
  process.exit(1);
}

console.log(`OK: ${path}`);
process.exit(0);
