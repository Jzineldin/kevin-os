/**
 * GET /today — composes the morning-briefing aggregate.
 *
 * Data sources (RESEARCH §9, composed in parallel via Promise.all):
 *   1. Notion 🏠 Today page  → `brief` (null on Plan 03 — wired in Phase 7).
 *   2. Notion Command Center → top 3 priorities.
 *   3. RDS inbox_index       → pending drafts (top 5).
 *   4. RDS entity_index      → dropped threads (last_touch > 7 days, active).
 *   5. Notion Today Meetings → meetings today (Phase 7 extension; Phase 3 returns []).
 *
 * Phase 11 D-07 expansion (Plan 11-04): the response now also surfaces
 * three additive mission-control sections:
 *   6. captures_today — UNION across email_drafts + event_log + mention_events
 *      + inbox_index + telegram_inbox_queue for the current Stockholm day.
 *      Wave 0 schema verification confirmed `capture_text` / `capture_voice`
 *      tables DO NOT EXIST; the UNION runs over the tables that do.
 *   7. stat_tiles — 4 numeric counts powering the top StatTileStrip:
 *      CAPTURES TODAY / DRAFTS PENDING / ENTITIES ACTIVE / EVENTS UPCOMING.
 *   8. channels — channel-health snapshot for the strip linking to
 *      `/integrations-health`. Inlined here for round-trip economy (one
 *      /today fetch supplies everything the page needs); Plan 11-06 owns
 *      the dedicated endpoint with full scheduler+channel rollup.
 *
 * Response shape MUST parse against TodayResponseSchema before returning
 * (zod at exit catches accidental shape drift).
 *
 * Caching: `Cache-Control: private, max-age=0, stale-while-revalidate=86400`
 * honours the 24h SWR rule from D-31.
 *
 * Phase 3 MUST NOT invoke an LLM (per RESEARCH §10 + D-02). The brief is
 * a simple Notion page property read.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  TodayResponseSchema,
  type StatTileData,
  type TodayCaptureItem,
} from '@kos/contracts/dashboard';
import { entityIndex, inboxIndex } from '@kos/db/schema';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { getNotion } from '../notion.js';
import { ownerScoped, OWNER_ID } from '../owner-scoped.js';

type ChannelItem = {
  name: string;
  type: 'capture' | 'scheduler';
  status: 'healthy' | 'degraded' | 'down';
  last_event_at: string | null;
};

type TodayBrief = { body: string; generated_at: string } | null;

async function loadBrief(): Promise<TodayBrief> {
  const pageId = process.env.NOTION_TODAY_PAGE_ID;
  if (!pageId) return null;
  try {
    // The brief is stored as BLOCKS (heading + paragraph + numbered_list)
    // by morning-brief/day-close, NOT as a rich_text property. Iterate the
    // page children and assemble a plaintext body. Schema verified via
    // Notion API 2026-04-27.
    const [page, children] = await Promise.all([
      getNotion().pages.retrieve({ page_id: pageId }) as Promise<{
        last_edited_time?: string;
      }>,
      getNotion().blocks.children.list({ block_id: pageId, page_size: 50 }),
    ]);
    const lines: string[] = [];
    for (const b of children.results as Array<{
      type: string;
      [k: string]: unknown;
    }>) {
      const richContainer = b[b.type] as
        | { rich_text?: Array<{ plain_text?: string }> }
        | undefined;
      const text = (richContainer?.rich_text ?? [])
        .map((r) => r.plain_text ?? '')
        .join('')
        .trim();
      if (!text) continue;
      if (b.type === 'heading_1' || b.type === 'heading_2') {
        lines.push(`\n${text}\n`);
      } else if (b.type === 'numbered_list_item') {
        lines.push(`• ${text}`);
      } else if (b.type === 'bulleted_list_item') {
        lines.push(`• ${text}`);
      } else {
        lines.push(text);
      }
    }
    const body = lines.join('\n').trim();
    if (!body) return null;
    return {
      body,
      generated_at: page.last_edited_time ?? new Date().toISOString(),
    };
  } catch {
    // Notion unreachable or page missing — UI renders D-05 placeholder.
    return null;
  }
}

async function loadPriorities(): Promise<
  Array<{
    id: string;
    title: string;
    bolag: 'tale-forge' | 'outbehaving' | 'personal' | null;
    entity_id: string | null;
    entity_name: string | null;
  }>
> {
  const cmdCenterDb = process.env.NOTION_COMMAND_CENTER_DB_ID;
  if (!cmdCenterDb) return [];
  try {
    // Kevin's Command Center uses Swedish schema (verified via Notion API
    // 2026-04-27):
    //   title property    = 'Uppgift'
    //   priority property = 'Prioritet' (select: 🔴 Hög / 🟡 Medel / 🟢 Låg)
    //   status property   = 'Status' (select: 📥 Inbox / 🔥 Idag / 🔨 Pågår
    //                                / ✅ Klart / ⏳ Väntar / ❌ Skippat)
    //   bolag property    = 'Bolag' (select: Tale Forge / Outbehaving /
    //                                Personal / Other)
    // We surface tasks that are NOT Klart/Skippat and have a Prioritet set.
    // Ordering: Hög > Medel > Låg > none. Notion can't sort emoji selects
    // meaningfully, so we fetch up to 25 unfiltered-by-prio and rank in JS.
    const res = await getNotion().databases.query({
      database_id: cmdCenterDb,
      filter: {
        and: [
          {
            property: 'Status',
            select: { does_not_equal: '✅ Klart' },
          },
          {
            property: 'Status',
            select: { does_not_equal: '❌ Skippat' },
          },
          {
            property: 'Prioritet',
            select: { is_not_empty: true },
          },
        ],
      },
      page_size: 25,
    });
    const prioRank = (name: string | null): number => {
      if (!name) return 99;
      if (name.includes('Hög')) return 0;
      if (name.includes('Medel')) return 1;
      if (name.includes('Låg')) return 2;
      return 99;
    };
    const mapped = (res.results as Array<{ id: string; properties: Record<string, unknown> }>)
      .map((p) => {
        const props = p.properties as Record<string, unknown>;
        const titleProp = props['Uppgift'] as
          | { title?: Array<{ plain_text?: string }> }
          | undefined;
        const bolagProp = props['Bolag'] as { select?: { name?: string } } | undefined;
        const prioProp = props['Prioritet'] as { select?: { name?: string } } | undefined;
        const title = (titleProp?.title ?? [])
          .map((t) => t.plain_text ?? '')
          .join('')
          .trim();
        const rawBolag = bolagProp?.select?.name?.toLowerCase() ?? null;
        const bolag =
          rawBolag === 'tale forge' || rawBolag === 'tale-forge'
            ? ('tale-forge' as const)
            : rawBolag === 'outbehaving'
              ? ('outbehaving' as const)
              : rawBolag === 'personal'
                ? ('personal' as const)
                : null;
        return {
          id: p.id,
          title,
          bolag,
          entity_id: null,
          entity_name: null,
          _prio: prioRank(prioProp?.select?.name ?? null),
        };
      })
      .filter((r) => r.title.length > 0);
    mapped.sort((a, b) => a._prio - b._prio);
    return mapped.slice(0, 3).map((r) => {
      const { _prio: _, ...rest } = r;
      void _;
      return rest;
    });
  } catch {
    return [];
  }
}

async function loadDrafts(): Promise<
  Array<{
    id: string;
    entity: string;
    preview: string;
    from: string | null;
    subject: string | null;
    received_at: string;
  }>
> {
  const db = await getDb();
  const rows = await db
    .select({
      id: inboxIndex.id,
      title: inboxIndex.title,
      preview: inboxIndex.preview,
      payload: inboxIndex.payload,
      createdAt: inboxIndex.createdAt,
    })
    .from(inboxIndex)
    .where(ownerScoped(inboxIndex, and(eq(inboxIndex.status, 'pending'), eq(inboxIndex.kind, 'draft_reply'))!))
    .orderBy(desc(inboxIndex.createdAt))
    .limit(5);

  return rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const from = typeof payload['from'] === 'string' ? (payload['from'] as string) : null;
    const subject = typeof payload['subject'] === 'string' ? (payload['subject'] as string) : null;
    return {
      id: r.id,
      entity: r.title,
      preview: r.preview,
      from,
      subject,
      received_at: r.createdAt.toISOString(),
    };
  });
}

async function loadDropped(): Promise<
  Array<{
    id: string;
    entity_id: string;
    entity: string;
    age_days: number;
    bolag: 'tale-forge' | 'outbehaving' | 'personal' | null;
  }>
> {
  const db = await getDb();
  const rows = (await db.execute(sql`
    SELECT
      id::text AS id,
      id::text AS entity_id,
      name AS entity,
      EXTRACT(EPOCH FROM (now() - last_touch)) / 86400.0 AS age_days,
      CASE
        WHEN lower(org) IN ('tale forge','tale-forge') THEN 'tale-forge'
        WHEN lower(org) = 'outbehaving' THEN 'outbehaving'
        WHEN lower(org) = 'personal' THEN 'personal'
        ELSE NULL
      END AS bolag
    FROM entity_index
    WHERE owner_id = ${OWNER_ID}
      AND last_touch IS NOT NULL
      AND last_touch < now() - interval '7 days'
      AND status = 'active'
    ORDER BY last_touch DESC
    LIMIT 10
  `)) as unknown as {
    rows: Array<{
      id: string;
      entity_id: string;
      entity: string;
      age_days: string | number;
      bolag: string | null;
    }>;
  };

  return rows.rows.map((r) => ({
    id: r.id,
    entity_id: r.entity_id,
    entity: r.entity,
    age_days: typeof r.age_days === 'string' ? Number(r.age_days) : r.age_days,
    bolag: (r.bolag as 'tale-forge' | 'outbehaving' | 'personal' | null) ?? null,
  }));
}

/**
 * Phase 11 D-07: surface ALL of today's captures (not just urgent email
 * drafts). UNION across the five tables that hold inbound capture artifacts
 * for the current Europe/Stockholm day. The `capture_text` and
 * `capture_voice` tables referenced in earlier RESEARCH notes DO NOT EXIST
 * (Wave 0 schema verification — 11-WAVE-0-SCHEMA-VERIFICATION.md).
 *
 * Sources covered:
 *   - email_drafts          (subject / classification / received_at)
 *   - mention_events        (source / context / occurred_at)
 *   - event_log             (kind / detail->>summary / occurred_at)
 *   - inbox_index           (kind / preview / created_at)
 *   - telegram_inbox_queue  (reason / body / queued_at)
 *
 * LIMIT 100 caps payload size; every row is owner-scoped to defend against
 * any future relaxation of the Lambda auth boundary (T-11-04-04).
 */
