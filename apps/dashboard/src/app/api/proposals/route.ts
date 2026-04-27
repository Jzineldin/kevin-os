/**
 * /api/proposals — Next.js proxy for Phase 11 Plan 11-05 proposals review
 * queue on dashboard-api. Forwards list / get / accept / reject / replace
 * calls with the bearer token attached server-side.
 *
 * Client usage from React:
 *   GET  /api/proposals?status=pending
 *   GET  /api/proposals/:id
 *   POST /api/proposals/:id/accept    { edited_payload?, user_note? }
 *   POST /api/proposals/:id/reject    { user_note? }
 *   POST /api/proposals/:id/replace   { replacement_payload, user_note? }
 */
import { NextResponse } from 'next/server';

import { callApi } from '@/lib/dashboard-api';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ListResponseSchema = z.object({
  total: z.number(),
  status_filter: z.string(),
  kind_filter: z.string().nullable(),
  items: z.array(z.unknown()),
  batches: z.array(z.unknown()),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const path = `/proposals${qs ? '?' + qs : ''}`;
  try {
    const data = await callApi(path, { method: 'GET' }, ListResponseSchema);
    return NextResponse.json(data, {
      headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=30' },
    });
  } catch (err) {
    console.error('[api/proposals] upstream failure', err);
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}
