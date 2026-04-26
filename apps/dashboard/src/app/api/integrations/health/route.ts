/**
 * /api/integrations/health — Vercel Node-runtime mirror of dashboard-api
 * `/integrations/health`. Plan 11-06 D-07 live data wiring.
 *
 * Pattern matches /api/today (apps/dashboard/src/app/api/today/route.ts):
 * proxies via callApi (which injects the Bearer token), zod-validates
 * against IntegrationsHealthResponseSchema, and maps upstream errors to
 * 502 + `{ error: 'upstream' }` so the SSE-driven view can distinguish
 * "no upstream" (fall through to D-12 empty state) from "stale upstream".
 */
import { NextResponse } from 'next/server';

import { callApi } from '@/lib/dashboard-api';
import { IntegrationsHealthResponseSchema } from '@kos/contracts/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await callApi(
      '/integrations/health',
      { method: 'GET' },
      IntegrationsHealthResponseSchema,
    );
    return NextResponse.json(data, {
      headers: {
        'cache-control': 'private, max-age=0, stale-while-revalidate=60',
      },
    });
  } catch {
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}
