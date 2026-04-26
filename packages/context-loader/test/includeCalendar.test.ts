/**
 * includeCalendar.test.ts — loadContext({ includeCalendar }) behaviour
 * (Plan 08-01 Task 2).
 *
 * Behavioural coverage:
 *   1. loadContext({ includeCalendar: true }) invokes loadCalendarWindow
 *      with a 48 h horizon.
 *   2. loadContext WITHOUT includeCalendar does NOT query
 *      calendar_events_cache (assertable via SQL hit-counter).
 *   3. Calendar rows merged into assembled_markdown as the
 *      `## Today + Tomorrow Calendar` section.
 *   4. Empty calendar window → section OMITTED entirely (don't pollute
 *      the prompt with a bare heading).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadContext } from '../src/loadContext.js';

const OWNER = '00000000-0000-0000-0000-000000000001';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  hits: Record<string, number>;
}

function makeMockPool(opts: {
  calendarRows?: Array<Record<string, unknown>>;
}): MockPool {
  const hits: Record<string, number> = {
    calendar_events_cache: 0,
    other: 0,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM calendar_events_cache')) {
      hits.calendar_events_cache = (hits.calendar_events_cache ?? 0) + 1;
      return {
        rows: opts.calendarRows ?? [],
        rowCount: opts.calendarRows?.length ?? 0,
      };
    }
    hits.other = (hits.other ?? 0) + 1;
    return { rows: [], rowCount: 0 };
  });
  return { query, hits };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('loadContext + includeCalendar flag', () => {
  it('includeCalendar: true → SQL hits calendar_events_cache with 48 h window param', async () => {
    const pool = makeMockPool({
      calendarRows: [
        {
          event_id: 'e1',
          account: 'kevin-elzarka',
          summary: 'Damien sync',
          start_utc: '2026-04-25T09:00:00Z',
          end_utc: '2026-04-25T10:00:00Z',
          timezone: 'Europe/Stockholm',
          attendees_json: [],
          is_all_day: false,
        },
      ],
    });
    let capturedHours: number | undefined;
    pool.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM calendar_events_cache')) {
        capturedHours = params[1] as number;
        pool.hits.calendar_events_cache =
          (pool.hits.calendar_events_cache ?? 0) + 1;
        return {
          rows: [
            {
              event_id: 'e1',
              account: 'kevin-elzarka',
              summary: 'Damien sync',
              start_utc: '2026-04-25T09:00:00Z',
              end_utc: '2026-04-25T10:00:00Z',
              timezone: 'Europe/Stockholm',
              attendees_json: [],
              is_all_day: false,
            },
          ],
          rowCount: 1,
        };
      }
      pool.hits.other = (pool.hits.other ?? 0) + 1;
      return { rows: [], rowCount: 0 };
    });

    const bundle = await loadContext({
      entityIds: [],
      agentName: 'morning-brief',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
      includeCalendar: true,
    });

    expect(pool.hits.calendar_events_cache).toBe(1);
    expect(capturedHours).toBe(48);
    expect(bundle.calendar_window).toBeDefined();
    expect(bundle.calendar_window).toHaveLength(1);
  });

  it('without includeCalendar → calendar_events_cache NOT queried', async () => {
    const pool = makeMockPool({});
    const bundle = await loadContext({
      entityIds: [],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
    });

    expect(pool.hits.calendar_events_cache ?? 0).toBe(0);
    expect(bundle.calendar_window).toBeUndefined();
  });

  it('calendar rows merged into assembled_markdown as the calendar heading', async () => {
    const pool = makeMockPool({
      calendarRows: [
        {
          event_id: 'e1',
          account: 'kevin-elzarka',
          summary: 'Damien sync',
          start_utc: '2026-04-25T09:00:00Z',
          end_utc: '2026-04-25T10:00:00Z',
          timezone: 'Europe/Stockholm',
          attendees_json: [],
          is_all_day: false,
        },
      ],
    });

    const bundle = await loadContext({
      entityIds: [],
      agentName: 'morning-brief',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
      includeCalendar: true,
    });

    expect(bundle.assembled_markdown).toContain('## Today + Tomorrow Calendar');
    expect(bundle.assembled_markdown).toContain('Damien sync');
  });

  it('empty calendar window → calendar section omitted from markdown', async () => {
    const pool = makeMockPool({ calendarRows: [] });

    const bundle = await loadContext({
      entityIds: [],
      agentName: 'morning-brief',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
      includeCalendar: true,
    });

    expect(bundle.assembled_markdown).not.toContain('## Today + Tomorrow Calendar');
    // calendar_window is still set (so the caller can distinguish "asked but
    // empty" from "did not ask") — just an empty array.
    expect(bundle.calendar_window).toEqual([]);
  });
});
