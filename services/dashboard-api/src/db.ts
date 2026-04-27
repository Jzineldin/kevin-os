/**
 * Module-level Drizzle + pg.Pool cache.
 *
 * One pool per warm Lambda instance (Lambda best practice for RDS
 * connections behind RDS Proxy). IAM auth tokens are regenerated on every
 * new connection open via `@aws-sdk/rds-signer`; tokens are valid 15
 * minutes and `pg.Pool` calls the `password` function on each checkout,
 * so rotation is handled automatically.
 *
 * RESEARCH §7 lines 782-807 is the canonical pattern.
 *
 * ENV VARS (injected at deploy time by Plan 05 CDK):
 *  - RDS_PROXY_ENDPOINT: e.g. `kos-rds-proxy.proxy-xxxx.eu-north-1.rds.amazonaws.com`
 *  - AWS_REGION: `eu-north-1` (automatic in Lambda runtime)
 *  - PG_DATABASE: defaults to `kos`
 *  - PG_USER: defaults to `dashboard_api`
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

let pool: pg.Pool | null = null;
let db: NodePgDatabase | null = null;

export async function getDb(): Promise<NodePgDatabase> {
  if (db) return db;

  const endpoint = process.env.RDS_PROXY_ENDPOINT;
  if (!endpoint) {
    throw new Error('[dashboard-api] RDS_PROXY_ENDPOINT env var is required');
  }

  const user = process.env.PG_USER ?? 'dashboard_api';
  const database = process.env.PG_DATABASE ?? 'kos';
  const region = process.env.AWS_REGION ?? 'eu-north-1';

  const signer = new Signer({
    hostname: endpoint,
    port: 5432,
    username: user,
    region,
  });

  pool = new pg.Pool({
    host: endpoint,
    port: 5432,
    user,
    database,
    ssl: { rejectUnauthorized: true },
    max: 5, // Lambda concurrency × 5 × 1.2 must stay under RDS Proxy target-conns
    // pg.Pool calls this on every new connection open; Signer mints a fresh
    // 15-min IAM token each time. No manual rotation needed.
    password: async () => signer.getAuthToken(),
  });

  db = drizzle(pool);
  return db;
}

/**
 * Raw pg.Pool accessor — used by callers that need to pass a PgPool into
 * @kos/context-loader or other helpers written against `pg.Pool`. Reuses
 * the same warm pool as getDb(); triggers pool creation if needed.
 */
export async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;
  await getDb(); // side-effect: creates pool
  if (!pool) throw new Error('[dashboard-api] pool unexpectedly null after init');
  return pool;
}

/**
 * Test seam — let Vitest inject a prebuilt Drizzle instance (or null to
 * force a cold re-init). Production code never calls this.
 */
export function __setDbForTest(instance: NodePgDatabase | null): void {
  db = instance;
}
