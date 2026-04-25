/**
 * Granola-poller persist layer (Plan 06-01).
 *
 * Mirrors services/triage/src/persist.ts (RDS Proxy IAM-auth pool +
 * agent_runs idempotency) and adds a single PutEvents helper for
 * `transcript.available` on `kos.capture`.
 *
 * Idempotency contract (D-03 / D-21): `capture_id = transcript_id`
 * (Notion page id) + `agent_name = 'granola-poller'`.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { TranscriptAvailable } from '@kos/contracts/context';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT ?? process.env.DATABASE_HOST;
  const user = process.env.RDS_IAM_USER ?? process.env.DATABASE_USER ?? 'kos_admin';
  if (!host) throw new Error('RDS_PROXY_ENDPOINT (or DATABASE_HOST) not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const signer = new Signer({ hostname: host, port, region, username: user });
  pool = new Pool({
    host,
    port,
    user,
    database: process.env.DATABASE_NAME ?? 'kos',
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
  const r = await p.query<{ id: string }>(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [row.ownerId, row.captureId, row.agentName, row.status],
  );
  return r.rows[0]!.id;
}

export interface UpdateAgentRunPatch {
  status: AgentRunStatus;
  outputJson?: unknown;
  errorMessage?: string;
}

export async function updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void> {
  const p = await getPool();
  await p.query(
    `UPDATE agent_runs
        SET status = $2,
            output_json = $3,
            error_message = $4,
            finished_at = NOW()
      WHERE id = $1`,
    [id, patch.status, patch.outputJson ?? null, patch.errorMessage ?? null],
  );
}

// ---------------------------------------------------------------------------
// EventBridge: kos.capture / transcript.available (D-04)
// ---------------------------------------------------------------------------

let ebClient: EventBridgeClient | null = null;
function getEventBridge(): EventBridgeClient {
  if (!ebClient) ebClient = new EventBridgeClient({});
  return ebClient;
}

const SOURCE = 'kos.capture';
const DETAIL_TYPE = 'transcript.available';

export async function publishTranscriptAvailable(detail: TranscriptAvailable): Promise<void> {
  const busName = process.env.KOS_CAPTURE_BUS_NAME;
  if (!busName) throw new Error('KOS_CAPTURE_BUS_NAME not set');
  await getEventBridge().send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: SOURCE,
          DetailType: DETAIL_TYPE,
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
}

/** Test-only helper: reset the module-scope pool + EB client between tests. */
export function __resetForTests(): void {
  pool = null;
  ebClient = null;
}
