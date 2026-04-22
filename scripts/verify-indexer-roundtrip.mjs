#!/usr/bin/env node
/**
 * verify-indexer-roundtrip.mjs — Gate 1 live assertion for Plan 01-04.
 *
 * Creates a canary Entities page named ROUNDTRIP-TEST-<ulid>, polls RDS
 * entity_index every 30 s for up to 7 minutes, asserts the row lands with
 * matching name, and archives the canary on exit.
 *
 * Runs OUT-OF-WORKTREE (real Notion + real RDS). Deferred to operator.
 *
 * Required env:
 *   NOTION_TOKEN                 (or Secrets Manager kos/notion-token)
 *   DATABASE_URL                 postgres://kos_admin@<proxy>:5432/kos?sslmode=require
 *                                (or the Lambda's IAM token; easier to use
 *                                the bastion tunnel port that db-push.sh uses)
 *   KOS_DB_TUNNEL_PORT           optional — if set, connect to localhost:$PORT
 */
import { Client as NotionClient } from '@notionhq/client';
import pg from 'pg';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ulid } from 'ulid';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  return execSync(
    'aws secretsmanager get-secret-value --secret-id kos/notion-token --query SecretString --output text',
  )
    .toString()
    .trim();
}

function loadEntitiesDbId() {
  const ids = JSON.parse(readFileSync(resolve(__dirname, '.notion-db-ids.json'), 'utf8'));
  if (!ids.entities || ids.entities === 'pending-bootstrap') {
    throw new Error(
      'scripts/.notion-db-ids.json has no entities ID. Run scripts/bootstrap-notion-dbs.mjs first.',
    );
  }
  return ids.entities;
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
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error('DATABASE_URL (or KOS_DB_TUNNEL_PORT) required');
  return new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: true } });
}

async function main() {
  const notion = new NotionClient({ auth: getNotionToken() });
  const entitiesDbId = loadEntitiesDbId();
  const canary = `ROUNDTRIP-TEST-${ulid()}`;

  console.log('[roundtrip] creating canary page:', canary);
  const created = await notion.pages.create({
    parent: { database_id: entitiesDbId },
    properties: {
      Name: { title: [{ type: 'text', text: { content: canary } }] },
      Type: { select: { name: 'Document' } },
      Status: { select: { name: 'Archived' } },
    },
  });
  const pageId = created.id;
  console.log('[roundtrip] page id:', pageId);

  const client = buildPgClient();
  await client.connect();
  const deadline = Date.now() + 7 * 60 * 1000;
  let found = null;
  try {
    while (Date.now() < deadline) {
      const res = await client.query(
        'SELECT notion_page_id, name FROM entity_index WHERE notion_page_id = $1',
        [pageId],
      );
      if (res.rows.length > 0 && res.rows[0].name === canary) {
        found = res.rows[0];
        break;
      }
      console.log('[roundtrip] not yet — sleeping 30 s...');
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } finally {
    await client.end();
  }

  // Cleanup regardless of outcome.
  try {
    await notion.pages.update({ page_id: pageId, archived: true });
  } catch (err) {
    console.warn('[roundtrip] canary archive failed (non-fatal):', err?.message ?? err);
  }

  if (!found) {
    console.error('[roundtrip] FAIL — canary not found in RDS within 7 min');
    process.exit(1);
  }
  console.log('[roundtrip] PASS — canary landed with name:', found.name);
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
