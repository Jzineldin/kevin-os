/**
 * Today view (Plan 03-08) — RSC entry. Fetches `/today` from the
 * dashboard-api via the SigV4 client (Plan 03-05) and hands off to the
 * client `<TodayView>` composition.
 *
 * `dynamic = 'force-dynamic'` — every request re-reads the server so SSE
 * kinds aren't racing a stale cache. Caching happens via the Plan 10 SW
 * against `/api/today` (mirror route handler in this plan).
 */
import { callApi } from '@/lib/dashboard-api';
import { TodayResponseSchema, type TodayResponse } from '@kos/contracts/dashboard';
import { TodayView } from './TodayView';

export const dynamic = 'force-dynamic';

const EMPTY: TodayResponse = {
  brief: null,
  priorities: [],
  drafts: [],
  dropped: [],
  meetings: [],
};

export default async function TodayPage() {
  let data: TodayResponse;
  try {
    data = await callApi('/today', { method: 'GET' }, TodayResponseSchema);
  } catch {
    // Dashboard-api might not yet implement /today against fixture data in
    // every env; render an empty shape so the layout still paints. The
    // "Couldn't load today. Retrying…" error state is reserved for the
    // client-side SSE refetch path in TodayView.
    data = EMPTY;
  }
  return <TodayView data={data} />;
}
