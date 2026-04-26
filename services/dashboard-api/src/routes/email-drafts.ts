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
import { EmailApprovedSchema } from '@kos/contracts';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
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

register('POST', '/email-drafts/:id/approve', approveEmailDraftHandler);
register('POST', '/email-drafts/:id/edit', editEmailDraftHandler);
register('POST', '/email-drafts/:id/skip', skipEmailDraftHandler);
