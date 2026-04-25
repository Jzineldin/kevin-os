/**
 * Authenticated server-side proxy for `GET /entities/:id/timeline`.
 *
 * The Timeline client component pages forward via this Route Handler so
 * the SigV4 credentials never leave the Vercel Node lane (Plan 05
 * decision — same pattern as `/api/palette-entities` in Plan 06).
 *
 * Middleware (`src/middleware.ts`) has already enforced the kos_session
 * cookie before this handler runs.
 */
import { NextResponse } from 'next/server';
import { callApi } from '@/lib/dashboard-api';
import { TimelinePageSchema } from '@kos/contracts/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_entity_id' }, { status: 400 });
  }
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor') ?? '';
  const upstream = cursor
    ? `/entities/${id}/timeline?cursor=${encodeURIComponent(cursor)}`
    : `/entities/${id}/timeline`;
  try {
    const data = await callApi(upstream, { method: 'GET' }, TimelinePageSchema);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
