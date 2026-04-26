/**
 * Persistence helpers for the Approve / Edit / Skip routes (Plan 04-05).
 *
 * Lives at the dashboard-api root (NOT under handlers/ or routes/) so the
 * inbox merge handler + the email-drafts route handler can share the same
 * shape without circular imports. Mirrors the pattern in
 * services/email-sender/src/persist.ts at the SQL level so tables are
 * touched the same way from both Lambdas.
 *
 * IAM: dashboard-api runs as `kos_admin` (full read/write on email_drafts +
 * email_send_authorizations); email-sender runs as the much narrower
 * `kos_email_sender` role granted only the columns it needs.
 *
 * All queries go through the existing Drizzle pool (db.ts) so they share
 * the warm connection pool. We use raw `sql` template strings for SELECTs
 * with joins (the schema has no `email_drafts` Drizzle helper for joins
 * across the new tables yet — keeping migration 0016 raw matches the
 * Phase 4 D-22 minimal-Drizzle-types decision).
 */
import { sql } from 'drizzle-orm';
import { type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { OWNER_ID } from './owner-scoped.js';

export interface EmailDraftRow {
  id: string;
  owner_id: string;
  capture_id: string;
  account_id: string;
  message_id: string;
  from_email: string;
  to_email: string[];
  subject: string | null;
  classification: string;
  draft_body: string | null;
  draft_subject: string | null;
  status: string;
  received_at: string;
  triaged_at: string | null;
  approved_at: string | null;
  sent_at: string | null;
  sent_message_id: string | null;
}

/** Load a single draft by id, scoped to OWNER_ID. */
export async function loadDraftById(
  db: NodePgDatabase,
  draftId: string,
): Promise<EmailDraftRow | null> {
  const r = (await db.execute(sql`
    SELECT
      id::text                  AS id,
      owner_id::text            AS owner_id,
      capture_id                AS capture_id,
      account_id                AS account_id,
      message_id                AS message_id,
      from_email                AS from_email,
      to_email                  AS to_email,
      subject                   AS subject,
      classification            AS classification,
      draft_body                AS draft_body,
      draft_subject             AS draft_subject,
      status                    AS status,
      received_at::text         AS received_at,
      triaged_at::text          AS triaged_at,
      approved_at::text         AS approved_at,
      sent_at::text             AS sent_at,
      sent_message_id           AS sent_message_id
    FROM email_drafts
    WHERE owner_id = ${OWNER_ID}
      AND id = ${draftId}::uuid
    LIMIT 1
  `)) as unknown as { rows: EmailDraftRow[] };
  return r.rows[0] ?? null;
}

/**
 * Insert a new email_send_authorizations row + flip the draft to
 * 'approved' inside a single transaction. The single-use authorization
 * id flows to the email-sender Lambda via the `email.approved` event.
 */
export async function insertAuthorizationAndApprove(
  db: NodePgDatabase,
  args: { authorizationId: string; draftId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO email_send_authorizations (id, owner_id, draft_id)
      VALUES (
        ${args.authorizationId}::uuid,
        ${OWNER_ID},
        ${args.draftId}::uuid
      )
    `);
    await tx.execute(sql`
      UPDATE email_drafts
        SET status='approved', approved_at=now()
        WHERE owner_id = ${OWNER_ID}
          AND id = ${args.draftId}::uuid
    `);
  });
}

/**
 * Edit a draft's body + subject. Sets status='edited' so the Approve
 * handler can still pick it up (loadDraftForSend in email-sender accepts
 * any non-terminal status, but the dashboard surface needs the explicit
 * 'edited' marker so the SSE feed can distinguish "just-arrived draft"
 * vs "operator-tweaked draft").
 */
export async function updateDraftForEdit(
  db: NodePgDatabase,
  draftId: string,
  body: string,
  subject: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE email_drafts
      SET draft_body = ${body},
          draft_subject = ${subject},
          status = 'edited'
      WHERE owner_id = ${OWNER_ID}
        AND id = ${draftId}::uuid
  `);
}

/** Skip a draft — terminal state. */
export async function updateDraftSkip(
  db: NodePgDatabase,
  draftId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE email_drafts
      SET status = 'skipped'
      WHERE owner_id = ${OWNER_ID}
        AND id = ${draftId}::uuid
  `);
}

export interface InboxDraftItem {
  draft_id: string;
  capture_id: string;
  from_email: string;
  subject: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  classification: string;
  status: string;
  received_at: string;
}

/**
 * List all email_drafts in 'draft' or 'edited' status — these are the
 * items that show up in the dashboard inbox. Used by the merged
 * `/inbox` route handler. 50 rows max, newest-first.
 */
export async function listInboxDrafts(
  db: NodePgDatabase,
  limit = 50,
): Promise<InboxDraftItem[]> {
  const r = (await db.execute(sql`
    SELECT
      id::text          AS draft_id,
      capture_id        AS capture_id,
      from_email        AS from_email,
      subject           AS subject,
      draft_subject     AS draft_subject,
      draft_body        AS draft_body,
      classification    AS classification,
      status            AS status,
      received_at::text AS received_at
    FROM email_drafts
    WHERE owner_id = ${OWNER_ID}
      AND status IN ('draft','edited')
    ORDER BY received_at DESC
    LIMIT ${limit}
  `)) as unknown as { rows: InboxDraftItem[] };
  return r.rows;
}

export interface InboxDeadLetterItem {
  id: string;
  capture_id: string;
  tool_name: string;
  error_class: string;
  error_message: string;
  occurred_at: string;
}

/**
 * List unretried agent_dead_letter rows — the Phase 4 D-24 surface for
 * failed agent tool calls. The dashboard renders these as `kind: 'dead_letter'`
 * inbox items so Kevin can see + dismiss them.
 */
export async function listInboxDeadLetters(
  db: NodePgDatabase,
  limit = 50,
): Promise<InboxDeadLetterItem[]> {
  const r = (await db.execute(sql`
    SELECT
      id::text          AS id,
      capture_id        AS capture_id,
      tool_name         AS tool_name,
      error_class       AS error_class,
      error_message     AS error_message,
      occurred_at::text AS occurred_at
    FROM agent_dead_letter
    WHERE owner_id = ${OWNER_ID}
      AND retried_at IS NULL
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `)) as unknown as { rows: InboxDeadLetterItem[] };
  return r.rows;
}
