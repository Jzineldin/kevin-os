/**
 * @kos/service-entity-timeline-refresher — Phase 6 MEM-04.
 *
 * EventBridge Scheduler every 5 min (Europe/Stockholm). Calls
 * `refresh_entity_timeline()` SECURITY DEFINER function, which issues a
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline`. Logs elapsed
 * time and row delta for observability.
 *
 * Spec: .planning/phases/06-granola-semantic-memory/06-04-PLAN.md
 * Migration: 0012 — refresh_entity_timeline() + uniq_entity_timeline_event
 */
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';

let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const host = process.env.DATABASE_HOST;
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const database = process.env.DATABASE_NAME ?? 'kos';
  const user = process.env.DATABASE_USER ?? 'kos_agent_writer';
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  if (!host) throw new Error('DATABASE_HOST env var not set');
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

export const handler = wrapHandler(async (): Promise<{
  elapsed_ms: number;
  row_count: number;
}> => {
  await initSentry();
  tagTraceWithCaptureId(`entity-timeline-refresher-${new Date().toISOString()}`);

  const started = Date.now();
  const p = await getPool();

  await p.query(`SELECT refresh_entity_timeline()`);
  const { rows } = await p.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM entity_timeline`,
  );

  return {
    elapsed_ms: Date.now() - started,
    row_count: Number(rows[0]?.count ?? '0'),
  };
});
