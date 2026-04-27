/**
 * Seed-pollution startup guard (Phase 11 Plan 11-01, D-04 option (b)).
 *
 * D-03 enumerated the seed names that pollute prod RDS — they were
 * inserted by a one-shot manual SQL session pre-Phase 11; repo-wide grep
 * confirms they appear in zero prod write paths. This guard blocks the
 * dashboard-api Lambda from serving traffic if any row with one of these
 * titles ever appears under owner_id=Kevin in `inbox_index`.
 *
 * Per CONTEXT D-04 ("mechanism Claude's discretion"), option (b) was
 * chosen over a CHECK constraint or migration flag because it is the
 * cheapest, fastest, fail-loud check at Lambda init: a single indexed
 * `SELECT 1 ... LIMIT 1` against the already-warm `inbox_index` table.
 *
 * Module-level cache (`cachedResult`) ensures only ONE probe runs per
 * warm Lambda container. Cold starts pay ~5ms; warm invocations pay zero.
 *
 * On polluted state: throws — handler in src/index.ts wraps and returns
 * HTTP 503 with body `{"error":"service_unavailable","detail":"seed_pollution"}`
 * so Sentry alerts can grep the literal `seed_pollution` token.
 */
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { OWNER_ID } from './owner-scoped.js';

/**
 * D-03 seed names. Order is locked — tests assert exact tuple equality.
 * Do not edit without bumping the test in seed-pollution-guard.test.ts
 * AND auditing scripts/phase-11-wipe-demo-rows.sql.
 */
export const SEED_NAMES = [
  'Damien Carter',
  'Christina Larsson',
  'Jan Eriksson',
  'Lars Svensson',
  'Almi Företagspartner',
  'Re: Partnership proposal',
  'Re: Summer meeting',
  'Possible duplicate: Damien C.',
  'Paused: Maria vs Maria Johansson',
  'Outbehaving angel investor',
] as const;

let cachedResult: 'clean' | 'polluted' | null = null;

/**
 * Asserts no seed-named row exists in inbox_index for owner_id=Kevin.
 *
 * - First call per cold-start: runs one indexed SELECT 1 ... LIMIT 1.
 * - Clean result is cached forever in this Lambda container — subsequent
 *   calls short-circuit without a DB hit.
 * - Polluted result is also cached — subsequent calls re-throw without
 *   re-querying (defense-in-depth: a transient network blip should not
 *   "heal" a pollution state).
 *
 * @throws Error('[dashboard-api] seed pollution detected — refusing to serve')
 *   when at least one seed-named row is present.
 */
export async function assertNoSeedPollution(): Promise<void> {
  if (cachedResult === 'clean') return;
  if (cachedResult === 'polluted') {
    throw new Error('[dashboard-api] seed pollution detected — refusing to serve');
  }
  const db = await getDb();
  // NOTE: drizzle's `sql` template tag binds array JS parameters as a
  // record/tuple, not a text[] — so `${[...NAMES]}::text[]` fails with
  // `cannot cast type record to text[]` (Postgres code 42846). Use `IN`
  // with sql.join over a per-element placeholder list instead, which
  // generates `title IN ($2, $3, ...)` and is natively supported.
  const r = (await db.execute(sql`
    SELECT 1 FROM inbox_index
    WHERE owner_id = ${OWNER_ID}::uuid
      AND title IN (${sql.join(
        SEED_NAMES.map((n) => sql`${n}`),
        sql`, `,
      )})
    LIMIT 1
  `)) as unknown as { rows: unknown[] };
  if (r.rows.length > 0) {
    cachedResult = 'polluted';
    console.error(
      '[dashboard-api] SEED POLLUTION DETECTED — purge required before re-enabling',
    );
    throw new Error('[dashboard-api] seed pollution detected — refusing to serve');
  }
  cachedResult = 'clean';
}

/**
 * Test-only: reset the cached result so tests can re-exercise the query
 * path. Production code never calls this.
 */
export function __resetSeedPollutionCacheForTests(): void {
  cachedResult = null;
}
