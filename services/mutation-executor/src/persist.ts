/**
 * Persistence helpers for the mutation-executor Lambda (Plan 08-04).
 *
 * Operates as DB role `kos_mutation_executor`:
 *   - SELECT pending_mutations (load row + validate authorization)
 *   - UPDATE pending_mutations.status / approved_at / executed_at /
 *     result / error
 *   - UPDATE calendar_events_cache.ignored_by_kevin (cancel_meeting)
 *   - UPDATE inbox_index.status / archived_at (delete_task)
 *   - UPDATE content_drafts.status (cancel_content_draft)
 *   - UPDATE email_drafts.status (cancel_email_draft)
 *
 * STRUCTURAL invariant — the DB role MUST NOT have any DELETE grant on
 * any table; archive-not-delete is enforced at the SQL grant layer too.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER ?? 'kos_mutation_executor';
  if (!host) throw new Error('RDS_PROXY_ENDPOINT not set');
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

export interface PendingMutationRow {
  id: string;
  owner_id: string;
  capture_id: string;
  mutation_type: string;
  target_kind: string;
  target_id: string;
  target_display: string;
  confidence: number;
  status: string;
  alternatives: Array<{ kind: string; id: string; display: string; confidence: number }>;
}

/**
 * Load the row for execution. Returns null if the row is missing or
 * already in a terminal state (executed/failed/skipped) — the executor
 * treats those as no-ops to keep the apply path idempotent.
 *
 * In Plan 08-04 the authorization model is: the dashboard route flips
 * pending_mutations.status='approved' BEFORE emitting
 * pending_mutation.approved. The executor sees status='approved' and
 * proceeds; the row's `approved_at` timestamp + capture_id form the
 * audit trail.
 */
export async function loadPendingMutationForExecute(
  pool: PgPool,
  mutationId: string,
  ownerId: string,
): Promise<PendingMutationRow | null> {
  const r = await pool.query(
    `SELECT id::text             AS id,
            owner_id::text       AS owner_id,
            capture_id           AS capture_id,
            mutation_type        AS mutation_type,
            target_kind          AS target_kind,
            target_id            AS target_id,
            target_display       AS target_display,
            confidence::float    AS confidence,
            status               AS status,
            alternatives         AS alternatives
       FROM pending_mutations
      WHERE id = $1::uuid AND owner_id = $2`,
    [mutationId, ownerId],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as PendingMutationRow;
  if (row.status === 'executed' || row.status === 'failed' || row.status === 'skipped') {
    return null;
  }
  return row;
}

export async function markExecuted(
  pool: PgPool,
  mutationId: string,
  result: 'archived' | 'rescheduled' | 'no_op',
): Promise<void> {
  await pool.query(
    `UPDATE pending_mutations
        SET status = 'executed',
            executed_at = now(),
            result = $2
      WHERE id = $1::uuid`,
    [mutationId, result],
  );
}

export async function markFailed(
  pool: PgPool,
  mutationId: string,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE pending_mutations
        SET status = 'failed',
            executed_at = now(),
            error = $2
      WHERE id = $1::uuid`,
    [mutationId, error.slice(0, 1000)],
  );
}

/** Test-only helper: reset module-scope pool. */
export function __resetPoolForTests(): void {
  pool = null;
}
