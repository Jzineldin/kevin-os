/**
 * /api/merge-resume — Vercel passthrough for ResumeMergeCard (Plan 03-09
 * Task 2) + resume action for the merge review page (Plan 03-11 Task 2).
 *
 * Accepts:
 *   - merge_id (required, zod-validated as ULID)
 *   - target_id (optional, UUID) — if omitted the route falls back to the
 *     literal `-` placeholder segment; dashboard-api's resume handler looks
 *     up source/target from the audit row itself via merge_id, so the URL
 *     segment is informational only. Plan 03-11 added target_id forwarding
 *     for audit-log clarity (Plan 09 handoff item #2).
 *   - action (optional, 'resume' | 'cancel' | 'revert') — forwarded as
 *     ?action= query param on the upstream handler.
 *
 * Upstream failures return 502 with the error body so the card surfaces a
 * sonner toast.
 */
import { NextResponse } from 'next/server';

import { callApi } from '@/lib/dashboard-api';
import {
  MergeResponseSchema,
  MergeResumeRequestSchema,
  UuidSchema,
} from '@kos/contracts/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = new Set(['resume', 'cancel', 'revert']);

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const merge_id = url.searchParams.get('merge_id');
  if (!merge_id) {
    return NextResponse.json({ error: 'missing merge_id' }, { status: 400 });
  }

  // Parameterised target segment — Plan 11 handoff item #2. If a valid
  // UUID is provided we use it in the path for audit clarity; otherwise
  // fall back to the `-` placeholder (dashboard-api resume handler does
  // not parse the segment — merge_id is authoritative).
  const rawTarget = url.searchParams.get('target_id');
  const target_id =
    rawTarget && UuidSchema.safeParse(rawTarget).success ? rawTarget : '-';

  const action = url.searchParams.get('action') ?? 'resume';
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }

  try {
    const parsed = MergeResumeRequestSchema.parse({ merge_id });
    const upstreamPath =
      `/entities/${target_id}/merge/resume` +
      (action !== 'resume' ? `?action=${action}` : '');
    const res = await callApi(
      upstreamPath,
      { method: 'POST', body: JSON.stringify(parsed) },
      MergeResponseSchema,
    );
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
