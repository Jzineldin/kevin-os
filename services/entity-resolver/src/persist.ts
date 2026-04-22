/**
 * Entity-resolver persist — RDS Proxy IAM-auth pool + agent_runs idempotency
 * helpers (D-21) + mention_events writer + entity_merge audit row writer.
 *
 * Intentional copy of services/voice-capture/src/persist.ts (Plan 02-04
 * adopted copy-over-extract while in Wave 1; consolidation to a shared
 * @kos/persist package lands in Phase 6+). Adds the entity-resolver-specific
 * helpers `insertMentionEvent`, `writeMergeAuditRow`, `getCaptureProjectIds`.
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

// --- Plan 02-05: entity-resolver-specific writers ------------------------

export interface InsertMentionEventInput {
  ownerId: string;
  entityId: string | null;
  captureId: string;
  source: string;
  context: string;
  occurredAt: Date;
}

export async function insertMentionEvent(row: InsertMentionEventInput): Promise<string> {
  const p = await getPool();
  const r = await p.query(
    `INSERT INTO mention_events (owner_id, entity_id, capture_id, source, context, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [row.ownerId, row.entityId, row.captureId, row.source, row.context, row.occurredAt],
  );
  return r.rows[0].id as string;
}

/**
 * Writes an audit row for an entity_merge action with a deliberately distinct
 * agent_name ('entity-resolver.merge') so analytics queries can separate
 * merge-audit rows from primary `entity-resolver:<mention>` runs.
 */
export interface WriteMergeAuditRowInput {
  ownerId: string;
  captureId: string;
  sourceEntityId: string | null;
  targetEntityId: string;
  score: number;
  secondarySignal: 'project_cooccurrence' | 'none';
}

export async function writeMergeAuditRow(row: WriteMergeAuditRowInput): Promise<void> {
  const p = await getPool();
  await p.query(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status, output_json)
       VALUES ($1, $2, 'entity-resolver.merge', 'ok', $3)`,
    [
      row.ownerId,
      row.captureId,
      JSON.stringify({
        action: 'entity_merge',
        source_entity_id: row.sourceEntityId,
        target_entity_id: row.targetEntityId,
        score: row.score,
        secondary_signal: row.secondarySignal,
      }),
    ],
  );
}

/** Look up any Project entities already resolved for this capture via mention_events. */
export async function getCaptureProjectIds(ownerId: string, captureId: string): Promise<string[]> {
  const p = await getPool();
  const r = await p.query(
    `SELECT DISTINCT e.id FROM mention_events m
       JOIN entity_index e ON e.id = m.entity_id
       WHERE m.owner_id = $1 AND m.capture_id = $2 AND e.type = 'Project'`,
    [ownerId, captureId],
  );
  return r.rows.map((x) => String(x.id));
}

/** Test-only helper: reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
