/**
 * content-writer-platform persist (Plan 08-02 Task 2).
 *
 * Pool config mirrors services/email-triage/src/persist.ts:
 *   - max=2 connections
 *   - per-connection IAM auth token via @aws-sdk/rds-signer
 *   - module-scope cache (warm Lambdas reuse the pool)
 *
 * Idempotency contract (Plan 08-02 Task 2 Test 3):
 *   - content_drafts has UNIQUE (topic_id, platform) — migration 0020.
 *   - insertContentDraft uses INSERT ... ON CONFLICT DO UPDATE so a re-run
 *     of the Map worker for the same (topic_id, platform) re-stamps
 *     created_at to the original value and returns the same draft id.
 *   - markDraftFailed uses ON CONFLICT (topic_id, platform) DO UPDATE
 *     SET status='failed' so a retry that catches a Bedrock failure flips
 *     an existing 'draft' row to 'failed' rather than throwing.
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

/** Test-only helper: reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}

/** Minimal pool-shape so tests can inject a stub query() without pg. */
export interface PgPoolLike {
  query<T = unknown>(
    text: string,
    params?: unknown[],
  ): Promise<{ rowCount?: number | null; rows: T[] }>;
}

export type ContentDraftStatus =
  | 'draft'
  | 'edited'
  | 'approved'
  | 'skipped'
  | 'scheduled'
  | 'published'
  | 'cancelled'
  | 'failed';

export interface InsertContentDraftArgs {
  ownerId: string;
  topicId: string;
  captureId: string;
  platform: string;
  content: string;
  mediaUrls: string[];
}

/**
 * Idempotent INSERT into content_drafts. On (topic_id, platform) conflict,
 * a no-op UPDATE returns the existing row's id — Map worker replays never
 * double-insert. status starts as 'draft' (Inbox-ready).
 */
export async function insertContentDraft(
  poolArg: PgPoolLike,
  args: InsertContentDraftArgs,
): Promise<{ draft_id: string; status: ContentDraftStatus }> {
  const r = await poolArg.query<{ draft_id: string; status: ContentDraftStatus }>(
    `INSERT INTO content_drafts
        (owner_id, topic_id, capture_id, platform, content, media_urls, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'draft')
     ON CONFLICT (topic_id, platform)
     DO UPDATE SET created_at = content_drafts.created_at
     RETURNING id::text AS draft_id, status`,
    [
      args.ownerId,
      args.topicId,
      args.captureId,
      args.platform,
      args.content,
      JSON.stringify(args.mediaUrls),
    ],
  );
  if (!r.rows[0]) {
    throw new Error(
      `insertContentDraft: RETURNING produced no row for (${args.topicId}, ${args.platform})`,
    );
  }
  return r.rows[0];
}

export interface MarkDraftFailedArgs {
  ownerId: string;
  topicId: string;
  captureId: string;
  platform: string;
  error: string;
}

/**
 * Mark a (topic_id, platform) row as failed. Inserts a fresh row with
 * status='failed' if none exists, or flips an existing 'draft' row to
 * 'failed' on conflict. The error string is truncated to 400 chars and
 * stored as the content body so operators can grep CloudWatch + the table
 * for the same failure signature.
 */
export async function markDraftFailed(
  poolArg: PgPoolLike,
  args: MarkDraftFailedArgs,
): Promise<void> {
  await poolArg.query(
    `INSERT INTO content_drafts
        (owner_id, topic_id, capture_id, platform, content, status)
     VALUES ($1, $2, $3, $4, $5, 'failed')
     ON CONFLICT (topic_id, platform)
     DO UPDATE SET status = 'failed'`,
    [
      args.ownerId,
      args.topicId,
      args.captureId,
      args.platform,
      `[ERROR] ${args.error.slice(0, 400)}`,
    ],
  );
}
