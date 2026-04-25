/**
 * Phase 7 Plan 07-04 — RDS Proxy IAM-auth pool for verify-notification-cap.
 *
 * Mirrors the pattern from services/morning-brief/src/persist.ts (and triage,
 * day-close, weekly-review). Module-scope singleton; lazily initialised on
 * first call. The Lambda runs read-only SELECTs via this pool — the IAM
 * policy is `rds-db:connect` on `kos_admin` (D-12). All queries are SELECT-
 * only by construction; no writes from this service.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER;
  if (!host) throw new Error('RDS_PROXY_ENDPOINT not set');
  if (!user) throw new Error('RDS_IAM_USER not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const signer = new Signer({ hostname: host, port: 5432, region, username: user });
  pool = new Pool({
    host,
    port: 5432,
    user,
    database: process.env.RDS_DATABASE ?? 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

/** Test-only helper to reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
