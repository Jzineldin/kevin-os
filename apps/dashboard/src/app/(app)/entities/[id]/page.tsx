/**
 * Per-entity dossier (`/entities/[id]`) — Plan 03-10 Task 1.
 *
 * Server Component. Fetches `/entities/:id` + the first page of
 * `/entities/:id/timeline` in parallel from dashboard-api (SigV4), then
 * hands off to the client `EntityDossier` which owns SSE subscriptions,
 * the edit Dialog, and timeline virtualization.
 *
 * Types Person + Project share one template per D-03; Company + Document
 * are deferred (same template shape — trivial once live data exists).
 */
import { notFound } from 'next/navigation';
import {
  EntityResponseSchema,
  TimelinePageSchema,
  type EntityResponse,
  type TimelinePage,
} from '@kos/contracts/dashboard';
import { callApi } from '@/lib/dashboard-api';
import { EntityDossier } from './EntityDossier';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EntityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  let entity: EntityResponse;
  let initialTimeline: TimelinePage;
  try {
    [entity, initialTimeline] = await Promise.all([
      callApi(`/entities/${id}`, { method: 'GET' }, EntityResponseSchema),
      callApi(`/entities/${id}/timeline`, { method: 'GET' }, TimelinePageSchema),
    ]);
  } catch (err) {
    // Dashboard-api returns 404 for unknown ids — map to Next's notFound()
    // so the user gets the 404 page rather than a crashed route.
    if (err instanceof Error && /→ 404/.test(err.message)) notFound();
    throw err;
  }

  return <EntityDossier entity={entity} initialTimeline={initialTimeline} />;
}