async function loadCapturesToday(db: NodePgDatabase): Promise<TodayCaptureItem[]> {
  const r = (await db.execute(sql`
    WITH today_window AS (
      SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AS d_start
    )
    SELECT 'email' AS source,
           id::text AS id,
           COALESCE(draft_subject, subject, '(no subject)') AS title,
           classification AS detail,
           received_at::text AS at
      FROM email_drafts, today_window
      WHERE owner_id = ${OWNER_ID}::uuid AND received_at >= d_start
    UNION ALL
    SELECT 'mention' AS source,
           id::text,
           source AS title,
           context AS detail,
           occurred_at::text AS at
      FROM mention_events, today_window
      WHERE owner_id = ${OWNER_ID}::uuid AND occurred_at >= d_start
    UNION ALL
    SELECT 'event' AS source,
           id::text,
           kind AS title,
           COALESCE(detail->>'summary', detail->>'title', detail::text) AS detail,
           occurred_at::text AS at
      FROM event_log, today_window
      WHERE owner_id = ${OWNER_ID}::uuid AND occurred_at >= d_start
        -- Filter out indexer heartbeat noise. notion-indexed-other is
        -- emitted by notion-indexer every 5 min for every command_center
        -- page it sees and completely drowns out real captures. Same for
        -- other internal signal events that are not user-visible captures.
        AND kind NOT IN (
          'notion-indexed-other',
          'notion-write-confirmed',
          'capture.received',
          'agent-run-started',
          'agent-run-finished'
        )
    UNION ALL
    SELECT 'inbox' AS source,
           id::text,
           kind AS title,
           preview AS detail,
           created_at::text AS at
      FROM inbox_index, today_window
      WHERE owner_id = ${OWNER_ID}::uuid AND created_at >= d_start
    UNION ALL
    SELECT 'telegram_queue' AS source,
           id::text,
           reason AS title,
           body AS detail,
           queued_at::text AS at
      FROM telegram_inbox_queue, today_window
      WHERE owner_id = ${OWNER_ID}::uuid AND queued_at >= d_start
    ORDER BY at DESC
    LIMIT 100
  `)) as unknown as {
    rows: Array<{
      source: string;
      id: string;
      title: string | null;
      detail: string | null;
      at: string;
    }>;
  };
  return r.rows.map((row) => ({
    source: row.source as TodayCaptureItem['source'],
    id: row.id,
    title: row.title ?? '(untitled)',
    detail: row.detail,
    at: row.at,
  }));
}

