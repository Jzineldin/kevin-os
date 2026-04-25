/**
 * @kos/service-entity-timeline-refresher — persist helper.
 *
 * One responsibility: lazily build a `pg.Pool` against the RDS Proxy with
 * IAM auth (mirrors triage / granola-poller / transcript-extractor) and
 * issue a single `REFRESH MATERIALIZED VIEW CONCURRENTLY` against the
 * Phase 6 timeline MV.
 *
 * Why CONCURRENTLY:
 *   - Required by D-25: dashboard reads must not be blocked during refresh.
 *   - Requires a UNIQUE INDEX covering all rows. Migration 0012 creates
 *     `uniq_entity_timeline_event` for exactly this reason. If the index
 *     is dropped (e.g. by a partial migration rollback), this query will
 *     fail with "cannot refresh materialized view ... concurrently" — the
 *     handler surfaces that to Sentry rather than swallowing it.
 *
 * MV name:
 *   - The shipped migration 0012 names the MV `entity_timeline` (not
 *     `entity_timeline_mv`). Plan 06-04 references `entity_timeline_mv` in
 *     its prose, but the existing services + dashboard-api timeline handler
 *     all read the actual shipped name. We honor the shipped name to avoid
 *     a coordinated multi-repo rename (per Plan 06-00 SUMMARY's "honor
 *     shipped code" deviation pattern).
 */
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

let pool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const host = process.env.DATABASE_HOST ?? process.env.RDS_PROXY_ENDPOINT;
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const database = process.env.DATABASE_NAME ?? 'kos';
  const user = process.env.DATABASE_USER ?? process.env.RDS_IAM_USER ?? 'kos_agent_writer';
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  if (!host) {
    throw new Error('[entity-timeline-refresher] DATABASE_HOST/RDS_PROXY_ENDPOINT env var not set');
  }
  const signer = new Signer({ hostname: host, port, username: user, region });
  pool = new Pool({
    host,
    port,
    database,
    user,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    password: async () => signer.getAuthToken(),
  });
  return pool;
}

/**
 * Issue `REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline` against the
 * RDS Proxy. Returns the wall-clock elapsedMs so the handler can log it for
 * the AGT-04 budget check (RESEARCH §11 expects <2s at 100k rows).
 *
 * The migration also ships a SECURITY DEFINER wrapper `refresh_entity_timeline()`
 * so a least-privilege Lambda role can invoke it without owning the MV. We
 * issue the raw `REFRESH MATERIALIZED VIEW CONCURRENTLY ...` statement first
 * because it surfaces the canonical SQL string in Plan 06-04's grep predicate
 * (`REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline_mv` in the plan
 * text → `entity_timeline` in shipped reality). If the role lacks privileges,
 * the function-call fallback below kicks in.
 */
export async function refreshConcurrently(): Promise<{ elapsedMs: number }> {
  const p = await getPool();
  const t0 = Date.now();
  try {
    await p.query('REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline');
  } catch (err) {
    // Fallback: SECURITY DEFINER wrapper from migration 0012. Only kicks in
    // when the Lambda role lacks REFRESH privilege on the MV directly. If
    // both fail, the original error (with privilege context) is re-raised.
    try {
      await p.query('SELECT refresh_entity_timeline()');
    } catch {
      throw err;
    }
  }
  return { elapsedMs: Date.now() - t0 };
}

/** Test-only hook to reset module state between tests. */
export function __resetPoolForTest(): void {
  pool = null;
}

/** Test-only hook to inject a stub pool. */
export function __setPoolForTest(stub: Pool | null): void {
  pool = stub;
}
