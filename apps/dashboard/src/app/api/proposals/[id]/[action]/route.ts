/**
 * /api/proposals/[id]/[action] — accept | reject | replace endpoints.
 * Phase 11 Plan 11-05. Forwards POST body verbatim.
 */
import { NextResponse } from 'next/server';

import { callApi } from '@/lib/dashboard-api';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ACTIONS = new Set(['accept', 'reject', 'replace']);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GenericResponseSchema = z.object({
  ok: z.boolean().optional(),
  proposal: z.unknown().optional(),
  original: z.unknown().optional(),
  replacement_id: z.string().optional(),
  error: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: 'invalid_action', allowed: [...ALLOWED_ACTIONS] },
      { status: 400 },
    );
  }
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    const data = await callApi(
      `/proposals/${id}/${action}`,
      { method: 'POST', body: JSON.stringify(body ?? {}) },
      GenericResponseSchema,
    );
    return NextResponse.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error(`[api/proposals/${id}/${action}] upstream failure`, err);
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}
