/**
 * GET /entities/:id/timeline?cursor=<b64>
 *
 * Phase 6 MEM-04 — reads `entity_timeline` materialized view ⋃ live 10-min
 * mention_events overlay. Returns up to 50 rows ordered by (occurred_at
 * DESC, id DESC); cursor format unchanged (base64("${occurred_at_iso}:${id}"))
 * so the dashboard client paginates the same way.
 *
 * Why MV + overlay (D-26):
 *   - MV path: cheap; <50 ms p95 at 100k mention_events because the unique
 *     index on (owner_id, entity_id, capture_id, occurred_at, event_source,
 *     kind) lets the planner index-skip-scan to the entity slice.
 *   - 10-min overlay: catches sub-5-min freshness on hot entities — MV is
 *     refreshed every 5 min by services/entity-timeline-refresher; rows
 *     newer than that materialize in the overlay branch. Dedup against MV
 *     keeps each event_id exactly once even during the race window.
 *
 * Pre-Phase-6 behaviour read raw mention_events + agent_runs UNION; that
 * worked but did not scale to 100k rows. Phase 6 plan 06-04 swaps in the
 * MV; the cursor wire-format and dashboard client are unchanged.
 *
 * Migration name reconciliation: shipped migration 0012 names the MV
 * `entity_timeline` (not `entity_timeline_mv`) — see Plan 06-00 SUMMARY's
 * "honor shipped code" deviation. Plan 06-04 prose uses `entity_timeline_mv`;
 * this file honors the actual deployed name.
 */
import { sql } from 'drizzle-orm';
import { TimelinePageSchema } from '@kos/contracts/dashboard';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

export function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}:${id}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    // ISO datetimes contain colons (e.g. "2026-04-23T12:34:56.789Z") so we
    // split on the LAST ':' — IDs are uuids (no colons) by contract, but
    // we tolerate other colon-bearing id values by taking the longest
    // prefix that still parses as a valid Date.
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon < 1) return null;
    let splitIdx = lastColon;
    while (splitIdx > 0) {
      const candidateTs = decoded.slice(0, splitIdx);
      if (!Number.isNaN(new Date(candidateTs).getTime())) {
        const id = decoded.slice(splitIdx + 1);
        if (!id) return null;
        return { ts: candidateTs, id };
      }
      splitIdx = decoded.lastIndexOf(':', splitIdx - 1);
    }
    return null;
  } catch {
    return null;
  }
}

async function timelineHandler(ctx: Ctx): Promise<RouteResponse> {
  const idParam = ctx.params['id'];
  if (!idParam || !UUID_RE.test(idParam)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_entity_id' }) };
  }

  const cursor = decodeCursor(ctx.query['cursor']);
  const db = await getDb();

  // Sentinel cursor for first page: far-future + all-zero uuid descender.
  const cursorTs = cursor?.ts ?? '2100-01-01T00:00:00Z';
  const cursorId = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  const t0 = Date.now();

  // Phase 6 MEM-04 SQL (D-26): MV ⋃ live 10-min overlay with dedup.
  //
  //   mv:    rows from entity_timeline (refreshed every 5 min via
  //          REFRESH MATERIALIZED VIEW CONCURRENTLY).
  //   live:  mention_events with occurred_at > now() - interval '10 minutes'
  //          AND capture_id NOT IN (SELECT capture_id FROM mv) — dedup against
  //          the just-fetched MV slice so a row that already made it into the
  //          MV doesn't appear twice.
  //
  //   WR-01 fix: dedup MUST compare capture_id, not id. `mv.id` is
  //   `capture_id::text` (ULID namespace) but `live.id` is
  //   mention_events.id (row uuid PK) — two disjoint identifier spaces that
  //   never match, so the original `id::text NOT IN (SELECT id FROM mv)`
  //   filter was a no-op and every event in the 5-min refresh race window
  //   appeared twice. `capture_id` is present in both branches.
  //
  // Both branches enforce owner_id = OWNER_ID + entity_id = $1; cursor
  // pagination uses the (occurred_at, capture_id) keyset for stability under
  // concurrent inserts.
  const res = (await db.execute(sql`
    WITH mv AS (
      SELECT
        capture_id::text AS id,
        kind,
        occurred_at,
        event_source AS source,
        excerpt AS context,
        capture_id,
        false AS is_live_overlay
      FROM entity_timeline
      WHERE owner_id = ${OWNER_ID}
        AND entity_id = ${idParam}
        AND (occurred_at, capture_id::text) < (${cursorTs}::timestamptz, ${cursorId})
      ORDER BY occurred_at DESC, capture_id DESC
      LIMIT ${PAGE_SIZE}
    ),
    live AS (
      SELECT
        id::text AS id,
        'mention'::text AS kind,
        occurred_at,
        source,
        context,
        capture_id,
        true AS is_live_overlay
      FROM mention_events
      WHERE owner_id = ${OWNER_ID}
        AND entity_id = ${idParam}
        AND occurred_at > now() - interval '10 minutes'
        AND (occurred_at, id::text) < (${cursorTs}::timestamptz, ${cursorId})
        AND capture_id NOT IN (SELECT capture_id FROM mv WHERE capture_id IS NOT NULL)
    )
    SELECT id, kind, occurred_at, source, context, capture_id, is_live_overlay
      FROM mv
    UNION ALL
    SELECT id, kind, occurred_at, source, context, capture_id, is_live_overlay
      FROM live
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${PAGE_SIZE}
  `)) as unknown as {
    rows: Array<{
      id: string | null;
      kind: string;
      occurred_at: Date | string;
      source: string;
      context: string | null;
      capture_id: string | null;
      is_live_overlay: boolean;
    }>;
  };

  const elapsedMs = Date.now() - t0;

  const rows = res.rows.map((r) => ({
    // MV rows may have null id when capture_id is null (legacy mention_events
    // pre-Phase 2 capture_id requirement); fall back to occurred_at hash to
    // keep the cursor format valid. Live rows always have id (uuid).
    id: r.id ?? `mv-null-${String(r.occurred_at)}`,
    kind:
      r.kind === 'agent_run'
        ? ('agent_run' as const)
        : r.kind === 'mention'
          ? ('mention' as const)
          : // event_source 'mention' / 'agent_run' map directly; anything else
            // (transcript-extractor, entity-resolver) maps to 'agent_run' for
            // the dashboard's icon/colour rendering.
            ('agent_run' as const),
    occurred_at:
      r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    source: r.source,
    context: r.context ?? '',
    capture_id: r.capture_id,
    href: null as string | null,
    is_live_overlay: Boolean(r.is_live_overlay),
  }));

  const last = rows.at(-1);
  const nextCursor =
    rows.length === PAGE_SIZE && last ? encodeCursor(last.occurred_at, last.id) : null;

  const payload = TimelinePageSchema.parse({
    rows,
    next_cursor: nextCursor,
    elapsed_ms: elapsedMs,
  });

  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=60',
      'server-timing': `db;dur=${elapsedMs}`,
    },
  };
}

register('GET', '/entities/:id/timeline', timelineHandler);

export { timelineHandler };
