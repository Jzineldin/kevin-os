/**
 * GET /calendar/week?start=<iso>&end=<iso>
 *
 * Returns Command Center rows whose `Deadline` OR `Idag` date property
 * falls inside [start, end). Phase 3 data source is Command Center only —
 * Google Calendar merge is Phase 8 (CAP-09) per CONTEXT D-04.
 *
 * Response validated against CalendarWeekResponseSchema before return
 * (zod at exit catches accidental shape drift).
 */
import { CalendarWeekResponseSchema } from '@kos/contracts/dashboard';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getNotion } from '../notion.js';

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

async function calendarWeekHandler(ctx: Ctx): Promise<RouteResponse> {
  const now = new Date();
  const start = safeDate(ctx.query['start'], now);
  const end = safeDate(
    ctx.query['end'],
    new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
  );

  const dbId = process.env.NOTION_COMMAND_CENTER_DB_ID;
  if (!dbId) {
    const body = CalendarWeekResponseSchema.parse({
      start: start.toISOString(),
      end: end.toISOString(),
      events: [],
    });
    return { statusCode: 200, body: JSON.stringify(body) };
  }

  const rows = await queryCommandCenter(dbId, start, end);

  const events = rows.flatMap((p) => {
    const props = p.properties ?? {};
    const title = extractTitle(props);
    const bolag = extractBolag(props);
    const linkedEntityId = extractLinkedEntity(props);

    const deadline = extractDate(props, 'Deadline');
    const idag = extractDate(props, 'Idag');

    const out: Array<{
      id: string;
      title: string;
      start_at: string;
      end_at: string;
      linked_entity_id: string | null;
      bolag: Bolag | null;
      source: 'command_center_deadline' | 'command_center_idag';
    }> = [];

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
