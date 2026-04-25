/**
 * /api/today — Node-runtime mirror of the dashboard-api `/today` response.
 * Exists so Plan 03-10's @serwist/next service worker can cache Today
 * offline with a 24h stale-while-revalidate window (per 03-CONTEXT D-31
 * + the PLAN 03-08 acceptance criterion).
 *
 * Upstream errors are mapped to 502 + `{ error: 'upstream' }` so the SW
 * cache layer can distinguish between "no upstream" (fall back to the
 * cached copy) and "stale upstream" (return cached, revalidate in bg).
 */
import { NextResponse } from 'next/server';

import { callApi } from '@/lib/dashboard-api';
import { TodayResponseSchema } from '@kos/contracts/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await callApi('/today', { method: 'GET' }, TodayResponseSchema);
    return NextResponse.json(data, {
      headers: {
        'cache-control': 'private, max-age=0, stale-while-revalidate=86400',
      },
    });
  } catch {
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}
