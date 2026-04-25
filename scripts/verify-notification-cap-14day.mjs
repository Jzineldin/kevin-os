#!/usr/bin/env node
/**
 * verify-notification-cap-14day.mjs — Phase 7 cap-invariant developer verifier.
 *
 * Operator-runnable equivalent of the verify-notification-cap Lambda (D-07).
 * Reads agent_runs (SQL) + DynamoDB TelegramCap rows for the last 14 Stockholm-
 * local days and asserts no day has > 3 push-telegram runs.
 *
 * Exit codes:
 *   0 — all 14 days within the cap (3 push-telegram runs/day max)
 *   1 — one or more days violated the cap
 *   2 — missing config (CAP_TABLE_NAME or DATABASE_URL unset)
 *
 * Required environment:
 *   DATABASE_URL      — full pg connection string for kos RDS Proxy
 *                       (operator's local AWS creds + IAM auth dance, OR
 *                       a temp `psql` connection URL)
 *   CAP_TABLE_NAME    — DynamoDB cap table name (e.g. KosTelegramCap-prod)
 *   KEVIN_OWNER_ID    — Kevin's owner UUID; defaults to the §13 constant
 *   AWS_REGION        — defaults to eu-north-1
 *
 * Usage:
 *   AWS_REGION=eu-north-1 \
 *   DATABASE_URL=postgres://... \
 *   CAP_TABLE_NAME=KosTelegramCap-prod \
 *     node scripts/verify-notification-cap-14day.mjs
 */
import pg from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const OWNER_ID = process.env.KEVIN_OWNER_ID ?? '9e4be978-cc7d-571b-98ec-a1e92373682c';
const CAP_TABLE_NAME = process.env.CAP_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

if (!CAP_TABLE_NAME || !DATABASE_URL) {
  console.error(
    'verify-notification-cap-14day: missing config.\n' +
      '  Set DATABASE_URL (postgres connection string) and CAP_TABLE_NAME.\n' +
      '  Optional: KEVIN_OWNER_ID, AWS_REGION (default eu-north-1).',
  );
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const sql = `
  SELECT to_char(date_trunc('day', (started_at AT TIME ZONE 'Europe/Stockholm')), 'YYYY-MM-DD') AS stockholm_date,
         count(*) FILTER (WHERE agent_name = 'push-telegram' AND status = 'ok') AS push_ok_count
    FROM agent_runs
   WHERE owner_id = $1
     AND started_at >= now() - interval '14 days'
   GROUP BY 1
   ORDER BY 1 DESC
`;

let violations = 0;
try {
  const { rows } = await pool.query(sql, [OWNER_ID]);
  const sqlByDate = new Map();
  for (const r of rows) sqlByDate.set(String(r.stockholm_date), Number(r.push_ok_count));

  // Build the 14-day Stockholm-local window (today → 13 days ago).
  const days = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const sv = d.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
    const datePart = sv.split(' ')[0];
    if (datePart) days.push(datePart);
  }

  console.log('Stockholm Date | Pushes | DDB | Status');
  console.log('---------------+--------+-----+----------');
  for (const stockholmDate of days) {
    const pushOk = sqlByDate.get(stockholmDate) ?? 0;
    let ddCount = null;
    try {
      const r = await ddb.send(
        new GetCommand({
          TableName: CAP_TABLE_NAME,
          Key: { pk: `telegram-cap#${stockholmDate}` },
        }),
      );
      const c = r.Item?.count;
      if (typeof c === 'number') ddCount = c;
    } catch (err) {
      // Best-effort — operator may run without DDB perms.
      console.warn(`  (DDB GetItem failed for ${stockholmDate}: ${String(err)})`);
    }
    const status = pushOk > 3 ? 'VIOLATION' : 'ok';
    if (pushOk > 3) violations++;
    console.log(
      `${stockholmDate}     | ${String(pushOk).padStart(6)} | ${String(ddCount ?? '—').padStart(3)} | ${status}`,
    );
  }
} finally {
  await pool.end();
}

if (violations > 0) {
  console.error(`\n${violations} day(s) violated the 3-push cap.`);
  process.exit(1);
}
console.log('\n14-day cap invariant HOLDS.');
process.exit(0);
