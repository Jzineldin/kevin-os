/**
 * Phase 4 Plan 04-05 — Approve / Edit / Skip Route Handlers.
 *
 *   POST /email-drafts/:id/approve
 *     1. Load draft, scoped to OWNER_ID.
 *     2. Status guard — only 'draft' / 'edited' may be approved.
 *     3. INSERT email_send_authorizations row (single-use token).
 *     4. UPDATE email_drafts SET status='approved', approved_at=now()
 *        in the SAME transaction so the auth row + draft state never
 *        diverge.
 *     5. PutEvents `email.approved` on kos.output → consumed by the
 *        email-sender Lambda which checks the auth row before SES.
 *
 *   POST /email-drafts/:id/edit
 *     Body: { body: string<=10_000, subject: string<=300 }
 *     1. Load draft + status guard (same as Approve).
 *     2. UPDATE draft_body + draft_subject + status='edited'.
 *     3. PutEvents `draft_edited` on kos.output (SSE fan-out only).
 *     The route does NOT auto-approve — Kevin must click Approve again.
 *
 *   POST /email-drafts/:id/skip
 *     1. Load draft + status guard (cannot skip already-sent / approved).
 *     2. UPDATE status='skipped'.
 *     3. PutEvents `draft_skipped` on kos.output (SSE fan-out).
 *
 * Bearer auth is enforced upstream by the dashboard-api Lambda's
 * `verifyBearer` middleware (services/dashboard-api/src/index.ts) — by the
 * time these handlers run the caller is already authorised.
 *
 * The Approve gate is the security boundary: a Bedrock-injected forged
 * `email.approved` event reaches the email-sender Lambda but fails its
 * `loadDraftForSend` join (no email_send_authorizations row). Only the
 * dashboard-api can write that row (its IAM allows INSERTs; email-triage
 * cannot). Plan 04-05 §threat_model T-04-SENDER-02.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { EmailApprovedSchema } from '@kos/contracts';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';
import { publishApproveGateEvent } from '../events.js';
import {
  loadDraftById,
  insertAuthorizationAndApprove,
  updateDraftForEdit,
  updateDraftSkip,
} from '../email-drafts-persist.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Edit body schema — bounded so a malicious operator cannot blow up the
// EventBridge detail size on the SSE fan-out, and so the SES SendRawEmail
// call stays well below the 10MB SES message limit.
export const EditDraftBodySchema = z.object({
  body: z.string().min(1).max(10_000),
  subject: z.string().min(1).max(300),
});

function isValidUuid(v: string | undefined): v is string {
  return !!v && UUID_RE.test(v);
}

function statusIsTerminalForApproveOrEdit(status: string): boolean {
  return (
    status === 'sent' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'approved'
  );
}

function statusIsTerminalForSkip(status: string): boolean {
  // Once sent we can't undo. Approved + currently-being-sent is also a
  // race we don't unwind from the dashboard.
  return status === 'sent' || status === 'approved';
}

export async function approveEmailDraftHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!isValidUuid(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  const db = await getDb();
  const draft = await loadDraftById(db, id);
  if (!draft) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (statusIsTerminalForApproveOrEdit(draft.status)) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'invalid_status',
        detail: `cannot approve from status ${draft.status}`,
      }),
    };
  }

  const authorizationId = randomUUID();
  await insertAuthorizationAndApprove(db, {
    authorizationId,
    draftId: id,
  });

  // Validate the event detail against the canonical Zod schema BEFORE the
  // PutEvents — any drift is a build-time bug + the Lambda rejects.
  const payload = EmailApprovedSchema.parse({
    capture_id: draft.capture_id,
    draft_id: id,
    authorization_id: authorizationId,
    approved_at: new Date().toISOString(),
  });
  try {
    await publishApproveGateEvent('email.approved', payload);
  } catch (err) {
    // EventBridge transient failure — the email_send_authorizations row
    // exists, so a manual re-emit (or an EventBridge retry from the
    // dashboard caller) will fire the email-sender. We surface 502 so
    // the UI can show a "saved but not dispatched" hint.
    // eslint-disable-next-line no-console
    console.error('[dashboard-api] email.approved emit failed', err);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: 'eventbridge_publish_failed',
        authorization_id: authorizationId,
      }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, authorization_id: authorizationId }),
  };
}

export async function editEmailDraftHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!isValidUuid(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  let parsed;
  try {
    parsed = EditDraftBodySchema.parse(JSON.parse(ctx.body ?? '{}'));
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'invalid_body', detail: (e as Error).message }),
    };
  }

  const db = await getDb();
  const draft = await loadDraftById(db, id);
  if (!draft) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (statusIsTerminalForApproveOrEdit(draft.status)) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'invalid_status',
        detail: `cannot edit from status ${draft.status}`,
      }),
    };
  }

  await updateDraftForEdit(db, id, parsed.body, parsed.subject);
  try {
    await publishApproveGateEvent('draft_edited', {
      capture_id: draft.capture_id,
      draft_id: id,
    });
  } catch (err) {
    // SSE-only signal — failure is logged but doesn't fail the route.
    // eslint-disable-next-line no-console
    console.warn('[dashboard-api] draft_edited emit failed', err);
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, status: 'edited' }),
  };
}

export async function skipEmailDraftHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!isValidUuid(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  const db = await getDb();
  const draft = await loadDraftById(db, id);
  if (!draft) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (statusIsTerminalForSkip(draft.status)) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'invalid_status',
        detail: `cannot skip from status ${draft.status}`,
      }),
    };
  }
  await updateDraftSkip(db, id);
  try {
    await publishApproveGateEvent('draft_skipped', {
      capture_id: draft.capture_id,
      draft_id: id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[dashboard-api] draft_skipped emit failed', err);
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, status: 'skipped' }),
  };
}

/**
 * POST /email-drafts/:id/delete — archive the draft permanently.
 *
 * This is NOT status='skipped' (reversible, still appears in /inbox
 * filtered views). delete actually archives — sets status='deleted'
 * and hides from all /inbox list views. Irreversible from the UI
 * (row still exists in DB for audit / legal recovery).
 */
