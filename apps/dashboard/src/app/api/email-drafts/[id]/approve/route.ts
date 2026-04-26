/**
 * POST /api/email-drafts/:id/approve — Approve gate Route Handler.
 *
 * Authentication: middleware.ts requires the kos_session cookie (matches
 * KOS_DASHBOARD_BEARER_TOKEN). By the time this handler runs the caller
 * is authorised; the upstream dashboard-api Lambda re-checks Bearer auth
 * via callApi() injection.
 *
 * Forwards to services/dashboard-api `POST /email-drafts/:id/approve`
 * which writes the email_send_authorizations row + emits `email.approved`
 * on the kos.output bus. The email-sender Lambda picks up that event
 * and dispatches via SES SendRawEmail.
 *
 * Phase 4 D-23: ALL outbound emails go through this gate. The email-
 * sender's IAM has NO bedrock; the email-triage's IAM has NO ses; the
 * Approve route is the structural bridge between them.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ApproveResponseSchema = z.object({
  ok: z.boolean(),
  authorization_id: z.string().uuid(),
});

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  try {
    const data = await callApi(
      `/email-drafts/${id}/approve`,
      { method: 'POST', body: JSON.stringify({}) },
      ApproveResponseSchema,
    );
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
