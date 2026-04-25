/**
 * Shared indexer helpers: RDS pool + cursor table read/write.
 *
 * Each indexer service imports THIS file (not a shared workspace) because
 * path mappings through _shared stay simpler and each Lambda's bundle is
 * tiny anyway.
 */
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

let pool: Pool | null = null;
export async function getPool(): Promise<Pool> {
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

export async function readCursor(pool: Pool, key: string): Promise<Date | null> {
  const { rows } = await pool.query<{ last_seen_at: Date | null }>(
    `SELECT last_seen_at FROM azure_indexer_cursor WHERE key = $1`,
    [key],
  );
  return rows[0]?.last_seen_at ?? null;
}

export async function writeCursor(pool: Pool, key: string, at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO azure_indexer_cursor (key, last_seen_at, updated_at)
         VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE
        SET last_seen_at = EXCLUDED.last_seen_at,
            updated_at   = now()`,
    [key, at],
  );
}
