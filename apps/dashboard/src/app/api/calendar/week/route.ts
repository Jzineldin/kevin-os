/**
 * Authenticated server-side proxy for `GET /calendar/week`.
 *
 * Same pattern as /api/entities/[id]/timeline — keeps SigV4 credentials
 * on the Vercel Node lane. Middleware has already enforced the
 * kos_session cookie before this handler runs.
 */
import { NextResponse } from 'next/server';
import { callApi } from '@/lib/dashboard-api';
import { CalendarWeekResponseSchema } from '@kos/contracts/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const qs = [start ? `start=${encodeURIComponent(start)}` : '', end ? `end=${encodeURIComponent(end)}` : '']
    .filter(Boolean)
    .join('&');
  const upstream = qs ? `/calendar/week?${qs}` : '/calendar/week';
  try {
    const data = await callApi(upstream, { method: 'GET' }, CalendarWeekResponseSchema);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: String(err) },
      { status: 502 },
    );
  }
}
