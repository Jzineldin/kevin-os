#!/usr/bin/env node
/**
 * verify-quiet-hours-invariant.mjs — Phase 7 quiet-hours invariant verifier.
 *
 * Asserts zero `push-telegram` agent_runs (status='ok') happened where the
 * Stockholm-local hour falls inside [20, 8) — the quiet-hours window enforced
 * by services/push-telegram/src/quiet-hours.ts. Any violation here is a
 * regression of the §13 contract.
 *
 * Exit codes:
 *   0 — invariant holds (zero quiet-hours pushes in last 14 days)
 *   1 — one or more push-telegram runs landed inside the quiet window
 *   2 — missing config (DATABASE_URL unset)
 *
 * Required environment:
 *   DATABASE_URL    — full pg connection string for kos RDS Proxy
 *   KEVIN_OWNER_ID  — defaults to §13 constant
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/verify-quiet-hours-invariant.mjs
 */
import pg from 'pg';

const OWNER_ID = process.env.KEVIN_OWNER_ID ?? '9e4be978-cc7d-571b-98ec-a1e92373682c';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'verify-quiet-hours-invariant: DATABASE_URL not set. Provide a postgres connection string.',
  );
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const sql = `
  SELECT started_at,
         capture_id,
         EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Europe/Stockholm'))::int AS stockholm_hour
    FROM agent_runs
   WHERE owner_id = $1
     AND agent_name = 'push-telegram'
     AND status = 'ok'
     AND started_at >= now() - interval '14 days'
     AND (
          EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Europe/Stockholm'))::int >= 20
       OR EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Europe/Stockholm'))::int < 8
     )
   ORDER BY started_at DESC
`;

let exitCode = 0;
try {
  const { rows } = await pool.query(sql, [OWNER_ID]);
  if (rows.length > 0) {
    console.error(
      `Quiet-hours invariant VIOLATED: ${rows.length} push-telegram run(s) inside 20:00-08:00 Stockholm in the last 14 days:`,
    );
    for (const r of rows) {
      const at = r.started_at instanceof Date ? r.started_at.toISOString() : new Date(r.started_at).toISOString();
      console.error(
        `  ${at}  stockholm_hour=${r.stockholm_hour}  capture_id=${r.capture_id ?? '—'}`,
      );
    }
    exitCode = 1;
  } else {
    console.log('Quiet-hours invariant HOLDS (14 days; zero push-telegram runs in 20:00-08:00 Stockholm).');
  }
} finally {
  await pool.end();
}

process.exit(exitCode);
