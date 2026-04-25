/**
 * Phase 7 Plan 07-02 — day-close persistence layer.
 *
 * RDS Proxy IAM-auth pool (mirrors services/morning-brief/src/persist.ts).
 * Helpers cover:
 *   - agent_runs idempotency claim (insertAgentRunStarted) — SELECT-before-
 *     INSERT pattern; agent_runs lacks a (capture_id, agent_name) UNIQUE
 *     constraint so we can't rely on ON CONFLICT.
 *   - agent_runs status=ok / error close-out.
 *   - top3_membership fan-out — DayCloseBriefSchema HAS top_three (D-05).
 *   - loadHotEntities — top N entities by mention_events count in last N
 *     hours (D-17 day-close uses 12h interval).
 *   - loadSlippedItemsForToday — query top3_membership rows from this
 *     morning's brief that have NULL acted_on_at.
 *   - loadDecisionsHint — best-effort regex over recent mention_events.context
 *     looking for "decided|approved|signed|agreed|godkänd|beslutad". The
 *     mention_events column is `context` (per migration 0001), NOT
 *     `text_content` as some plan drafts hinted.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { DayCloseBrief } from '@kos/contracts';

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
 * D-09 + D-21 idempotency claim.
 * Returns true on first call; false if a prior `ok` row already exists.
 * SELECT-before-INSERT (no UNIQUE constraint exists on the table).
 */
export async function insertAgentRunStarted(
  pool: PgPool,
  args: { captureId: string; ownerId: string; agentName: 'day-close' },
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
      WHERE capture_id = $1 AND agent_name = 'day-close'`,
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
      WHERE capture_id = $1 AND agent_name = 'day-close'`,
    [captureId, err.message ? err.message.slice(0, 1000) : String(err)],
  );
}

/**
 * D-06: fan-out one row per (top_three[i].entity_ids[j]) pair so the
 * dropped_threads_v view can detect entities that landed in a Top 3 but
 * received no follow-up mention within 24h. Identical shape to the
 * morning-brief writer; brief_kind='day-close' here.
 */
export async function writeTop3Membership(
  pool: PgPool,
  args: {
    ownerId: string;
    captureId: string;
    briefDateStockholm: string;
    briefKind: 'morning-brief' | 'day-close' | 'weekly-review';
    topThree: DayCloseBrief['top_three'];
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

export interface HotEntityRow {
  entity_id: string;
  name: string;
  mention_count: number;
}

/**
 * D-17 day-close hot entities — top N by 12h mention_events count. Distinct
 * from morning-brief's 48h interval (day-close cares about *today*).
 */
export async function loadHotEntities(
  pool: PgPool,
  ownerId: string,
  hoursBack: number,
  limit: number,
): Promise<HotEntityRow[]> {
  const r = await pool.query(
    `SELECT me.entity_id, ei.name, count(*) AS mention_count
       FROM mention_events me
       JOIN entity_index ei ON ei.id = me.entity_id
      WHERE me.owner_id = $1
        AND me.entity_id IS NOT NULL
        AND me.occurred_at > now() - ($2::int * interval '1 hour')
      GROUP BY me.entity_id, ei.name
      ORDER BY count(*) DESC
      LIMIT $3`,
    [ownerId, hoursBack, limit],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    entity_id: String(row.entity_id),
    name: String(row.name),
    mention_count: Number(row.mention_count),
  }));
}

export interface SlippedItemRow {
  entity_id: string;
  title: string;
  urgency: 'high' | 'med' | 'low';
}

/**
 * Slipped items = morning-brief Top 3 entries that have not been "acted on"
 * by 18:00 (acted_on_at flipped by the mention_events trigger from migration
 * 0014 when a new mention arrives for the same entity).
 *
 * We filter on brief_kind='morning-brief' explicitly so day-close's own
 * top3_membership rows (written later in the same handler invocation) don't
 * appear here.
 */
export async function loadSlippedItemsForToday(
  pool: PgPool,
  ownerId: string,
  dateStockholm: string,
): Promise<SlippedItemRow[]> {
  const r = await pool.query(
    `SELECT entity_id, top3_title AS title, urgency
       FROM top3_membership
      WHERE owner_id = $1
        AND brief_kind = 'morning-brief'
        AND brief_date = $2::date
        AND acted_on_at IS NULL`,
    [ownerId, dateStockholm],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    entity_id: String(row.entity_id),
    title: String(row.title),
    urgency: row.urgency as 'high' | 'med' | 'low',
  }));
}

export interface DecisionHintRow {
  occurred_at: string;
  context: string;
}

/**
 * Best-effort regex over mention_events.context for the last 12h. The
 * `context` column on mention_events stores the surrounding text snippet
 * (per migration 0001). Matches Swedish + English decision verbs.
 *
 * If the table is empty for the window we return [] — handler renders a
 * placeholder hint and Sonnet infers from broader context.
 */
export async function loadDecisionsHint(
  pool: PgPool,
  ownerId: string,
): Promise<DecisionHintRow[]> {
  const r = await pool.query(
    `SELECT occurred_at, context
       FROM mention_events
      WHERE owner_id = $1
        AND occurred_at > now() - interval '12 hours'
        AND context ~* '(decided|approved|signed|agreed|godkänd|beslutad)'
      ORDER BY occurred_at DESC
      LIMIT 10`,
    [ownerId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    occurred_at: row.occurred_at
      ? new Date(row.occurred_at as string | number | Date).toISOString()
      : '',
    context: String(row.context ?? ''),
  }));
}

/** Test-only helper to reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
