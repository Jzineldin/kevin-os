/**
 * email-sender persist — RDS Proxy IAM-auth pool + the three queries the
 * handler issues against the Phase 4 email tables.
 *
 * Connection pattern mirrors services/transcript-extractor/src/persist.ts:
 * `pg.Pool` with the password fn calling `@aws-sdk/rds-signer.getAuthToken`,
 * so each new connection mints a fresh 15-min IAM token automatically.
 *
 * Three writes + one read:
 *
 *   loadDraftForSend(pool, draftId, authorizationId)
 *     SELECT FOR UPDATE on email_send_authorizations + email_drafts joined
 *     by draft_id, returning everything the handler needs to build the SES
 *     raw message. Returns null when:
 *       - no authorization row matches (authorizationId stale / forged)
 *       - authorization is already consumed (consumed_at IS NOT NULL)
 *       - draft.id != authorization.draft_id (mismatch — never happens
 *         under our schema's FK but defensive)
 *       - draft already in terminal state (sent / failed / skipped)
 *     The FOR UPDATE lock prevents two concurrent EventBridge replays
 *     racing on the same authorization id.
 *
 *   markDraftSent(pool, draftId, sesMessageId)
 *     UPDATE email_drafts SET status='sent', sent_at=now(),
 *     sent_message_id=$2 WHERE id=$1.
 *
 *   markAuthorizationConsumed(pool, authorizationId, result)
 *     UPDATE email_send_authorizations SET consumed_at=now(),
 *     send_result=$2 WHERE id=$1.
 *
 *   markDraftFailed(pool, draftId, errorMessage)
 *     UPDATE email_drafts SET status='failed' on final SES failure. The
 *     authorization row is NOT marked consumed — operator can manually
 *     re-approve (insert new authorization) once the underlying SES issue
 *     is resolved.
 *
 * The handler runs the (load → send → mark sent → mark consumed) sequence
 * inside a transaction so partial state is impossible. If markDraftSent
 * succeeds but markAuthorizationConsumed errors, the txn rolls back, the
 * SES message was already sent (irreversible), and a duplicate-send guard
 * relies on the authorization-consumed check on the next replay attempt.
 *
 * Trade-off: SES delivery happens BEFORE we commit the txn, so a
 * post-send DB failure leaves a "ghost send" — the email went out but
 * email_drafts.status stays 'approved' and email_send_authorizations
 * stays unconsumed. On the next email.approved replay, loadDraftForSend
 * returns the row again and we'd re-send. That's the textbook
 * exactly-once-with-side-effect problem; we mitigate by:
 *   1. Querying SES via the rendered Message-ID (caller could grep
 *      CloudWatch on `[email-sender] sent ... ses_message_id=<...>`
 *      and reconcile manually); we do NOT auto-skip on this path.
 *   2. Logging the ghost-send in agent_dead_letter via withTimeoutAndRetry.
 * Phase 4 accepts this trade-off (D-23): SES idempotency is hard to
 * achieve without a per-message dedup token, and the operator can
 * always intervene on a "sent twice" via the dashboard.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER ?? 'kos_email_sender';
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

/** Test seam — vitest injects a mock pool to skip real Postgres. */
export function __setPoolForTest(fake: PgPool | null): void {
  pool = fake;
}

/**
 * Minimal pg-compatible interface — narrow surface so unit tests can
 * pass a `{ query }` mock without dragging in pg.
 */
