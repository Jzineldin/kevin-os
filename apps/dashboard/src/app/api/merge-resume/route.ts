/**
 * /api/merge-resume — thin Vercel passthrough for the <ResumeMergeCard />
 * action (Plan 03-09 Task 2). The actual merge-resume handler ships in
 * Plan 03-11 (dashboard-api `/entities/:target_id/merge/resume` +
 * MergeAudit writes).
 *
 * Why a Vercel route at all (rather than a Server Action): the Resume card
 * is triggered from a click handler that already lives in a client
 * component, so a fetch to a Node-runtime route is the simplest surface —
 * it avoids a Server Action file within the Inbox tree for a handler that
 * is upstream-owned anyway.
 *
 * Upstream failures return 502 with the error body so <ResumeMergeCard />
 * can surface a sonner toast.
 *
 * NOTE: the callApi path uses `/entities/-/merge/resume` — Plan 03-11 will
 * wire the real `target_id` URL segment; for Phase 3 Plan 09 the endpoint
 * is expected to return a 501 or 502 when dashboard-api doesn't yet own
 * it, which the card surfaces as an error toast.
 */
import { NextResponse } from 'next/server';

import { callApi } from '@/lib/dashboard-api';
import {
  MergeResponseSchema,
  MergeResumeRequestSchema,
} from '@kos/contracts/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const merge_id = url.searchParams.get('merge_id');
  if (!merge_id) {
    return NextResponse.json({ error: 'missing merge_id' }, { status: 400 });
  }
  try {
    const parsed = MergeResumeRequestSchema.parse({ merge_id });
    const res = await callApi(
      '/entities/-/merge/resume',
      { method: 'POST', body: JSON.stringify(parsed) },
      MergeResponseSchema,
    );
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
