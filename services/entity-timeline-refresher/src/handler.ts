/**
 * @kos/service-entity-timeline-refresher — Phase 6 MEM-04.
 *
 * EventBridge Scheduler invokes this every 5 min (Europe/Stockholm,
 * `entity-timeline-refresher-5min`). Single SQL call:
 *   REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline
 *
 * Why this Lambda exists:
 *   - Dashboard `/api/entities/:id/timeline` reads the MV (cheap), but the
 *     MV must be kept current. CONCURRENTLY refresh requires a unique index
 *     (migration 0012 ships `uniq_entity_timeline_event`).
 *   - 5 min cadence picked per CONTEXT D-25; live overlay in the dashboard
 *     query catches sub-5-min freshness on hot entities.
 *
 * D-28 instrumentation:
 *   - Sentry init (errors only — no traces; Langfuse owns spans)
 *   - Langfuse OTel tracing flushed in `finally` so Lambda return is never
 *     blocked by observability infra (Pitfall 9).
 *   - tagTraceWithCaptureId stamps a per-invocation pseudo-capture-id so
 *     refresh runs are greppable in Langfuse.
 *
 * Spec: .planning/phases/06-granola-semantic-memory/06-04-PLAN.md
 * Migration: 0012 — entity_timeline + uniq_entity_timeline_event +
 *            refresh_entity_timeline() SECURITY DEFINER fallback.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  tagTraceWithCaptureId,
  flush as langfuseFlush,
} from '../../_shared/tracing.js';
import { refreshConcurrently } from './persist.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

export const handler = wrapHandler(
  async (
    _event: unknown,
  ): Promise<{ ok: true; elapsedMs: number }> => {
    await initSentry();
    await setupOtelTracingAsync();
    tagTraceWithCaptureId(`entity-timeline-refresher-${new Date().toISOString()}`);

    try {
      const { elapsedMs } = await refreshConcurrently();
      // eslint-disable-next-line no-console
      console.log('[mv-refresher] refreshed entity_timeline', { elapsedMs });
      return { ok: true as const, elapsedMs };
    } finally {
      await langfuseFlush();
    }
  },
);
