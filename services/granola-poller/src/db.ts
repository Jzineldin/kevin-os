/**
 * RDS Proxy IAM-auth pg Pool — mirrors services/triage/src/persist.ts.
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