/**
 * Phase 11 Plan 11-04: aggregate counts powering the StatTileStrip.
 *
 * - drafts_pending  → email_drafts in 'draft' or 'edited' status
 * - entities_active → entity_index with status='active'
 * - events_upcoming → calendar_events_cache rows starting in next 7 days
 *                     (excluding ignored-by-Kevin)
 *
 * captures_today is filled in by the handler from the captures array length
 * (the source data is already loaded for the captures section — no need to
 * re-query).
 */
async function loadStatTiles(
  db: NodePgDatabase,
  capturesCount: number,
): Promise<StatTileData> {
  const r = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM email_drafts
        WHERE owner_id = ${OWNER_ID}::uuid AND status IN ('draft','edited')) AS drafts_pending,
      (SELECT COUNT(*) FROM entity_index
        WHERE owner_id = ${OWNER_ID}::uuid AND status = 'active') AS entities_active,
      (SELECT COUNT(*) FROM calendar_events_cache
        WHERE owner_id = ${OWNER_ID}::uuid
          AND start_utc >= now()
          AND start_utc < now() + interval '7 days'
          AND ignored_by_kevin = false) AS events_upcoming
  `)) as unknown as {
    rows: Array<{
      drafts_pending: string | number;
      entities_active: string | number;
      events_upcoming: string | number;
    }>;
  };
  const row = r.rows[0] ?? {
    drafts_pending: 0,
    entities_active: 0,
    events_upcoming: 0,
  };
  return {
    captures_today: capturesCount,
    drafts_pending: Number(row.drafts_pending),
    entities_active: Number(row.entities_active),
    events_upcoming: Number(row.events_upcoming),
  };
}

/**
 * Phase 11 D-07: snapshot of capture-channel health.
 *
 * Wave 0 verified that `agent_runs.agent_name` is fine-grained enough to
 * derive per-channel health without parsing `output_json`. Map of
 * Kevin-facing channel name → expected `agent_name` + max acceptable age:
 *
 *   - Telegram → `triage` runs whenever a Telegram capture is processed; a
 *     ≤24h freshness window matches Kevin's actual usage cadence.
 *   - Gmail   → `gmail-poller` runs every ~15 min; degraded after 30 min.
 *   - Granola → `granola-poller` runs hourly; degraded after 60 min.
 *   - Calendar → `calendar-reader` runs every ~30 min; degraded after 90.
 *
 * Status thresholds:
 *   healthy   ≤ max_age_min
 *   degraded  ≤ 2 × max_age_min
 *   down      > 2 × max_age_min  OR  no successful run on record
 *
 * Plan 11-06 will own a richer `/integrations/health` endpoint with full
 * scheduler+channel rollup. This snapshot is inlined for round-trip economy.
 */
async function loadTodayChannels(db: NodePgDatabase): Promise<ChannelItem[]> {
  const expectedAgents: Array<{
    name: string;
    agent_name: string;
    max_age_min: number;
  }> = [
    { name: 'Telegram', agent_name: 'triage', max_age_min: 1440 },
    { name: 'Gmail', agent_name: 'gmail-poller', max_age_min: 30 },
    { name: 'Granola', agent_name: 'granola-poller', max_age_min: 60 },
    { name: 'Calendar', agent_name: 'calendar-reader', max_age_min: 90 },
  ];
  const r = (await db.execute(sql`
    SELECT agent_name, MAX(finished_at)::text AS last_finished
      FROM agent_runs
      WHERE owner_id = ${OWNER_ID}::uuid AND status = 'ok'
      GROUP BY agent_name
  `)) as unknown as {
    rows: Array<{ agent_name: string; last_finished: string | null }>;
  };
  const map = new Map<string, string | null>(
    r.rows.map((row) => [row.agent_name, row.last_finished]),
  );
  const now = Date.now();
  return expectedAgents.map((spec) => {
    const last = map.get(spec.agent_name) ?? null;
    let status: ChannelItem['status'];
    if (!last) {
      status = 'down';
    } else {
      const ageMin = (now - new Date(last).getTime()) / 60_000;
      if (ageMin > spec.max_age_min * 2) status = 'down';
      else if (ageMin > spec.max_age_min) status = 'degraded';
      else status = 'healthy';
    }
    return {
      name: spec.name,
      type: 'capture' as const,
      status,
      last_event_at: last ? new Date(last).toISOString() : null,
    };
  });
}

async function loadMeetings(db: NodePgDatabase): Promise<
  Array<{
    id: string;
    start_at: string;
    end_at: string;
    title: string;
    is_now: boolean;
    bolag: 'tale-forge' | 'outbehaving' | 'personal' | null;
  }>
> {
  // Today's meetings (Europe/Stockholm day boundaries).
  const r = (await db.execute(sql`
    WITH today_window AS (
      SELECT
        date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm')
          AT TIME ZONE 'Europe/Stockholm' AS d_start,
        (date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm')
          + interval '1 day') AT TIME ZONE 'Europe/Stockholm' AS d_end
    )
    SELECT event_id::text AS id,
           start_utc::text AS start_at,
           end_utc::text AS end_at,
           COALESCE(summary, '(no title)') AS title,
           (now() BETWEEN start_utc AND end_utc) AS is_now
      FROM calendar_events_cache, today_window
      WHERE owner_id = ${OWNER_ID}::uuid
        AND start_utc >= d_start
        AND start_utc < d_end
        AND ignored_by_kevin = false
      ORDER BY start_utc ASC
      LIMIT 10
  `)) as unknown as {
    rows: Array<{
      id: string;
      start_at: string;
      end_at: string;
      title: string;
      is_now: boolean;
    }>;
  };
  return r.rows.map((row) => ({
    ...row,
    bolag: null,
  }));
}

async function todayHandler(_ctx: Ctx): Promise<RouteResponse> {
  const db = await getDb();
  const [brief, priorities, drafts, dropped, meetings, captures, channels] =
    await Promise.all([
      loadBrief(),
      loadPriorities(),
      loadDrafts(),
      loadDropped(),
      loadMeetings(db),
      loadCapturesToday(db),
      loadTodayChannels(db),
    ]);
  // stat_tiles needs the captures count, so it runs after the parallel block.
  const stat_tiles = await loadStatTiles(db, captures.length);

  const payload = TodayResponseSchema.parse({
    brief,
    priorities,
    drafts,
    dropped,
    meetings,
    captures_today: captures,
    stat_tiles,
    channels,
  });

  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=86400',
    },
  };
}

register('GET', '/today', todayHandler);

export { todayHandler };
