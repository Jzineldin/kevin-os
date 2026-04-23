/**
 * GET /entities/:id/timeline?cursor=<b64>
 *
 * Cursor-paginated UNION of mention_events + agent_runs (RESEARCH §10).
 * Cursor format: base64(`${occurred_at_iso}:${id}`) — prevents phantom
 * rows on live insert by using a compound keyset order.
 *
 * TODO(phase-6): replace with `entity_timeline_mv` + live UNION from the
 * last 10 min once MEM-04 ships.
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
    // Walk back from the last colon to find a split that yields a valid date.
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

  // Sentinel cursor for first page: far-future (2100-01-01) + all-zero uuid.
  const cursorTs = cursor?.ts ?? '2100-01-01T00:00:00Z';
  const cursorId = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  const res = (await db.execute(sql`
    SELECT
      id,
      kind,
      occurred_at,
      source,
      context,
      capture_id
    FROM (
      SELECT
        id::text AS id,
        'mention'::text AS kind,
        occurred_at,
        source,
        context,
        capture_id
      FROM mention_events
      WHERE owner_id = ${OWNER_ID}
        AND entity_id = ${idParam}
        AND (occurred_at, id::text) < (${cursorTs}::timestamptz, ${cursorId})
      UNION ALL
      SELECT
        id::text AS id,
        'agent_run'::text AS kind,
        started_at AS occurred_at,
        agent_name AS source,
        COALESCE((output_json->>'summary')::text, '') AS context,
        capture_id
      FROM agent_runs
      WHERE owner_id = ${OWNER_ID}
        AND output_json ? 'entity_id'
        AND (output_json->>'entity_id')::uuid = ${idParam}
        AND (started_at, id::text) < (${cursorTs}::timestamptz, ${cursorId})
    ) AS unioned
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${PAGE_SIZE}
  `)) as unknown as {
    rows: Array<{
      id: string;
      kind: string;
      occurred_at: Date | string;
      source: string;
      context: string | null;
      capture_id: string | null;
    }>;
  };

  const rows = res.rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'agent_run' ? ('agent_run' as const) : ('mention' as const),
    occurred_at:
      r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    source: r.source,
    context: r.context ?? '',
    capture_id: r.capture_id,
    href: null as string | null,
  }));

  const last = rows.at(-1);
  const nextCursor = rows.length === PAGE_SIZE && last ? encodeCursor(last.occurred_at, last.id) : null;

  const payload = TimelinePageSchema.parse({ rows, next_cursor: nextCursor });

  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=60' },
  };
}

register('GET', '/entities/:id/timeline', timelineHandler);

export { timelineHandler };
