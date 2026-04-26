/**
 * gcal.test.ts — events.list wrapper (Plan 08-01 Task 1).
 *
 * Behavioural coverage:
 *   1. fetchEventsWindow GETs /calendar/v3/calendars/primary/events with
 *      timeMin, timeMax, singleEvents=true, orderBy=startTime, maxResults=250.
 *   2. Response mapped to GcalEvent[] including all_day handling
 *      (start.date vs start.dateTime).
 *   3. Bearer token header is set from the input access_token.
 *   4. 401 → throws an Error with code='auth_stale' (caller does retry).
 *   5. Recurring event expansion respected (singleEvents=true in URL).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GCAL_EVENTS_LIST_PRIMARY } from '@kos/test-fixtures';
import { fetchEventsWindow } from '../src/gcal.js';

beforeEach(() => {
  (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn();
});

function mockJsonResponse(status: number, body: unknown): void {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe('fetchEventsWindow', () => {
  it('GETs the v3 events endpoint with the documented query params', async () => {
    mockJsonResponse(200, GCAL_EVENTS_LIST_PRIMARY);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await fetchEventsWindow({
      accessToken: 'tok',
      timeMinIso: '2026-04-25T09:00:00.000Z',
      timeMaxIso: '2026-04-27T09:00:00.000Z',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(
      /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/,
    );
    expect(url).toContain('timeMin=2026-04-25T09%3A00%3A00.000Z');
    expect(url).toContain('timeMax=2026-04-27T09%3A00%3A00.000Z');
    expect(url).toContain('singleEvents=true');
    expect(url).toContain('orderBy=startTime');
    expect(url).toContain('maxResults=250');
  });

  it('maps both timed events and all-day events into the GcalEvent shape', async () => {
    mockJsonResponse(200, GCAL_EVENTS_LIST_PRIMARY);

    const events = await fetchEventsWindow({
      accessToken: 'tok',
      timeMinIso: '2026-04-25T00:00:00.000Z',
      timeMaxIso: '2026-04-29T00:00:00.000Z',
    });

    expect(events).toHaveLength(2);

    const timed = events.find((e) => e.event_id === 'gcal-evt-001')!;
    expect(timed.is_all_day).toBe(false);
    expect(timed.summary).toBe('Damien sync');
    expect(timed.timezone).toBe('Europe/Stockholm');
    expect(new Date(timed.start_utc).toISOString()).toBe('2026-04-25T09:00:00.000Z');
    expect(new Date(timed.end_utc).toISOString()).toBe('2026-04-25T10:00:00.000Z');
    expect(timed.attendees).toEqual([
      { email: 'damien@outbehaving.com', display_name: 'Damien Hateley' },
    ]);

    const allDay = events.find((e) => e.event_id === 'gcal-evt-002')!;
    expect(allDay.is_all_day).toBe(true);
    expect(allDay.summary).toBe('Almi bolagsstämma');
    expect(allDay.start_utc).toBe('2026-04-28T00:00:00.000Z');
    expect(allDay.end_utc).toBe('2026-04-28T00:00:00.000Z');
    expect(allDay.description).toBeNull();
    expect(allDay.location).toBeNull();
  });

  it('passes the bearer token via Authorization header', async () => {
    mockJsonResponse(200, { items: [] });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await fetchEventsWindow({
      accessToken: 'access-tok-XYZ',
      timeMinIso: '2026-04-25T00:00:00.000Z',
      timeMaxIso: '2026-04-26T00:00:00.000Z',
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-tok-XYZ');
  });

  it('401 surfaces a thrown error with code="auth_stale"', async () => {
    mockJsonResponse(401, { error: { message: 'Invalid Credentials' } });

    let caught: unknown = null;
    try {
      await fetchEventsWindow({
        accessToken: 'stale',
        timeMinIso: '2026-04-25T00:00:00.000Z',
        timeMaxIso: '2026-04-26T00:00:00.000Z',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('auth_stale');
  });

  it('singleEvents=true in URL → recurring events are expanded by Google API', async () => {
    // Emulate Google's expanded shape: same RRULE master would have collapsed
    // into one row; with singleEvents=true the API returns N concrete instances.
    mockJsonResponse(200, {
      items: [
        {
          id: 'occ-2026-04-25',
          summary: 'Weekly Damien',
          start: { dateTime: '2026-04-25T11:00:00+02:00', timeZone: 'Europe/Stockholm' },
          end: { dateTime: '2026-04-25T12:00:00+02:00', timeZone: 'Europe/Stockholm' },
          updated: '2026-04-20T09:00:00Z',
          status: 'confirmed',
        },
        {
          id: 'occ-2026-05-02',
          summary: 'Weekly Damien',
          start: { dateTime: '2026-05-02T11:00:00+02:00', timeZone: 'Europe/Stockholm' },
          end: { dateTime: '2026-05-02T12:00:00+02:00', timeZone: 'Europe/Stockholm' },
          updated: '2026-04-20T09:00:00Z',
          status: 'confirmed',
        },
      ],
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    const events = await fetchEventsWindow({
      accessToken: 'tok',
      timeMinIso: '2026-04-25T00:00:00.000Z',
      timeMaxIso: '2026-05-10T00:00:00.000Z',
    });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event_id)).toEqual([
      'occ-2026-04-25',
      'occ-2026-05-02',
    ]);
    // Sanity-check the URL has singleEvents=true (caller's contract with Google).
    expect(String(fetchMock.mock.calls[0]![0])).toContain('singleEvents=true');
  });
});
