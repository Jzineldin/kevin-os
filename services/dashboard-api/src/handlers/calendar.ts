/**
 * GET /calendar/week?start=<iso>&end=<iso>
 *
 * Returns the UNION of:
 *   1. Notion Command Center rows whose `Deadline` OR `Idag` date
 *      property falls inside [start, end) — surfaced as deadline events.
 *   2. `calendar_events_cache` rows (real Google Calendar meetings
 *      mirrored every 30 min by the calendar-reader Lambda) whose
 *      `start_utc` falls inside [start, end) — surfaced as meeting events.
 *
 * Dedupe rule (mergeAndDedupeEvents): collapse rows that share the same
 * start-minute + normalised title; the Google Calendar source wins over
 * Notion CC when both contain a matching event (Google is canonical for
 * actual meetings; Notion CC is canonical for deadlines).
 *
 * Phase 11 Plan 11-05 closed the Google read-gap. Prior to this plan the
 * handler read Notion only, so live meetings on Kevin's two Google
 * accounts (kevin.elzarka@gmail.com + kevin@tale-forge.app) never
 * appeared on /calendar despite the calendar-reader Lambda being live
 * since Phase 8.
 *
 * Response validated against CalendarWeekResponseSchema before return
 * (zod at exit catches accidental shape drift).
 */
import { sql } from 'drizzle-orm';
import {
  CalendarWeekResponseSchema,
  type CalendarEvent,
} from '@kos/contracts/dashboard';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getNotion } from '../notion.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

type Bolag = 'tale-forge' | 'outbehaving' | 'personal';

function toBolag(s: string | null | undefined): Bolag | null {
  const k = (s ?? '').toLowerCase().trim();
  if (k === 'tale forge' || k === 'tale-forge') return 'tale-forge';
  if (k === 'outbehaving') return 'outbehaving';
  if (k === 'personal') return 'personal';
  return null;
}