export async function deleteEmailDraftHandler(ctx: Ctx): Promise<RouteResponse> {
  const draftId = ctx.params['id'];
  if (!draftId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_id' }) };
  }
  const db = await getDb();
  const existing = await loadDraftById(db, draftId);
  if (!existing) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (existing.status === 'approved' || existing.status === 'sent') {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'already_sent',
        status: existing.status,
        message: 'cannot delete a draft that has been approved or sent',
      }),
    };
  }
  await db.execute(sql`
    UPDATE email_drafts
       SET status = 'deleted', triaged_at = COALESCE(triaged_at, now())
     WHERE owner_id = ${OWNER_ID}
       AND id = ${draftId}::uuid
  `);
  // Audit — event_log
  try {
    await db.execute(sql`
      INSERT INTO event_log (owner_id, kind, actor, occurred_at, detail)
      VALUES (${OWNER_ID}, 'email-draft:deleted', 'dashboard-api', now(),
              ${JSON.stringify({ draft_id: draftId, prior_status: existing.status })}::jsonb)
    `);
  } catch {
    /* non-fatal */
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, status: 'deleted', draft_id: draftId }),
    headers: { 'cache-control': 'no-store' },
  };
}

/**
 * POST /email-drafts/:id/draft — generate a draft reply on demand.
 *
 * For emails the triage classified as 'informational' or 'junk'
 * (status='skipped'), no draft_body exists. This endpoint calls
 * Sonnet 4.6 to produce one — e.g. Kevin realises he DOES want to
 * reply to that "junk" marketing email or ask a follow-up question
 * on an "informational" receipt.
 *
 * Body: { intent?: 'quick'|'detailed'|'decline', note?: string }
 *   - intent shapes tone: quick reply / detailed thoughtful reply /
 *     polite decline
 *   - note is Kevin's freeform hint about what to include
 *
 * Side-effect: updates email_drafts.draft_subject + draft_body +
 * status='draft' (so the standard approve flow works after).
 */
const GenerateDraftBodySchema = z
  .object({
    intent: z.enum(['quick', 'detailed', 'decline']).default('quick'),
    note: z.string().max(500).optional(),
  })
  .default({});

export async function generateDraftOnDemandHandler(
  ctx: Ctx,
): Promise<RouteResponse> {
  const draftId = ctx.params['id'];
  if (!draftId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_id' }) };
  }
  let body: z.infer<typeof GenerateDraftBodySchema>;
  try {
    body = GenerateDraftBodySchema.parse(
      ctx.body ? JSON.parse(ctx.body) : {},
    );
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_body' }) };
  }
  const db = await getDb();
  const existing = await loadDraftById(db, draftId);
  if (!existing) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (existing.status === 'approved' || existing.status === 'sent') {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'already_sent',
        status: existing.status,
      }),
    };
  }

  // Defer the actual Bedrock call into this function to avoid loading the
  // SDK on the hot /email-drafts GET path.
  const { draftWithBedrock } = await import('../email-draft-generator.js');
  const generated = await draftWithBedrock({
    fromEmail: existing.from_email,
    toEmail: existing.to_email,
    subject: existing.subject ?? '(no subject)',
    bodyPlain: existing.body_plain ?? existing.body_preview ?? '',
    intent: body.intent,
    kevinNote: body.note,
  });

  await db.execute(sql`
    UPDATE email_drafts
       SET status = 'draft',
           draft_subject = ${generated.subject},
           draft_body = ${generated.body},
           triaged_at = COALESCE(triaged_at, now())
     WHERE owner_id = ${OWNER_ID}
       AND id = ${draftId}::uuid
  `);

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      status: 'draft',
      draft_id: draftId,
      subject: generated.subject,
      body: generated.body,
    }),
    headers: { 'cache-control': 'no-store' },
  };
}

/**
 * GET /email-drafts/:id
 *
 * Returns the full draft row including the original email body
 * (body_plain + body_html + body_preview from migration 0024) so the
 * /inbox UI can render the message Kevin received, not just its subject.
 *
 * Owner-scoped via loadDraftById (queries with owner_id = OWNER_ID).
 * 404 when the id doesn't exist OR belongs to a different owner.
 */
export async function getEmailDraftHandler(ctx: Ctx): Promise<RouteResponse> {
  const draftId = ctx.params['id'];
  if (!draftId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'missing_id' }),
    };
  }
  const db = await getDb();
  const row = await loadDraftById(db, draftId);
  if (!row) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'not_found' }),
    };
  }
  return {
    statusCode: 200,
    body: JSON.stringify(row),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=30',
    },
  };
}

register('GET', '/email-drafts/:id', getEmailDraftHandler);
register('POST', '/email-drafts/:id/approve', approveEmailDraftHandler);
register('POST', '/email-drafts/:id/edit', editEmailDraftHandler);
register('POST', '/email-drafts/:id/skip', skipEmailDraftHandler);
register('POST', '/email-drafts/:id/delete', deleteEmailDraftHandler);
register('POST', '/email-drafts/:id/draft', generateDraftOnDemandHandler);
