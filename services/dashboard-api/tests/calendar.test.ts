/**
 * Calendar handler contract + filter tests.
 *
 * Verifies that:
 *   - With no NOTION_COMMAND_CENTER_DB_ID the handler returns an empty
 *     events array (so Vercel preview without the env var still renders).
 *   - With an injected Notion fake, Deadline + Idag rows both materialise;
 *     rows outside the [start, end) window are dropped; bolag tint + linked
 *     entity id round-trip cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalendarWeekResponseSchema } from '@kos/contracts/dashboard';
import { __clearRoutesForTest } from '../src/router.js';
import { __setNotionForTest } from '../src/notion.js';

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
    ({ calendarWeekHandler } = await import('../src/handlers/calendar.js'));
  });
  afterEach(() => {
    __setNotionForTest(null);
    delete process.env.NOTION_COMMAND_CENTER_DB_ID;
  });

  it('returns empty events when NOTION_COMMAND_CENTER_DB_ID is unset', async () => {
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