function safeDate(raw: string | null | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Derive a 1-hour end time when the Notion row has a single-date property. */
function defaultEnd(start: Date): Date {
  return new Date(start.getTime() + 60 * 60 * 1000);
}

type NotionDate = { start?: string; end?: string | null } | null | undefined;

type NotionPage = {
  id: string;
  properties?: Record<string, unknown>;
};

function extractTitle(props: Record<string, unknown>): string {
  const titleProp = props['Name'] as
    | { title?: Array<{ plain_text?: string }> }
    | undefined;
  const out = (titleProp?.title ?? [])
    .map((t) => t.plain_text ?? '')
    .join('')
    .trim();
  return out || '(untitled)';
}

function extractDate(props: Record<string, unknown>, key: string): NotionDate {
  const dp = props[key] as { date?: NotionDate } | undefined;
  return dp?.date ?? null;
}

function extractBolag(props: Record<string, unknown>): Bolag | null {
  const bp = props['Bolag'] as { select?: { name?: string } } | undefined;
  return toBolag(bp?.select?.name);
}

function extractLinkedEntity(props: Record<string, unknown>): string | null {
  // Command Center's LinkedEntity is a Notion relation; we surface the
  // first related page-id as-is and the Vercel side looks up the UUID in
  // entity_index. For Phase 3 we pass the Notion page id through unchanged
  // when the Command Center carries an explicit UUID in a rollup/formula
  // field, otherwise null. Downstream clients coerce non-UUID strings to
  // null before routing (see CalendarWeekView).
  const rp = props['LinkedEntity'] as
    | { relation?: Array<{ id?: string }> }
    | undefined;
  const first = rp?.relation?.[0]?.id ?? null;
  if (!first) return null;
  // Notion relation IDs look like uuids (with dashes). Normalise + validate.
  const uuidLike = first.replace(/[^0-9a-f-]/gi, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuidLike)
    ? uuidLike
    : null;
}

async function queryCommandCenter(
  dbId: string,
  start: Date,
  end: Date,
): Promise<NotionPage[]> {
  try {
    const res = await getNotion().databases.query({
      database_id: dbId,
      filter: {
        or: [
          {
            property: 'Deadline',
            date: { on_or_after: start.toISOString() },
          },
          {
            property: 'Idag',
            date: { on_or_after: start.toISOString() },
          },
        ],
      },
      page_size: 100,
    });
    // Client-side filter the [start, end) upper bound — Notion's filter
    // grammar lets us do `before` but stacking two ranges per property via
    // `and` isn't worth the complexity at Kevin-scale (< 100 Command
    // Center rows).
    return (res.results as NotionPage[]).filter((p) => {
      const props = p.properties ?? {};
      const dl = extractDate(props, 'Deadline');
      const idag = extractDate(props, 'Idag');
      const pick = (d: NotionDate): Date | null =>
        d?.start ? safeDate(d.start, start) : null;
      const candidates = [pick(dl), pick(idag)].filter((d): d is Date => d !== null);
      return candidates.some((d) => d >= start && d < end);
    });
  } catch {
    return [];
  }
}

/**
 * Read real Google Calendar meetings from `calendar_events_cache` in the
 * [start, end) window for the single owner. The table is populated every
 * 30 min by the calendar-reader Lambda (Phase 8). `ignored_by_kevin`
 * rows are silently filtered — Kevin can mark a meeting "irrelevant"
 * once and stop seeing it.
 *
 * Defense-in-depth: explicit `owner_id = OWNER_ID` filter even though the
 * Lambda is single-user (T-11-05-04 mitigation, mirrors Plan 11-01 +
 * 11-04). Per WAVE-0-SCHEMA-VERIFICATION the column names are
 * `event_id`, `account`, `start_utc`, `end_utc`, `summary` (NOT the
 * `id/start_at/end_at/title/account_email` shape the plan assumed —
 * deviation Rule 3, schema-truth wins over plan text).
 */
async function queryCalendarEventsCache(
  start: Date,
  end: Date,
): Promise<CalendarEvent[]> {
  try {
    const db = await getDb();
    const r = (await db.execute(sql`
      SELECT
        event_id        AS event_id,
        account         AS account,
        start_utc::text AS start_at,
        end_utc::text   AS end_at,
        summary         AS title
      FROM calendar_events_cache
      WHERE owner_id = ${OWNER_ID}
        AND ignored_by_kevin = false
        AND start_utc >= ${start.toISOString()}::timestamptz
        AND start_utc <  ${end.toISOString()}::timestamptz
      ORDER BY start_utc ASC
    `)) as unknown as {
      rows: Array<{
        event_id: string;
        account: string;
        start_at: string;
        end_at: string;
        title: string;
      }>;
    };
    return r.rows.map((row) => ({
      // Synthetic id encodes the composite PK (event_id, account) so
      // dedupe and React keys remain stable across renders.
      id: `gcal:${row.account}:${row.event_id}`,
      title: row.title,
      start_at: new Date(row.start_at).toISOString(),
      end_at: new Date(row.end_at).toISOString(),
      linked_entity_id: null, // Google source has no Notion entity link
      bolag: null, // Google source carries no bolag tag yet
      source: 'google_calendar' as const,
      account: row.account,
    }));
  } catch {
    // Lambda preview / DB unreachable — degrade gracefully; the Notion
    // path still produces deadline events.
    return [];
  }
}

/**
 * Merge two event lists, deduplicating by (start-minute, title-normalized).
 * Google Calendar source wins over Notion CC when both contain a matching
 * event — Google is canonical for actual meetings; Notion CC for
 * deadlines.
 *
 * Sub-minute drift in Notion (e.g. 10:00:30 vs. Google 10:00:00) is
 * collapsed because we key by `YYYY-MM-DDTHH:MM` (truncated to the
 * minute). Different titles at the same minute remain distinct rows
 * (correct: two different things really did get scheduled together).
 */
function mergeAndDedupeEvents(
  notion: CalendarEvent[],
  google: CalendarEvent[],
): CalendarEvent[] {
  const keyOf = (e: CalendarEvent): string => {
    const startMinute = new Date(e.start_at).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    const norm = e.title.trim().toLowerCase().replace(/\s+/g, ' ');
    return `${startMinute}|${norm}`;
  };
  const merged = new Map<string, CalendarEvent>();
  // Insert Notion first (lower priority); Google then overrides on conflict.
  for (const e of notion) merged.set(keyOf(e), e);
  for (const e of google) merged.set(keyOf(e), e);
  return Array.from(merged.values()).sort(
    (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
  );
}

async function calendarWeekHandler(ctx: Ctx): Promise<RouteResponse> {
  const now = new Date();
  const start = safeDate(ctx.query['start'], now);
  const end = safeDate(
    ctx.query['end'],
    new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
  );

  const dbId = process.env.NOTION_COMMAND_CENTER_DB_ID;

  // Always read calendar_events_cache (Google) — even if Notion DB id is
  // unset, Google meetings should still surface. Run both queries in
  // parallel for latency.
  const [notionRows, googleEvents] = await Promise.all([
    dbId ? queryCommandCenter(dbId, start, end) : Promise.resolve<NotionPage[]>([]),
    queryCalendarEventsCache(start, end),
  ]);

  const notionEvents: CalendarEvent[] = notionRows.flatMap((p) => {
    const props = p.properties ?? {};
    const title = extractTitle(props);
    const bolag = extractBolag(props);
    const linkedEntityId = extractLinkedEntity(props);

    const deadline = extractDate(props, 'Deadline');
    const idag = extractDate(props, 'Idag');

    const out: CalendarEvent[] = [];

    if (deadline?.start) {
      const s = safeDate(deadline.start, start);
      const e = deadline.end ? safeDate(deadline.end, defaultEnd(s)) : defaultEnd(s);
      if (s >= start && s < end) {
        out.push({
          id: `${p.id}:deadline`,
          title,
          start_at: s.toISOString(),
          end_at: e.toISOString(),
          linked_entity_id: linkedEntityId,
          bolag,
          source: 'command_center_deadline',
        });
      }
    }

    if (idag?.start) {
      const s = safeDate(idag.start, start);
      const e = idag.end ? safeDate(idag.end, defaultEnd(s)) : defaultEnd(s);
      if (s >= start && s < end) {
        out.push({
          id: `${p.id}:idag`,
          title,
          start_at: s.toISOString(),
          end_at: e.toISOString(),
          linked_entity_id: linkedEntityId,
          bolag,
          source: 'command_center_idag',
        });
      }
    }

    return out;
  });

  const events = mergeAndDedupeEvents(notionEvents, googleEvents);

  const body = CalendarWeekResponseSchema.parse({
    start: start.toISOString(),
    end: end.toISOString(),
    events,
  });

  return {
    statusCode: 200,
    body: JSON.stringify(body),
    headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=60' },
  };
}

register('GET', '/calendar/week', calendarWeekHandler);

export { calendarWeekHandler };
