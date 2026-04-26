/**
 * content-writer persist (AGT-07 orchestrator) — pool helpers used to short-
 * circuit Step Functions invocation when a topic has already been drafted
 * (Plan 08-02 Task 1, Test 4).
 *
 * Pool config mirrors services/triage/src/persist.ts and
 * services/email-triage/src/persist.ts:
 *   - max=2 connections
 *   - per-connection IAM auth token via @aws-sdk/rds-signer
 *   - module-scope cache (warm Lambdas reuse the pool)
 *
 * The orchestrator only ever READS from content_drafts (the per-platform
 * worker writes). The CDK grant therefore needs nothing more than
 * `rds-db:connect` as `kos_content_writer_orchestrator` plus DB-side
 * `GRANT SELECT ON content_drafts` (issued out-of-band by operator
 * runbook).
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
  const database = process.env.RDS_DATABASE ?? 'kos';
  const signer = new Signer({ hostname: host, port: 5432, region, username: user });
  pool = new Pool({
    host,
    port: 5432,
    user,
    database,
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

/**
 * Test-only helper: reset the module-scope pool between tests so a fresh
 * Signer is constructed (mirrors __resetPoolForTests in other services).
 */
export function __resetPoolForTests(): void {
  pool = null;
}

/** Minimal pool-shape so tests can inject a stub query() without pg. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rowCount?: number | null; rows?: unknown[] }>;
}

/**
 * Idempotency pre-check (Plan 08-02 Task 1 Test 4): returns true iff there
 * is at least one content_drafts row for (topic_id, owner_id). When true,
 * the orchestrator short-circuits Step Functions and returns
 * { skipped: 'already_drafted' } so duplicate content.topic_submitted events
 * never re-issue 5 Bedrock calls.
 *
 * Owner_id filter keeps the multi-tenant hygiene (D-13) intact even though
 * KOS is single-user today.
 */
export async function alreadyDrafted(
  poolArg: PgPoolLike,
  topicId: string,
  ownerId: string,
): Promise<boolean> {
  const r = await poolArg.query(
    `SELECT 1 FROM content_drafts
       WHERE topic_id = $1 AND owner_id = $2
       LIMIT 1`,
    [topicId, ownerId],
  );
  return (r.rowCount ?? 0) > 0;
}
