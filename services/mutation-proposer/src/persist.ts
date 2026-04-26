/**
 * Persistence helpers for the mutation-proposer Lambda (Plan 08-04).
 *
 * Operates as DB role `kos_mutation_proposer`:
 *   - SELECT entity_index, calendar_events_cache, content_drafts,
 *            email_drafts, command_center_index/inbox_index
 *   - INSERT pending_mutations
 *   - SELECT/INSERT/UPDATE agent_runs (idempotency + audit)
 *
 * Mirrors services/voice-capture/src/persist.ts at the IAM-auth + Pool
 * pattern level.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER ?? 'kos_mutation_proposer';
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

export type AgentRunStatus = 'started' | 'ok' | 'error';

export async function findPriorOkRun(
  captureId: string,
  agentName: string,
  ownerId: string,
): Promise<boolean> {
  const p = await getPool();
  const r = await p.query(
    `SELECT 1 FROM agent_runs
       WHERE owner_id = $1 AND capture_id = $2 AND agent_name = $3 AND status = 'ok'
       LIMIT 1`,
    [ownerId, captureId, agentName],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface InsertAgentRunInput {
  ownerId: string;
  captureId: string;
  agentName: string;
  status: AgentRunStatus;
}

export async function insertAgentRun(row: InsertAgentRunInput): Promise<string> {
  const p = await getPool();
  const r = await p.query(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [row.ownerId, row.captureId, row.agentName, row.status],
  );
  return r.rows[0].id as string;
}

export interface UpdateAgentRunPatch {
  status: AgentRunStatus;
  outputJson?: unknown;
  tokensInput?: number;
  tokensOutput?: number;
  errorMessage?: string;
}

export async function updateAgentRun(
  id: string,
  patch: UpdateAgentRunPatch,
): Promise<void> {
  const p = await getPool();
  await p.query(
    `UPDATE agent_runs
        SET status = $2,
            output_json = $3,
            tokens_input = $4,
            tokens_output = $5,
            error_message = $6,
            finished_at = NOW()
      WHERE id = $1`,
    [
      id,
      patch.status,
      patch.outputJson ?? null,
      patch.tokensInput ?? null,
      patch.tokensOutput ?? null,
      patch.errorMessage ?? null,
    ],
  );
}

export interface InsertPendingMutationInput {
  id: string;
  ownerId: string;
  captureId: string;
  mutationType: string;
  targetKind: string;
  targetId: string;
  targetDisplay: string;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ kind: string; id: string; display: string; confidence: number }>;
}

/**
 * INSERT a row into pending_mutations with status='proposed'.
 *
 * Idempotency: We check (capture_id, mutation_type) first — same capture
 * proposing the same mutation type collapses to one row. The natural
 * UNIQUE in migration 0020 is on the row id only, so this enforces the
 * higher-level invariant in code.
 */
export async function insertPendingMutation(
  pool: PgPool,
  input: InsertPendingMutationInput,
): Promise<{ id: string; alreadyExists: boolean }> {
  const existing = await pool.query(
    `SELECT id::text AS id FROM pending_mutations
       WHERE owner_id = $1 AND capture_id = $2 AND mutation_type = $3
       LIMIT 1`,
    [input.ownerId, input.captureId, input.mutationType],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return { id: existing.rows[0].id as string, alreadyExists: true };
  }
  await pool.query(
    `INSERT INTO pending_mutations
        (id, owner_id, capture_id, mutation_type, target_kind, target_id,
         target_display, confidence, reasoning, alternatives, status, proposed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'proposed', now())`,
    [
      input.id,
      input.ownerId,
      input.captureId,
      input.mutationType,
      input.targetKind,
      input.targetId,
      input.targetDisplay,
      input.confidence.toFixed(3),
      input.reasoning,
      JSON.stringify(input.alternatives),
    ],
  );
  return { id: input.id, alreadyExists: false };
}

/** Test-only helper: reset module-scope pool. */
export function __resetPoolForTests(): void {
  pool = null;
}
