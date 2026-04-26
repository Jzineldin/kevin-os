/**
 * Calendar window helper for the context-loader (Plan 08-01 Task 2 / D-11).
 *
 * Reads `calendar_events_cache` for the today + tomorrow horizon (default
 * 48h) and renders the rows as a markdown section. Used by:
 *   - AGT-04 loadContext({ includeCalendar: true }) — Phase 7 morning brief
 *     + Phase 8 mutation-proposer (D-28).
 *
 * `ignored_by_kevin = false` is enforced at SELECT time so the
 * cancel_meeting mutation flip-flag actually hides events from agent
 * prompts (D-15 / D-32).
 */
import type { Pool as PgPool } from 'pg';

export interface CalendarWindowAttendee {
  email: string;
  display_name: string | null;
}

export interface CalendarWindowRow {
  event_id: string;
  account: string;
  summary: string;
  start_utc: string;
  end_utc: string;
  timezone: string;
  attendees_json: CalendarWindowAttendee[];
  is_all_day: boolean;
}

const DEFAULT_WINDOW_HOURS = 48;

/**
 * SELECT calendar_events_cache rows for [now, now + windowHours] for the
 * given owner. Skips rows flipped to `ignored_by_kevin = true` by the
 * cancel_meeting mutation (D-08 / D-15).
 *
 * Sort order is start_utc ASC so consumers can pretty-print without re-sort.
 */
export async function loadCalendarWindow(
  pool: PgPool,
  ownerId: string,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): Promise<CalendarWindowRow[]> {
  const r = await pool.query<{
    event_id: string;
    account: string;
    summary: string;
    start_utc: string;
    end_utc: string;
    timezone: string;
    attendees_json: CalendarWindowAttendee[] | string | null;
    is_all_day: boolean;
  }>(
    `SELECT event_id,
            account,
            summary,
            start_utc::text AS start_utc,
            end_utc::text   AS end_utc,
            timezone,
            attendees_json,
            is_all_day
       FROM calendar_events_cache
      WHERE owner_id = $1
        AND ignored_by_kevin = false
        AND start_utc BETWEEN now() AND now() + ($2::int || ' hours')::interval
      ORDER BY start_utc ASC`,
    [ownerId, windowHours],
  );
  return r.rows.map((row) => ({
    event_id: row.event_id,
    account: row.account,
    summary: row.summary,
    start_utc: row.start_utc,
    end_utc: row.end_utc,
    timezone: row.timezone,
    attendees_json: normaliseAttendees(row.attendees_json),
    is_all_day: row.is_all_day,
  }));
}

function normaliseAttendees(
  raw: CalendarWindowAttendee[] | string | null,
): CalendarWindowAttendee[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Some pg drivers return jsonb as a string; defensively parse.
  try {
    const parsed = JSON.parse(raw) as CalendarWindowAttendee[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Render the calendar rows as a `## Today + Tomorrow Calendar` markdown
 * block. Returns the empty string when `rows` is empty so the caller can
 * skip emitting the heading (don't pollute the prompt with bare headings).
 */
export function formatCalendarMarkdown(rows: CalendarWindowRow[]): string {
  if (rows.length === 0) return '';
  const lines: string[] = ['## Today + Tomorrow Calendar', ''];
  for (const r of rows) {
    const when = formatWhen(r);
    const who =
      r.attendees_json.length > 0
        ? ` w/ ${r.attendees_json
            .slice(0, 4)
            .map((a) => a.display_name ?? a.email)
            .join(', ')}`
        : '';
    lines.push(`- ${when} [${r.account}] ${r.summary}${who}`);
  }
  return lines.join('\n');
}

function formatWhen(r: CalendarWindowRow): string {
  if (r.is_all_day) {
    return `${r.start_utc.slice(0, 10)} (all day)`;
  }
  // Render in the event's own timezone so morning brief reads "11:00 Damien"
  // not "09:00Z Damien". Falls back to UTC if Intl rejects an exotic tz.
  try {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: r.timezone,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    return fmt.format(new Date(r.start_utc));
  } catch {
    return new Date(r.start_utc).toISOString();
  }
}
