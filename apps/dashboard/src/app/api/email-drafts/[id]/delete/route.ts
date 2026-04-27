/**
 * POST /api/email-drafts/:id/delete — archive a draft permanently.
 *
 * Forwards to services/dashboard-api `POST /email-drafts/:id/delete`
 * which sets email_drafts.status='deleted' (distinct from 'skipped'
 * which is reversible). Hidden from all /inbox list views after this.
 * Refuses with 409 if the draft has already been approved/sent.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DeleteResponseSchema = z.object({
  ok: z.boolean().optional(),
  status: z.string().optional(),
  draft_id: z.string().optional(),
  error: z.string().optional(),
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
      `/email-drafts/${id}/delete`,
      { method: 'POST', body: JSON.stringify({}) },
      DeleteResponseSchema,
    );
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
