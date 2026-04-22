/**
 * Triage persist — RDS Proxy IAM-auth Postgres pool + agent_runs idempotency
 * helpers (D-21).
 *
 * Pool config follows Phase 1 notion-indexer pattern: max=2 connections,
 * password is a per-connection IAM auth token signed via @aws-sdk/rds-signer.
 * Module-scope cache (Pitfall 11) — warm Lambdas reuse the pool across
 * invocations.
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
    database: 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

export type AgentRunStatus = 'started' | 'ok' | 'error';

/**
 * D-21 idempotency check. Returns true if there is already an `ok` agent_runs
 * row for this (capture_id, agent_name, owner_id) tuple.
 */
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

export async function updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void> {
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

/**
 * Render Kevin Context as a single string suitable for prompt injection
 * (cached as part of the system prompt). Sections sorted by heading for
 * cache stability — random ordering would invalidate the prompt cache on
 * every invocation.
 */
export async function loadKevinContextBlock(ownerId: string): Promise<string> {
  const p = await getPool();
  const r = await p.query(
    `SELECT section_heading, section_body
       FROM kevin_context
       WHERE owner_id = $1
       ORDER BY section_heading`,
    [ownerId],
  );
  return r.rows
    .map((x) => `## ${x.section_heading}\n${x.section_body}`)
    .join('\n\n');
}

/** Test-only helper: reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
