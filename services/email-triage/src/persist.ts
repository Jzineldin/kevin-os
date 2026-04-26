/**
 * Email-triage persist (AGT-05) — RDS Proxy IAM-auth Postgres pool +
 * email_drafts idempotent INSERT helpers (Phase 4 D-21).
 *
 * Pool config matches Phase 2 triage/persist.ts:
 *   - max=2 connections
 *   - per-connection IAM auth token via @aws-sdk/rds-signer
 *   - module-scope cache (warm Lambdas reuse the pool)
 *
 * Idempotency contract (Gate 3 criterion 1):
 *   - email_drafts has UNIQUE (account_id, message_id) — migration 0016.
 *   - insertEmailDraftPending uses INSERT ... ON CONFLICT DO NOTHING and
 *     returns the existing row's id on conflict.
 *   - findExistingDraftByMessage is the explicit pre-check call site for the
 *     handler when it wants to short-circuit the LLM calls altogether.
 *
 * loadKevinContextBlockLocal — pool-wired adapter to the canonical Phase 6
 * loader (kept here so context.ts can call it without re-importing the
 * @kos/context-loader sub-import path).
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

export type EmailClassification = 'urgent' | 'important' | 'informational' | 'junk';
export type EmailDraftStatus =
  | 'pending_triage'
  | 'draft'
  | 'edited'
  | 'approved'
  | 'skipped'
  | 'sent'
  | 'failed';

/**
 * Lookup an existing draft by (account_id, message_id). Returns the
 * draft.id if present, or null otherwise. Used by the handler's idempotency
 * pre-check.
 */
export async function findExistingDraftByMessage(
  poolArg: PgPool,
  accountId: string,
  messageId: string,
): Promise<string | null> {
  const r = await poolArg.query<{ id: string }>(
    `SELECT id FROM email_drafts
       WHERE account_id = $1 AND message_id = $2
       LIMIT 1`,
    [accountId, messageId],
  );
  return r.rows[0]?.id ?? null;
}

export interface InsertEmailDraftPendingArgs {
  ownerId: string;
  captureId: string;
  accountId: string;
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: string;
}

/**
 * Idempotent INSERT into email_drafts. Returns the draft.id whether a fresh
 * row was inserted OR a duplicate was rejected by the UNIQUE constraint
 * (we re-SELECT on conflict). classification starts as 'pending_triage' and
 * updateEmailDraftClassified flips it once the agent run completes.
 */
export async function insertEmailDraftPending(
  poolArg: PgPool,
  args: InsertEmailDraftPendingArgs,
): Promise<string> {
  const r = await poolArg.query<{ id: string }>(
    `INSERT INTO email_drafts
        (owner_id, capture_id, account_id, message_id, from_email, to_email,
         subject, classification, status, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_triage', 'pending_triage', $8)
     ON CONFLICT (account_id, message_id) DO NOTHING
     RETURNING id`,
    [
      args.ownerId,
      args.captureId,
      args.accountId,
      args.messageId,
      args.from,
      args.to,
      args.subject,
      args.receivedAt,
    ],
  );
  if (r.rows[0]?.id) return r.rows[0].id;
  // Conflict path — fetch the existing row.
  const existing = await findExistingDraftByMessage(
    poolArg,
    args.accountId,
    args.messageId,
  );
  if (!existing) {
    throw new Error(
      `insertEmailDraftPending: ON CONFLICT path triggered but no row found for (${args.accountId}, ${args.messageId})`,
    );
  }
  return existing;
}

export interface UpdateEmailDraftClassifiedArgs {
  classification: EmailClassification;
  draftBody?: string;
  draftSubject?: string;
  triagedAt: string;
  status: 'draft' | 'skipped';
}

/**
 * Stamp the draft after the LLM run completes. status='draft' for urgent
 * (we have a body); status='skipped' for everything else (no draft body).
 */
export async function updateEmailDraftClassified(
  poolArg: PgPool,
  draftId: string,
  args: UpdateEmailDraftClassifiedArgs,
): Promise<void> {
  await poolArg.query(
    `UPDATE email_drafts
        SET classification = $2,
            draft_body     = $3,
            draft_subject  = $4,
            triaged_at     = $5,
            status         = $6
      WHERE id = $1`,
    [
      draftId,
      args.classification,
      args.draftBody ?? null,
      args.draftSubject ?? null,
      args.triagedAt,
      args.status,
    ],
  );
}

export interface PendingDraftRow {
  id: string;
  capture_id: string;
  account_id: string;
  message_id: string;
  from_email: string;
  to_email: string[];
  subject: string;
  received_at: string;
}

/**
 * Load all email_drafts rows still in 'pending_triage' for a given owner —
 * scan_emails_now operator/scheduler path. Capped at `limit` to bound a
 * single Lambda invocation.
 */
export async function loadPendingDrafts(
  poolArg: PgPool,
  ownerId: string,
  limit: number,
): Promise<PendingDraftRow[]> {
  const r = await poolArg.query<PendingDraftRow>(
    `SELECT id, capture_id, account_id, message_id, from_email, to_email,
            COALESCE(subject, '') AS subject, received_at
       FROM email_drafts
      WHERE owner_id = $1 AND status = 'pending_triage'
      ORDER BY received_at ASC
      LIMIT $2`,
    [ownerId, limit],
  );
  return r.rows;
}

/**
 * Pool-wired adapter to the canonical loader in @kos/context-loader/src/kevin.ts.
 * Used by context.ts as the degraded fallback when the full loadContext
 * path fails or @kos/context-loader is unresolvable.
 */
export async function loadKevinContextBlockLocal(
  poolArg: PgPool,
  ownerId: string,
): Promise<string> {
  // Lazy import — keeps the optional peer dep optional. Test harnesses can
  // stub this whole module to avoid the import.
  const mod = await import('@kos/context-loader');
  return mod.loadKevinContextMarkdown(ownerId, poolArg);
}

/** Test-only helper: reset the module-scope pool between tests. */
export function __resetPoolForTests(): void {
  pool = null;
}
