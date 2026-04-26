/**
 * POST /api/email-drafts/:id/edit — Edit draft body / subject.
 *
 * Forwards body { body, subject } to services/dashboard-api
 * `POST /email-drafts/:id/edit` which updates email_drafts and emits
 * `draft_edited` on kos.output. Does NOT auto-approve — Kevin must
 * click Approve afterwards.
 *
 * Schema bounds (mirrors the upstream `EditDraftBodySchema`):
 *   body:    1..10_000 chars
 *   subject: 1..300    chars
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EditRequestSchema = z.object({
  body: z.string().min(1).max(10_000),
  subject: z.string().min(1).max(300),
});

const EditResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  let bodyJson: unknown;
  try {
    const text = await req.text();
    bodyJson = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = EditRequestSchema.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await callApi(
      `/email-drafts/${id}/edit`,
      { method: 'POST', body: JSON.stringify(parsed.data) },
      EditResponseSchema,
    );
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
