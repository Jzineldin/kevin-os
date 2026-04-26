#!/usr/bin/env node
/**
 * scripts/verify-legacy-inbox-silent.mjs — Phase 10 Plan 10-02 verifier (T+2h).
 *
 * Asserts that the Notion Legacy Inbox database has received NO new rows
 * from the retired VPS sources since their `vps-service-stopped` audit row
 * was written to event_log. If any new row is found, the retirement is
 * incomplete (the VPS unit is back up, OR a stray copy of the Phase 1
 * freeze script is still posting from somewhere).
 *
 * The retirement candidate sources are:
 *   - morning_briefing
 *   - evening_checkin
 *   - classify_and_save   (Plan 10-01 once Wave 1 cutover completes)
 *
 * Algorithm:
 *   1. Read the most-recent `event_log` row of kind 'vps-service-stopped'
 *      for each source from RDS — that timestamp is T-0 for that unit.
 *   2. Query Notion Legacy Inbox DB for pages where `Source` ∈ {sources}
 *      AND `created_time` >= T-0_for_that_source.
 *   3. PASS if zero matches; FAIL with a list of page titles otherwise.
 *
 * Exit codes:
 *   0  zero new rows since each unit's T-0 (silence confirmed)
 *   1  one or more rows found post-T-0 (retirement is leaking)
 *   2  prerequisite missing (RDS_URL, NOTION_TOKEN, LEGACY_INBOX_DB_ID)
 *
 * Usage:
 *   node scripts/verify-legacy-inbox-silent.mjs
 *   node scripts/verify-legacy-inbox-silent.mjs --json
 *   node scripts/verify-legacy-inbox-silent.mjs --help
 *
 * Env vars (read from process.env or .env via dotenv if present):
 *   RDS_URL                  required (psql DSN)
 *   NOTION_TOKEN             required (Notion integration secret)
 *   LEGACY_INBOX_DB_ID       required (Phase 1 freeze inbox UUID)
 *   AWS_REGION               default 'eu-north-1' (unused — kept for parity)
 *
 * NPM dependencies:
 *   pg                       postgres client (already in root)
 *   @notionhq/client         Notion API (already in root)
 *
 * Cf. .planning/phases/10-migration-decommission/10-02-RETIREMENT-RUNBOOK.md
 *     T+2h step.
 */
import process from 'node:process';

function parseArgs(argv) {
  const out = { json: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else {
      console.error(`[FAIL] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(
    [
      'Usage: node scripts/verify-legacy-inbox-silent.mjs [--json]',
      '',
      'Reads each retired VPS unit\'s T-0 from event_log, then queries the',
      'Notion Legacy Inbox for any rows whose Source matches the unit and',
      'whose created_time is >= T-0. Exit 0 if silent, 1 if any leak found.',
    ].join('\n'),
  );
  process.exit(0);
}

const RDS_URL = process.env.RDS_URL || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const LEGACY_INBOX_DB_ID = process.env.LEGACY_INBOX_DB_ID || '';

if (!RDS_URL || !NOTION_TOKEN || !LEGACY_INBOX_DB_ID) {
  const missing = [
    !RDS_URL && 'RDS_URL',
    !NOTION_TOKEN && 'NOTION_TOKEN',
    !LEGACY_INBOX_DB_ID && 'LEGACY_INBOX_DB_ID',
  ]
    .filter(Boolean)
    .join(', ');
  console.error(`[FAIL] required env missing: ${missing}`);
  process.exit(2);
}

const SOURCES = ['morning_briefing', 'evening_checkin', 'classify_and_save'];

async function main() {
  // -----------------------------------------------------------------------
  // 1) Pull T-0 per source from event_log
  // -----------------------------------------------------------------------
  const pgMod = await import('pg');
  const { Client } = pgMod.default || pgMod;
  const pg = new Client({ connectionString: RDS_URL });
  await pg.connect();

  const t0BySource = {};
  try {
    for (const src of SOURCES) {
      const r = await pg.query(
        `SELECT occurred_at FROM event_log
           WHERE kind = 'vps-service-stopped'
             AND (
               detail->>'unit' = $1
               OR detail->>'unit' = $2
               OR detail->>'unit' = $3
             )
           ORDER BY occurred_at DESC
           LIMIT 1`,
        [src, `${src}.service`, `${src}.py`],
      );
      if (r.rows.length > 0) {
        t0BySource[src] = r.rows[0].occurred_at;
      }
    }
  } finally {
    await pg.end().catch(() => {});
  }

  if (Object.keys(t0BySource).length === 0) {
    const out = {
      ok: false,
      reason: 'no vps-service-stopped audit rows found for any retired source',
      sources: SOURCES,
    };
    console[args.json ? 'log' : 'error'](
      args.json ? JSON.stringify(out, null, 2) : `[FAIL] ${out.reason}`,
    );
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // 2) Query Notion Legacy Inbox per source for rows since T-0
  // -----------------------------------------------------------------------
  let NotionClient;
  try {
    ({ Client: NotionClient } = await import('@notionhq/client'));
  } catch (err) {
    console.error(`[FAIL] @notionhq/client not installed: ${err.message}`);
    process.exit(2);
  }
  const notion = new NotionClient({ auth: NOTION_TOKEN });
  const leaks = [];

  for (const [src, t0] of Object.entries(t0BySource)) {
    const t0Iso = t0 instanceof Date ? t0.toISOString() : new Date(t0).toISOString();
    const filter = {
      and: [
        { property: 'Source', select: { equals: src } },
        { timestamp: 'created_time', created_time: { on_or_after: t0Iso } },
      ],
    };
    let cursor;
    do {
      const res = await notion.databases.query({
        database_id: LEGACY_INBOX_DB_ID,
        filter,
        page_size: 25,
        start_cursor: cursor,
      });
      for (const p of res.results) {
        const titleProp =
          p.properties?.Name?.title?.[0]?.plain_text ||
          p.properties?.Title?.title?.[0]?.plain_text ||
          '(untitled)';
        leaks.push({
          source: src,
          page_id: p.id,
          title: titleProp,
          created_time: p.created_time,
          t0: t0Iso,
        });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }

  // -----------------------------------------------------------------------
  // 3) Report
  // -----------------------------------------------------------------------
  const ok = leaks.length === 0;
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          t0_by_source: Object.fromEntries(
            Object.entries(t0BySource).map(([k, v]) => [
              k,
              v instanceof Date ? v.toISOString() : v,
            ]),
          ),
          leaks,
        },
        null,
        2,
      ),
    );
  } else if (ok) {
    console.log(
      `[OK]  Legacy Inbox silent — 0 new rows since T-0 across ${Object.keys(t0BySource).length} retired source(s)`,
    );
    for (const [src, t0] of Object.entries(t0BySource)) {
      const t0Iso = t0 instanceof Date ? t0.toISOString() : new Date(t0).toISOString();
      console.log(`      ${src}: T-0=${t0Iso}`);
    }
  } else {
    console.error(
      `[FAIL] ${leaks.length} new Legacy Inbox row(s) since retirement T-0:`,
    );
    for (const l of leaks.slice(0, 25)) {
      console.error(
        `       - source=${l.source}  created=${l.created_time}  title=${JSON.stringify(l.title)}`,
      );
    }
    if (leaks.length > 25) {
      console.error(`       ... ${leaks.length - 25} more leaks elided`);
    }
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[FAIL] verifier crashed: ${err.stack || err.message}`);
  process.exit(1);
});
