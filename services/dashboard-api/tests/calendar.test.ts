/**
 * Calendar handler contract + filter tests.
 *
 * Verifies that:
 *   - With no NOTION_COMMAND_CENTER_DB_ID the handler returns events
 *     sourced ONLY from calendar_events_cache (so Vercel preview without
 *     Notion still renders Google meetings).
 *   - With an injected Notion fake, Deadline + Idag rows both materialise;
 *     rows outside the [start, end) window are dropped; bolag tint + linked
 *     entity id round-trip cleanly.
 *   - Phase 11 Plan 11-05: /calendar/week UNIONs Notion Command Center
 *     with calendar_events_cache (real Google meetings populated by the
 *     calendar-reader Lambda). Dedupe collapses same-minute + same-title
 *     events; Google source wins when both are present.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarWeekResponseSchema } from '@kos/contracts/dashboard';
import { __clearRoutesForTest } from '../src/router.js';
import { __setNotionForTest } from '../src/notion.js';

// db.ts is mocked at module scope so the handler's `await getDb()` returns
// our table-driven fake. Each test sets `googleCacheRows` to whatever
// calendar_events_cache rows it wants returned.
let googleCacheRows: Array<{
  event_id: string;
  account: string;
  start_utc: string;
  end_utc: string;
  summary: string;
}> = [];
const recordedQueries: Array<{ text: string }> = [];

function dbExecute(query: { sql: string } | string): Promise<{ rows: unknown[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = typeof query === 'string' ? query : (query as any).sql ?? JSON.stringify(query);
  recordedQueries.push({ text });
  if (text.includes('FROM calendar_events_cache')) {
    return Promise.resolve({
      rows: googleCacheRows.map((r) => ({
        // The handler aliases columns via SELECT … AS … — keep the alias
        // names here in sync with the production query.
        event_id: r.event_id,
        account: r.account,
        start_at: r.start_utc,
        end_at: r.end_utc,
        title: r.summary,
      })),
    });
  }
  return Promise.resolve({ rows: [] });
}

interface FakeDb {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}
const fakeDb: FakeDb = {
  execute: dbExecute as FakeDb['execute'],
};

vi.mock('../src/db.js', () => ({
  getDb: async () => fakeDb,
  __setDbForTest: () => {},
}));

// Import the handler AFTER __clearRoutesForTest is available so side-effect
// registration doesn't collide with other test suites.
let calendarWeekHandler: (typeof import('../src/handlers/calendar.js'))['calendarWeekHandler'];

const START_ISO = '2026-04-20T00:00:00.000Z'; // Monday
const END_ISO = '2026-04-27T00:00:00.000Z'; // Next Monday

type FakePage = { id: string; properties: Record<string, unknown> };

function buildNotionFake(pages: FakePage[]): import('@notionhq/client').Client {
  return {
    databases: {
      query: async () => ({ results: pages, has_more: false, next_cursor: null }),
    },
  } as unknown as import('@notionhq/client').Client;
}

describe('calendar /calendar/week', () => {
  beforeEach(async () => {
    __clearRoutesForTest();
    googleCacheRows = [];
    recordedQueries.length = 0;
    ({ calendarWeekHandler } = await import('../src/handlers/calendar.js'));
  });
  afterEach(() => {
    __setNotionForTest(null);
    delete process.env.NOTION_COMMAND_CENTER_DB_ID;
  });

  it('returns empty events when NOTION_COMMAND_CENTER_DB_ID is unset and cache is empty', async () => {
    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(CalendarWeekResponseSchema.parse(body).events).toEqual([]);
  });

  it('projects a Deadline row into a calendar event', async () => {
    process.env.NOTION_COMMAND_CENTER_DB_ID = 'fake-db';
    __setNotionForTest(
      buildNotionFake([
        {
          id: 'ccp-1',
          properties: {
            Name: { title: [{ plain_text: 'Investor deck v3' }] },
            Bolag: { select: { name: 'Tale Forge' } },
            Deadline: { date: { start: '2026-04-22T10:00:00.000Z', end: null } },
            Idag: { date: null },
            LinkedEntity: {
              relation: [{ id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c' }],
            },
          },
        },
      ]),
    );

    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    expect(res.statusCode).toBe(200);
    const body = CalendarWeekResponseSchema.parse(JSON.parse(res.body));
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      title: 'Investor deck v3',
      bolag: 'tale-forge',
      source: 'command_center_deadline',
      linked_entity_id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
    });
  });

  it('drops rows outside [start, end)', async () => {
    process.env.NOTION_COMMAND_CENTER_DB_ID = 'fake-db';
    __setNotionForTest(
      buildNotionFake([
        {
          id: 'ccp-future',
          properties: {
            Name: { title: [{ plain_text: 'Way later' }] },
            Bolag: { select: { name: 'Outbehaving' } },
            Deadline: { date: { start: '2026-06-01T10:00:00.000Z', end: null } },
            Idag: { date: null },
            LinkedEntity: { relation: [] },
          },
        },
      ]),
    );
    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    expect(res.statusCode).toBe(200);
    const body = CalendarWeekResponseSchema.parse(JSON.parse(res.body));
    expect(body.events).toEqual([]);
  });

  it('UNIONs Notion command center + calendar_events_cache', async () => {
    process.env.NOTION_COMMAND_CENTER_DB_ID = 'fake-db';
    __setNotionForTest(
      buildNotionFake([
        {
          id: 'ccp-1',
          properties: {
            Name: { title: [{ plain_text: 'Investor deck deadline' }] },
            Bolag: { select: { name: 'Tale Forge' } },
            Deadline: { date: { start: '2026-04-22T17:00:00.000Z', end: null } },
            Idag: { date: null },
            LinkedEntity: { relation: [] },
          },
        },
      ]),
    );
    googleCacheRows = [
      {
        event_id: 'evt-google-1',
        account: 'kevin-taleforge',
        start_utc: '2026-04-21T09:00:00.000Z',
        end_utc: '2026-04-21T10:00:00.000Z',
        summary: 'Damien call',
      },
      {
        event_id: 'evt-google-2',
        account: 'kevin-elzarka',
        start_utc: '2026-04-23T14:00:00.000Z',
        end_utc: '2026-04-23T15:00:00.000Z',
        summary: 'Almi sync',
      },
    ];

    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    expect(res.statusCode).toBe(200);
    const body = CalendarWeekResponseSchema.parse(JSON.parse(res.body));
    expect(body.events).toHaveLength(3);
    // Sorted ascending by start_at
    const starts = body.events.map((e) => e.start_at);
    expect(starts).toEqual([...starts].sort());
    const sources = body.events.map((e) => e.source).sort();
    expect(sources).toEqual([
      'command_center_deadline',
      'google_calendar',
      'google_calendar',
    ]);
    // calendar_events_cache query was actually run + scoped to the owner.
    const cacheQuery = recordedQueries.find((q) =>
      q.text.includes('FROM calendar_events_cache'),
    );
    expect(cacheQuery).toBeDefined();
    expect(cacheQuery!.text).toContain('owner_id');
    // Google rows surface with the account label intact.
    const googleEvent = body.events.find((e) => e.source === 'google_calendar');
    expect(googleEvent?.account).toMatch(/^kevin-(elzarka|taleforge)$/);
  });

  it('deduplicates same start-minute + title; Google wins over Notion CC', async () => {
    process.env.NOTION_COMMAND_CENTER_DB_ID = 'fake-db';
    // Notion has the same meeting at 2026-04-22T10:00:30 (30s drift, same title)
    __setNotionForTest(
      buildNotionFake([
        {
          id: 'ccp-dup',
          properties: {
            Name: { title: [{ plain_text: 'Damien call' }] },
            Bolag: { select: { name: 'Tale Forge' } },
            Deadline: { date: { start: '2026-04-22T10:00:30.000Z', end: null } },
            Idag: { date: null },
            LinkedEntity: { relation: [] },
          },
        },
      ]),
    );
    googleCacheRows = [
      {
        event_id: 'evt-google-1',
        account: 'kevin-taleforge',
        start_utc: '2026-04-22T10:00:00.000Z',
        end_utc: '2026-04-22T11:00:00.000Z',
        summary: 'Damien call',
      },
    ];

    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    const body = CalendarWeekResponseSchema.parse(JSON.parse(res.body));
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.source).toBe('google_calendar');
    expect(body.events[0]?.title).toBe('Damien call');
    expect(body.events[0]?.account).toBe('kevin-taleforge');
  });

  it('returns Notion events when calendar_events_cache is empty (no regression)', async () => {
    process.env.NOTION_COMMAND_CENTER_DB_ID = 'fake-db';
    __setNotionForTest(
      buildNotionFake([
        {
          id: 'ccp-1',
          properties: {
            Name: { title: [{ plain_text: 'Investor deck v3' }] },
            Bolag: { select: { name: 'Tale Forge' } },
            Deadline: { date: { start: '2026-04-22T10:00:00.000Z', end: null } },
            Idag: { date: null },
            LinkedEntity: { relation: [] },
          },
        },
        {
          id: 'ccp-2',
          properties: {
            Name: { title: [{ plain_text: 'Almi prep' }] },
            Bolag: { select: { name: 'Tale Forge' } },
            Deadline: { date: null },
            Idag: { date: { start: '2026-04-24T09:00:00.000Z', end: null } },
            LinkedEntity: { relation: [] },
          },
        },
      ]),
    );
    googleCacheRows = []; // empty cache

    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    const body = CalendarWeekResponseSchema.parse(JSON.parse(res.body));
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.source.startsWith('command_center_'))).toBe(true);
  });

  it('produces two events when both Deadline and Idag are set inside the window', async () => {
    process.env.NOTION_COMMAND_CENTER_DB_ID = 'fake-db';
    __setNotionForTest(
      buildNotionFake([
        {
          id: 'ccp-both',
          properties: {
            Name: { title: [{ plain_text: 'Double-booked' }] },
            Bolag: { select: { name: 'Personal' } },
            Deadline: { date: { start: '2026-04-21T09:00:00.000Z', end: null } },
            Idag: { date: { start: '2026-04-23T14:00:00.000Z', end: null } },
            LinkedEntity: { relation: [] },
          },
        },
      ]),
    );
    const res = await calendarWeekHandler({
      method: 'GET',
      path: '/calendar/week',
      params: {},
      query: { start: START_ISO, end: END_ISO },
      body: null,
      headers: {},
    });
    const body = CalendarWeekResponseSchema.parse(JSON.parse(res.body));
    expect(body.events).toHaveLength(2);
    const sources = body.events.map((e) => e.source).sort();
    expect(sources).toEqual(['command_center_deadline', 'command_center_idag']);
  });
});
