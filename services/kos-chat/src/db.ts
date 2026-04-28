/**
 * kos-chat database module.
 *
 * IAM auth pattern: ALWAYS use `password: async () => signer.getAuthToken()`
 * — never a captured string. Tokens expire after 15 min; a captured string
 * causes 100% failure on every invocation past the 15-min warmth boundary
 * (live-discovered in notion-indexer 2026-04-26, documented in kos-rds-ops SKILL).
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

/** Kevin canonical owner_id — hardcoded fallback per AGENTS.md. */
export const OWNER_ID =
  process.env.KEVIN_OWNER_ID ?? '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';

let pool: pg.Pool | null = null;
let db: NodePgDatabase | null = null;

export async function getDb(): Promise<NodePgDatabase> {
  if (db) return db;

  const endpoint = process.env.RDS_PROXY_ENDPOINT;
  if (!endpoint) throw new Error('[kos-chat] RDS_PROXY_ENDPOINT env var is required');

  const user = process.env.PG_USER ?? 'kos_chat';
  const database = process.env.PG_DATABASE ?? 'kos';
  const region = process.env.AWS_REGION ?? 'eu-north-1';

  const signer = new Signer({ hostname: endpoint, port: 5432, username: user, region });

  pool = new pg.Pool({
    host: endpoint,
    port: 5432,
    user,
    database,
    ssl: { rejectUnauthorized: true },
    max: 5,
    // Fresh IAM token per connection — never a captured string.
    password: async () => signer.getAuthToken(),
  });

  db = drizzle(pool);
  return db;
}

export async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;
  await getDb();
  if (!pool) throw new Error('[kos-chat] pool unexpectedly null after init');
  return pool;
}

/** Test seam — inject prebuilt instance. Never call in production. */
export function __setDbForTest(instance: NodePgDatabase | null): void {
  db = instance;
}
