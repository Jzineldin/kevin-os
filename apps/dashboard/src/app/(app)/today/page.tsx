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

// Phase 11 Plan 11-04 added 3 additive sections to TodayResponseSchema —
// captures_today + channels both default to [], and stat_tiles is optional.
// EMPTY mirrors the parsed-defaults shape so the degraded-fetch fallback
// path renders the new mission-control sections in their empty state
// (StatTileStrip → all zeros, ChannelHealth → "No channels", CapturesList
// → D-12 informative copy).
const EMPTY: TodayResponse = {
  brief: null,
  priorities: [],
  drafts: [],
  dropped: [],
  meetings: [],
  captures_today: [],
  channels: [],
};

export default async function TodayPage() {
  // The schema's `.default([])` fields (captures_today, channels) emerge as
  // required on the output type; the ZodSchema<T> constraint on callApi
  // picks the input side where they appear optional. We coerce via the
  // explicit `TodayResponseSchema.parse` output by re-asserting through
  // the EMPTY-typed fallback, which guarantees both branches yield the
  // post-parse shape that <TodayView> consumes.
  let data: TodayResponse = EMPTY;
  try {
    const parsed = await callApi('/today', { method: 'GET' }, TodayResponseSchema);
    // Re-apply schema parse so default-fields are guaranteed populated even
    // if callApi's generic erases them.
    data = TodayResponseSchema.parse(parsed);
  } catch {
    // Dashboard-api might not yet implement /today against fixture data in
    // every env; render an empty shape so the layout still paints. The
    // "Couldn't load today. Retrying…" error state is reserved for the
    // client-side SSE refetch path in TodayView.
    data = EMPTY;
  }
  return <TodayView data={data} />;
}
