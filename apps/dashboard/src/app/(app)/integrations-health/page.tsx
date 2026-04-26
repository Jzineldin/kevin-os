/**
 * Integrations-health page (Plan 11-06) — RSC entry. Fetches
 * `/integrations/health` from dashboard-api and hands off to the client
 * `<IntegrationsHealthView>` for SSE-driven refresh.
 *
 * `dynamic = 'force-dynamic'` — every request re-reads the server so the
 * `inbox_item` SSE kind (re-used per Phase 11 SSE rule "no new kinds")
 * triggers a fresh re-render via `router.refresh()` in the client view.
 *
 * D-12 empty-state contract: if dashboard-api errors out we fall back to
 * `{ channels: [], schedulers: [] }` — the view renders an informative
 * message rather than a blank section.
 */
import { callApi } from '@/lib/dashboard-api';
import {
  IntegrationsHealthResponseSchema,
  type IntegrationsHealthResponse,
} from '@kos/contracts/dashboard';

import { IntegrationsHealthView } from './IntegrationsHealthView';

export const dynamic = 'force-dynamic';

const EMPTY: IntegrationsHealthResponse = { channels: [], schedulers: [] };

export default async function IntegrationsHealthPage() {
  let data: IntegrationsHealthResponse;
  try {
    data = await callApi(
      '/integrations/health',
      { method: 'GET' },
      IntegrationsHealthResponseSchema,
    );
  } catch {
    data = EMPTY;
  }
  return <IntegrationsHealthView data={data} />;
}
