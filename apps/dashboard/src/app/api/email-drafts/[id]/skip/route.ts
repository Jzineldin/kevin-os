/**
 * POST /api/email-drafts/:id/skip — Skip a draft (terminal state).
 *
 * Forwards to services/dashboard-api `POST /email-drafts/:id/skip` which
 * sets email_drafts.status='skipped' and emits `draft_skipped` on
 * kos.output for SSE fan-out.
 *
 * Skip cannot be undone from the dashboard. The migration marker
 * `[SKIPPAT-DUP]` semantics from the broader KOS reversibility constraint
 * apply only to migration-time bulk imports, not approve-gate decisions.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SkipResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
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
      `/email-drafts/${id}/skip`,
      { method: 'POST', body: JSON.stringify({}) },
      SkipResponseSchema,
    );
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
