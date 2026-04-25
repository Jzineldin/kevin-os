/**
 * Phase 7 Plan 07-02 — weekly-review persistence layer.
 *
 * RDS Proxy IAM-auth pool. Same shape as morning-brief / day-close persist
 * but NO writeTop3Membership — WeeklyReviewSchema has no top_three field
 * (D-05).
 *
 * Helpers:
 *   - agent_runs idempotency claim (insertAgentRunStarted)
 *   - agent_runs success / error close-out
 *   - loadHotEntities (7-day interval, top 20 — D-17 weekly)
 *   - loadWeekRecapHint (UNION ALL of mention_events + email_drafts +
 *     morning-brief + day-close run counts over the week window). Graceful
 *     Phase-4 degrade returns [] when email_drafts table is missing
 *     (SQLSTATE 42P01).
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

export type AgentRunStatus = 'started' | 'ok' | 'error';

export async function insertAgentRunStarted(
  pool: PgPool,
  args: { captureId: string; ownerId: string; agentName: 'weekly-review' },
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
      WHERE capture_id = $1 AND agent_name = 'weekly-review'`,
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
      WHERE capture_id = $1 AND agent_name = 'weekly-review'`,
    [captureId, err.message ? err.message.slice(0, 1000) : String(err)],
  );
}

export interface HotEntityRow {
  entity_id: string;
  name: string;
  mention_count: number;
}

/**
 * D-17 weekly: top 20 entities by 7-day mention count. Wider window than
 * morning (48h) or day-close (12h) — the weekly retrospective wants every
 * thread Kevin touched.
 */
export async function loadHotEntities(
  pool: PgPool,
  ownerId: string,
  daysBack: number,
  limit: number,
): Promise<HotEntityRow[]> {
  const r = await pool.query(
    `SELECT me.entity_id, ei.name, count(*) AS mention_count
       FROM mention_events me
       JOIN entity_index ei ON ei.id = me.entity_id
      WHERE me.owner_id = $1
        AND me.entity_id IS NOT NULL
        AND me.occurred_at > now() - ($2::int * interval '1 day')
      GROUP BY me.entity_id, ei.name
      ORDER BY count(*) DESC
      LIMIT $3`,
    [ownerId, daysBack, limit],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    entity_id: String(row.entity_id),
    name: String(row.name),
    mention_count: Number(row.mention_count),
  }));
}

export interface WeekRecapHintRow {
  kind: 'mentions' | 'emails' | 'morning_briefs' | 'day_closes';
  n: number;
}

/**
 * UNION ALL aggregator for the week recap. Returns 4 rows:
 *   - mentions: count(mention_events)
 *   - emails: count(email_drafts)
 *   - morning_briefs: count(agent_runs WHERE name='morning-brief' AND status='ok')
 *   - day_closes: count(agent_runs WHERE name='day-close' AND status='ok')
 *
 * Graceful Phase-4 degrade — if email_drafts table is missing (SQLSTATE
 * 42P01), the entire query throws; we catch and return []. Once Phase 4
 * ships its schema this returns real rows with no code change.
 */
export async function loadWeekRecapHint(
  pool: PgPool,
  ownerId: string,
  weekStartStockholm: string,
  weekEndExclusiveStockholm: string,
): Promise<WeekRecapHintRow[]> {
  try {
    const r = await pool.query(
      `SELECT 'mentions' AS kind, count(*)::int AS n
         FROM mention_events
        WHERE owner_id = $1 AND occurred_at >= $2::date AND occurred_at < $3::date
       UNION ALL
       SELECT 'emails' AS kind, count(*)::int AS n
         FROM email_drafts
        WHERE owner_id = $1 AND received_at >= $2::date AND received_at < $3::date
       UNION ALL
       SELECT 'morning_briefs' AS kind, count(*)::int AS n
         FROM agent_runs
        WHERE owner_id = $1
          AND agent_name = 'morning-brief'
          AND status = 'ok'
          AND started_at >= $2::date AND started_at < $3::date
       UNION ALL
       SELECT 'day_closes' AS kind, count(*)::int AS n
         FROM agent_runs
        WHERE owner_id = $1
          AND agent_name = 'day-close'
          AND status = 'ok'
          AND started_at >= $2::date AND started_at < $3::date`,
      [ownerId, weekStartStockholm, weekEndExclusiveStockholm],
    );
    return r.rows.map((row: Record<string, unknown>) => ({
      kind: row.kind as WeekRecapHintRow['kind'],
      n: Number(row.n ?? 0),
    }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01') {
      // email_drafts (or another) relation missing — Phase 4 hasn't shipped.
      return [];
    }
    throw err;
  }
}

/** Test-only helper to reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
