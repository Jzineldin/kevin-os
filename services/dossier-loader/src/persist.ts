/**
 * RDS pool + cache write for dossier-loader. Mirrors the pattern from
 * @kos/context-loader/src/cache.ts but with the `gemini-full:` prefix
 * convention baked in.
 */
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { ContextBundle } from '@kos/contracts/context';

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

export async function writeDossierCache(opts: {
  pool: Pool;
  ownerId: string;
  entityId: string;
  lastTouchHash: string;
  bundle: ContextBundle;
  ttlSeconds?: number;
}): Promise<void> {
  const { pool, ownerId, entityId, lastTouchHash, bundle, ttlSeconds = 3600 } = opts;
  await pool.query(
    `INSERT INTO entity_dossiers_cached
           (entity_id, owner_id, last_touch_hash, bundle, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)
      ON CONFLICT (entity_id, owner_id) DO UPDATE
         SET last_touch_hash = EXCLUDED.last_touch_hash,
             bundle          = EXCLUDED.bundle,
             expires_at      = EXCLUDED.expires_at`,
    [entityId, ownerId, lastTouchHash, JSON.stringify(bundle), ttlSeconds],
  );
}
