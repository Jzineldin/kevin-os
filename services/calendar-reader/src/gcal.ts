/**
 * Google Calendar v3 events.list wrapper (Plan 08-01 Task 1).
 *
 * Native fetch (no `googleapis` SDK — keeps the Lambda bundle <2 MB and
 * sidesteps the `@google-cloud/auth-library` peer-dep tree). Single
 * exported entry: `fetchEventsWindow`.
 *
 * RESEARCH §2 + §3 (Phase 8):
 *   - Use `singleEvents=true` so recurring events are expanded into
 *     individual instances inside the window. Without this, recurring
 *     events surface as a single "master" row + RRULE which is hostile
 *     to the cache shape (the cache stores concrete instances).
 *   - `orderBy=startTime` requires `singleEvents=true` (Google API rule).
 *   - `maxResults=250` is the API max per page; for our 49 h window the
 *     practical event count is well below that, so a single fetch covers
 *     the typical case.
 *
 * 401 handling:
 *   - On 401 the function throws an Error with `code='auth_stale'`. The
 *     caller (handler.ts) maps this to `invalidateToken()` + retry, then
 *     gives up if the retry also 401s. The handler never logs the access
 *     token (T-08-CAL-03 mitigation).
 */

export interface GcalEvent {
  event_id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start_utc: string; // ISO 8601 UTC
  end_utc: string;
  timezone: string;
  attendees: Array<{ email: string; display_name: string | null }>;
  is_all_day: boolean;
  updated_at: string;
}

export interface FetchEventsArgs {
  accessToken: string;
  timeMinIso: string;
  timeMaxIso: string;
  calendarId?: string;
}

interface RawAttendee {
  email?: string;
  displayName?: string;
}

interface RawEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: RawAttendee[];
  updated?: string;
}

export class GcalAuthStaleError extends Error {
  code = 'auth_stale' as const;
  constructor(message = 'gcal auth stale') {
    super(message);
    this.name = 'GcalAuthStaleError';
  }
}

export async function fetchEventsWindow(args: FetchEventsArgs): Promise<GcalEvent[]> {
  const calendarId = args.calendarId ?? 'primary';
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId,
    )}/events`,
  );
  url.searchParams.set('timeMin', args.timeMinIso);
  url.searchParams.set('timeMax', args.timeMaxIso);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  if (r.status === 401) {
    throw new GcalAuthStaleError(`gcal events.list 401 on ${calendarId}`);
  }
  if (!r.ok) {
    throw new Error(`gcal events.list ${r.status}: ${await r.text()}`);
  }
  const body = (await r.json()) as { items?: RawEvent[] };
  const items = body.items ?? [];
  const out: GcalEvent[] = [];
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    if (!ev.id) continue;
    const mapped = mapEvent(ev);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapEvent(ev: RawEvent): GcalEvent | null {
  const isAllDay = Boolean(ev.start?.date);
  const startStr = isAllDay ? ev.start?.date : ev.start?.dateTime;
  const endStr = isAllDay ? ev.end?.date : ev.end?.dateTime;
  if (!startStr || !endStr) return null;

  const startUtc = isAllDay
    ? new Date(`${startStr}T00:00:00Z`).toISOString()
    : new Date(startStr).toISOString();
  const endUtc = isAllDay
    ? new Date(`${endStr}T00:00:00Z`).toISOString()
    : new Date(endStr).toISOString();

  return {
    event_id: ev.id!,
    summary: ev.summary ?? '(no title)',
    description: ev.description ?? null,
    location: ev.location ?? null,
    start_utc: startUtc,
    end_utc: endUtc,
    timezone: ev.start?.timeZone ?? 'Europe/Stockholm',
    attendees: (ev.attendees ?? [])
      .filter((a) => typeof a.email === 'string' && a.email.length > 0)
      .map((a) => ({
        email: a.email!,
        display_name: a.displayName ?? null,
      })),
    is_all_day: isAllDay,
    updated_at: ev.updated ?? new Date().toISOString(),
  };
}
