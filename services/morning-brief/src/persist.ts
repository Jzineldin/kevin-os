/**
 * Phase 7 Plan 07-01 — morning-brief persistence layer.
 *
 * RDS Proxy IAM-auth pool (pattern from services/triage/src/persist.ts).
 * Helpers cover:
 *   - agent_runs idempotency claim (insertAgentRunStarted) — SELECT-before-
 *     INSERT pattern; agent_runs lacks a (capture_id, agent_name) UNIQUE
 *     constraint so we can't rely on ON CONFLICT.
 *   - agent_runs status=ok / error close-out (mirrors triage/persist.ts).
 *   - top3_membership fan-out (one row per top_three[i].entity_ids[j] pair).
 *   - loadDraftsReady — graceful Phase-4 degradation: returns [] when
 *     email_drafts table is missing (pg error code 42P01).
 *   - loadDroppedThreads — read-through view dropped_threads_v.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { MorningBrief } from '@kos/contracts';

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

export type AgentRunStatus = 'started' | 'ok' | 'error';

/**
 * D-09 + D-21 idempotency claim. Returns:
 *   - true  → no prior run; INSERT happened, caller owns this brief run.
 *   - false → a prior `ok` row exists for (owner, capture, agent); caller
 *             MUST short-circuit (skipped: 'duplicate').
 *
 * Implemented as SELECT-before-INSERT (no UNIQUE constraint on the table).
 * On race, two cold-starts could both see "no prior" and both INSERT — the
 * pair is harmless because EventBridge Scheduler only fires the morning
 * brief once per cron tick, and the brief lambda is timeout-bounded
 * (10 min). The downstream Notion writes are idempotent enough (replace-
 * in-place); the second run would simply produce a duplicate output.push
 * which the cap consumer rate-limits.
 */
export async function insertAgentRunStarted(
  pool: PgPool,
  args: { captureId: string; ownerId: string; agentName: 'morning-brief' },
): Promise<boolean> {
  const prior = await pool.query(
    `SELECT 1 FROM agent_runs
       WHERE owner_id = $1 AND capture_id = $2 AND agent_name = $3 AND status = 'ok'
       LIMIT 1`,
    [args.ownerId, args.captureId, args.agentName],
  );
  if ((prior.rowCount ?? 0) > 0) return false;
  await pool.query(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status, started_at)
       VALUES ($1, $2, $3, 'started', now())`,
    [args.ownerId, args.captureId, args.agentName],
  );
  return true;
}

export async function updateAgentRunSuccess(
  pool: PgPool,
  captureId: string,
  output: unknown,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number },
): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
        SET status = 'ok',
            output_json = $2,
            tokens_input = $3,
            tokens_output = $4,
            finished_at = now()
      WHERE capture_id = $1 AND agent_name = 'morning-brief'`,
    [captureId, output ?? null, usage.inputTokens ?? null, usage.outputTokens ?? null],
  );
}

export async function updateAgentRunError(
  pool: PgPool,
  captureId: string,
  err: Error,
): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
        SET status = 'error',
            error_message = $2,
            finished_at = now()
      WHERE capture_id = $1 AND agent_name = 'morning-brief'`,
    [captureId, err.message ? err.message.slice(0, 1000) : String(err)],
  );
}

/**
 * D-06: fan-out one row per (top_three[i].entity_ids[j]) pair so the
 * dropped_threads_v view (Phase 6 migration 0014) can detect entities that
 * landed in a Top 3 but received no follow-up mention within 24h.
 */
export async function writeTop3Membership(
  pool: PgPool,
  args: {
    ownerId: string;
    captureId: string;
    briefDateStockholm: string;
    briefKind: 'morning-brief' | 'day-close' | 'weekly-review';
    topThree: MorningBrief['top_three'];
  },
): Promise<void> {
  for (const item of args.topThree) {
    for (const entityId of item.entity_ids) {
      await pool.query(
        `INSERT INTO top3_membership
           (owner_id, brief_date, brief_kind, brief_capture_id, entity_id, top3_title, urgency)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7)`,
        [
          args.ownerId,
          args.briefDateStockholm,
          args.briefKind,
          args.captureId,
          entityId,
          item.title,
          item.urgency,
        ],
      );
    }
  }
}

export interface DraftReadyRow {
  draft_id: string;
  from: string;
  subject: string;
  classification: 'urgent' | 'important';
}

/**
 * Phase 4 dependency. email_drafts may not exist yet at deploy time of
 * Phase 7 — we degrade gracefully (return []) on relation-missing errors
 * (postgres SQLSTATE 42P01). Once Phase 4 ships its schema, this query
 * will return real rows without code changes.
 */
export async function loadDraftsReady(
  pool: PgPool,
  ownerId: string,
  limit: number,
): Promise<DraftReadyRow[]> {
  try {
    const r = await pool.query(
      `SELECT id AS draft_id, from_email AS "from", subject, classification
         FROM email_drafts
        WHERE owner_id = $1
          AND status IN ('draft','edited')
          AND classification IN ('urgent','important')
        ORDER BY received_at DESC
        LIMIT $2`,
      [ownerId, limit],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      draft_id: String(x.draft_id),
      from: String(x.from),
      subject: String(x.subject),
      classification: x.classification as 'urgent' | 'important',
    }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01') {
      // email_drafts table missing — Phase 4 hasn't shipped yet.
      return [];
    }
    throw err;
  }
}

export interface DroppedThreadRow {
  title: string;
  entity_ids: string[];
  last_mentioned_at: string | null;
}

export async function loadDroppedThreads(
  pool: PgPool,
  ownerId: string,
): Promise<DroppedThreadRow[]> {
  const r = await pool.query(
    `SELECT entity_id, title, last_mentioned_at
       FROM dropped_threads_v
      WHERE owner_id = $1
      ORDER BY last_mentioned_at DESC NULLS LAST
      LIMIT 5`,
    [ownerId],
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    title: String(x.title),
    entity_ids: [String(x.entity_id)],
    last_mentioned_at: x.last_mentioned_at
      ? new Date(x.last_mentioned_at as string | number | Date).toISOString()
      : null,
  }));
}

/** Test-only helper to reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
