/**
 * Inbox view (Plan 03-09) — RSC entry. Fetches `/inbox` from the
 * dashboard-api via the SigV4 client (Plan 03-05) and hands off to the
 * client `<InboxClient>` composition.
 *
 * `dynamic = 'force-dynamic'` — every request re-reads the server so SSE
 * `inbox_item` / `draft_ready` / `entity_merge` kinds aren't racing a
 * stale cache. The client subscribes to those kinds and fires
 * `router.refresh()` which re-executes this RSC.
 *
 * `?focus=...` query param lets the merge flow deep-link directly to a
 * resume card: `/inbox?focus=resume-<merge_id>`.
 *
 * Fallback: if dashboard-api `/inbox` is not yet implemented in the
 * current preview env (same D-12 "no crying wolf" pattern as Plan 03-08
 * `/today`), render an empty list. The SSE loop + next refresh will
 * populate.
 */
import { callApi } from '@/lib/dashboard-api';
import {
  InboxListSchema,
  type InboxList,
} from '@kos/contracts/dashboard';

import { InboxClient } from './InboxClient';

export const dynamic = 'force-dynamic';

const EMPTY: InboxList = { items: [] };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const params = await searchParams;
  // 2026-04-26: switched from `/inbox` (inbox_index only — Phase 3 entity
  // routings) to `/inbox-merged` (unions email_drafts + agent_dead_letter
  // + inbox_index — Phase 4 Plan 04-05). Without this, classified emails
  // never appeared in the dashboard inbox.
  let data: InboxList;
  try {
    data = await callApi('/inbox-merged', { method: 'GET' }, InboxListSchema);
  } catch {
    try {
      data = await callApi('/inbox', { method: 'GET' }, InboxListSchema);
    } catch {
      data = EMPTY;
    }
  }
  return (
    <InboxClient
      initialItems={data.items}
      focusId={params.focus ?? null}
    />
  );
}