export interface QueryablePool {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export interface DraftForSend {
  draft_id: string;
  authorization_id: string;
  owner_id: string;
  capture_id: string;
  account_id: string;
  from_email: string;
  /** Original sender — the address we reply TO. */
  reply_to: string;
  to_email: string[];
  /** Original Subject (raw inbound subject). */
  subject: string | null;
  /** Optional override subject (Approve gate may have rewritten it). */
  draft_subject: string | null;
  /** Draft body text — falls through verbatim to SES bodyText. */
  draft_body: string;
  /** Original Message-ID for In-Reply-To. */
  in_reply_to: string | null;
  /** References chain. Phase 4 stores the original Message-ID; expand later. */
  references: string[] | null;
}

/**
 * Load draft + authorization joined by draft_id with a row-level lock.
 *
 * Returns null when any of these guards trip:
 *   - authorization id not found
 *   - authorization already consumed (consumed_at NOT NULL)
 *   - draft id mismatch between params and authorization row
 *   - draft already in a terminal state (sent / failed / skipped)
 *
 * Caller wraps this in a transaction and FOR UPDATE locks the
 * authorization row to serialise concurrent SES sends on the same
 * authorization id. The lock is released when the transaction commits
 * or rolls back.
 */
export async function loadDraftForSend(
  pool: QueryablePool,
  draftId: string,
  authorizationId: string,
): Promise<DraftForSend | null> {
  // FOR UPDATE on the authorization row only — locking the draft would
  // contend with dashboard reads (which use plain SELECT). The
  // authorization is the security boundary; draft state is informational.
  const r = await pool.query(
    `SELECT
        a.id           AS authorization_id,
        a.owner_id     AS owner_id,
        a.consumed_at  AS consumed_at,
        d.id           AS draft_id,
        d.capture_id   AS capture_id,
        d.account_id   AS account_id,
        d.from_email   AS reply_to,
        d.to_email     AS to_email,
        d.subject      AS subject,
        d.draft_subject AS draft_subject,
        d.draft_body   AS draft_body,
        d.message_id   AS in_reply_to,
        d.status       AS draft_status
       FROM email_send_authorizations a
       JOIN email_drafts d ON d.id = a.draft_id
       WHERE a.id = $1 AND a.draft_id = $2
       FOR UPDATE OF a`,
    [authorizationId, draftId],
  );
  if (!r.rows || r.rows.length === 0) return null;
  const row = r.rows[0] as {
    authorization_id: string;
    owner_id: string;
    consumed_at: Date | null;
    draft_id: string;
    capture_id: string;
    account_id: string;
    reply_to: string;
    to_email: string[];
    subject: string | null;
    draft_subject: string | null;
    draft_body: string | null;
    in_reply_to: string | null;
    draft_status: string;
  };
  if (row.consumed_at) return null;
  // Draft must still be in an approvable / approved state. The dashboard
  // marks status='approved' atomically with the authorization INSERT, but
  // for forward-compat we accept either 'approved', 'edited', or 'draft'
  // (the operator may have approved a draft without explicitly bumping
  // the status — the authorization row is the source of truth).
  if (
    row.draft_status === 'sent' ||
    row.draft_status === 'failed' ||
    row.draft_status === 'skipped'
  ) {
    return null;
  }
  if (!row.draft_body || row.draft_body.length === 0) return null;
  // The "outgoing from" address is determined by which inbox received the
  // inbound. For Phase 4 we send from the same domain Kevin reads on
  // (kevin@tale-forge.app for the tale-forge inbox; kevin@elzarka.com is
  // not yet a verified SES identity in eu-north-1, so we route those
  // replies through tale-forge.app with a Reply-To override). Keep the
  // mapping in code rather than DB so it's reviewable in source.
  const fromEmail = mapAccountToFromEmail(row.account_id);
  return {
    draft_id: row.draft_id,
    authorization_id: row.authorization_id,
    owner_id: row.owner_id,
    capture_id: row.capture_id,
    account_id: row.account_id,
    from_email: fromEmail,
    reply_to: row.reply_to,
    to_email: row.to_email,
    subject: row.subject,
    draft_subject: row.draft_subject,
    draft_body: row.draft_body,
    in_reply_to: row.in_reply_to,
    references: row.in_reply_to ? [row.in_reply_to] : null,
  };
}

/** Map EmailEngine account id → verified SES From address. */
function mapAccountToFromEmail(accountId: string): string {
  // tale-forge.app is the primary verified domain (Phase 1 SES wiring).
  // elzarka.com is NOT verified in eu-north-1 yet; routing those replies
  // through tale-forge.app keeps the Approve flow live. Operator can
  // expand this once the second domain is verified.
  if (accountId === 'kevin-elzarka') return 'kevin@tale-forge.app';
  if (accountId === 'kevin-taleforge') return 'kevin@tale-forge.app';
  if (accountId === 'forward') return 'kevin@tale-forge.app';
  return 'kevin@tale-forge.app';
}

/** Mark draft sent + record SES envelope MessageId. */
export async function markDraftSent(
  pool: QueryablePool,
  draftId: string,
  sesMessageId: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_drafts
        SET status='sent', sent_at=now(), sent_message_id=$2
        WHERE id=$1`,
    [draftId, sesMessageId],
  );
}

/** Mark authorization row consumed — single-use token semantics. */
export async function markAuthorizationConsumed(
  pool: QueryablePool,
  authorizationId: string,
  result: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE email_send_authorizations
        SET consumed_at=now(), send_result=$2::jsonb
        WHERE id=$1`,
    [authorizationId, JSON.stringify(result)],
  );
}

/**
 * Mark draft as failed after final SES retry exhaustion. The
 * authorization row is intentionally LEFT unconsumed so the operator
 * can either:
 *   (a) re-approve (inserting a new authorization id → email-sender
 *       picks it up on the next email.approved replay), or
 *   (b) Skip from the dashboard (status → 'skipped').
 */
export async function markDraftFailed(
  pool: QueryablePool,
  draftId: string,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_drafts
        SET status='failed', sent_at=NULL, sent_message_id=NULL
        WHERE id=$1`,
    [draftId],
  );
  // We deliberately don't update the authorization row — see module docstring.
  void errorMessage;
}
