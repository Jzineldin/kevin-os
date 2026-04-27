/**
 * POST /api/email-drafts/:id/draft — generate a reply on-demand.
 *
 * Forwards to services/dashboard-api `POST /email-drafts/:id/draft` which
 * invokes Sonnet 4.6 to produce a reply. Useful when Kevin wants to reply
 * to an email that triage had marked 'skipped' (informational / junk) —
 * no draft_body exists yet, this generates one.
 *
 * Body: { intent?: 'quick'|'detailed'|'decline', note?: string }
 *
 * On success the row flips to status='draft' with the new subject + body,
 * so the regular approve flow works from there.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RequestSchema = z
  .object({
    intent: z.enum(['quick', 'detailed', 'decline']).default('quick'),
    note: z.string().max(500).optional(),
  })
  .default({});

const ResponseSchema = z.object({
  ok: z.boolean().optional(),
  status: z.string().optional(),
  draft_id: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  error: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  let parsedBody: z.infer<typeof RequestSchema>;
  try {
    parsedBody = RequestSchema.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  try {
    const data = await callApi(
      `/email-drafts/${id}/draft`,
      { method: 'POST', body: JSON.stringify(parsedBody) },
      ResponseSchema,
    );
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
