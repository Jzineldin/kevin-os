/**
 * calendar.test.ts — loadCalendarWindow + formatCalendarMarkdown
 * (Plan 08-01 Task 2).
 *
 * Behavioural coverage:
 *   1. loadCalendarWindow SELECTs from calendar_events_cache filtering on
 *      owner_id + ignored_by_kevin=false + start_utc in window.
 *   2. Returns rows sorted ASC by start_utc (uses ORDER BY in SQL).
 *   3. windowHours parameter controls the WHERE-clause interval.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  loadCalendarWindow,
  formatCalendarMarkdown,
} from '../src/calendar.js';

const OWNER = '00000000-0000-0000-0000-000000000001';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

function makePool(rows: unknown[]): {
  query: ReturnType<typeof vi.fn>;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    captured.push({ sql, params });
    return { rows, rowCount: rows.length };
  });
  return { query, captured };
}

describe('loadCalendarWindow', () => {
  it('SELECTs calendar_events_cache filtering owner_id + ignored_by_kevin=false + window', async () => {
    const pool = makePool([]);
    await loadCalendarWindow(pool as never, OWNER);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const { sql, params } = pool.captured[0]!;
    expect(sql).toMatch(/FROM calendar_events_cache/);
    expect(sql).toMatch(/owner_id\s*=\s*\$1/);
    expect(sql).toMatch(/ignored_by_kevin\s*=\s*false/);
    expect(sql).toMatch(/start_utc\s+BETWEEN\s+now\(\)/);
    expect(params[0]).toBe(OWNER);
    // default window
    expect(params[1]).toBe(48);
  });

  it('returns rows sorted ASC by start_utc (SQL has ORDER BY start_utc ASC)', async () => {
    const pool = makePool([
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
      {
        event_id: 'e2',
        account: 'kevin-taleforge',
        summary: 'Almi review',
        start_utc: '2026-04-25T13:00:00Z',
        end_utc: '2026-04-25T14:00:00Z',
        timezone: 'Europe/Stockholm',
        attendees_json: [],
        is_all_day: false,
      },
    ]);
    const rows = await loadCalendarWindow(pool as never, OWNER);

    expect(rows).toHaveLength(2);
    expect(pool.captured[0]!.sql).toMatch(/ORDER BY start_utc ASC/);
    // Caller relies on the row order from the SQL — no client-side re-sort.
    expect(rows[0]!.event_id).toBe('e1');
    expect(rows[1]!.event_id).toBe('e2');
  });

  it('windowHours parameter is bound to the SQL', async () => {
    const pool = makePool([]);
    await loadCalendarWindow(pool as never, OWNER, 24);
    expect(pool.captured[0]!.params[1]).toBe(24);

    pool.captured.length = 0;
    pool.query.mockClear();
    await loadCalendarWindow(pool as never, OWNER, 12);
    expect(pool.captured[0]!.params[1]).toBe(12);
  });
});

describe('formatCalendarMarkdown', () => {
  it('returns empty string when rows is empty (no bare heading)', () => {
    expect(formatCalendarMarkdown([])).toBe('');
  });

  it('renders timed events + attendees + accounts', () => {
    const md = formatCalendarMarkdown([
      {
        event_id: 'e1',
        account: 'kevin-elzarka',
        summary: 'Damien sync',
        start_utc: '2026-04-25T09:00:00Z',
        end_utc: '2026-04-25T10:00:00Z',
        timezone: 'Europe/Stockholm',
        attendees_json: [
          { email: 'damien@outbehaving.com', display_name: 'Damien Hateley' },
        ],
        is_all_day: false,
      },
    ]);
    expect(md).toContain('## Today + Tomorrow Calendar');
    expect(md).toContain('[kevin-elzarka]');
    expect(md).toContain('Damien sync');
    expect(md).toContain('Damien Hateley');
  });

  it('renders all-day events with the (all day) marker', () => {
    const md = formatCalendarMarkdown([
      {
        event_id: 'e2',
        account: 'kevin-taleforge',
        summary: 'Almi bolagsstämma',
        start_utc: '2026-04-28T00:00:00Z',
        end_utc: '2026-04-28T00:00:00Z',
        timezone: 'Europe/Stockholm',
        attendees_json: [],
        is_all_day: true,
      },
    ]);
    expect(md).toContain('2026-04-28 (all day)');
  });
});
