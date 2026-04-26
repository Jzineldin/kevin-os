/**
 * Today-response contract + handler tests.
 *
 * Two scopes:
 *
 *   1. Contract shape: TodayResponseSchema parses both old payloads (Phase 3
 *      five-section shape) and the new Phase 11 Plan 11-04 additive sections
 *      (`captures_today`, `stat_tiles`, `channels`).
 *
 *   2. Handler integration: vi.hoisted db.execute mock returns rows for the
 *      4-source UNION (email_drafts, event_log, mention_events, inbox_index,
 *      telegram_inbox_queue), the stat-tiles aggregate query, and the
 *      agent_runs channel-health aggregate. Handler is imported dynamically
 *      after `__clearRoutesForTest()` and called with an empty Ctx; we then
 *      assert the JSON payload contains all three new sections.
 *
 * Wave 0 deviation: the Plan 11-04 spec referenced `capture_text` and
 * `capture_voice` tables. Those tables DO NOT EXIST in prod (verified in
 * 11-WAVE-0-SCHEMA-VERIFICATION.md). Captures live across event_log,
 * mention_events, inbox_index, telegram_inbox_queue, and email_drafts. The
 * UNION is over those tables; the CaptureSourceSchema enum was updated
 * accordingly (`email | mention | event | inbox | telegram_queue`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TodayResponseSchema } from '@kos/contracts/dashboard';

// --- vi.hoisted mock surface (must precede vi.mock factories) -------------

// db.execute table-driven mock — discriminate by sql text substring.
const recordedQueries: Array<{ text: string }> = [];

let capturesRows: unknown[] = [];
let statTilesRow: unknown[] = [];
let channelsRows: unknown[] = [];

function dbExecute(query: { sql: string } | string): Promise<{ rows: unknown[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = typeof query === 'string' ? query : (query as any).sql ?? JSON.stringify(query);
  recordedQueries.push({ text });

  // The captures UNION query mentions all 4 source tables and 'UNION ALL'.
  if (text.includes('UNION ALL')) {
    return Promise.resolve({ rows: capturesRows });
  }
  // The stat-tiles aggregate query contains `drafts_pending` alias and three SELECT subqueries.
  if (text.includes('drafts_pending') && text.includes('entities_active')) {
    return Promise.resolve({ rows: statTilesRow });
  }
  // The channel-health aggregate query targets agent_runs.
  if (text.includes('FROM agent_runs')) {
    return Promise.resolve({ rows: channelsRows });
  }
  // loadDropped (entity_index aggregation) and other queries return [].
  return Promise.resolve({ rows: [] });
}

interface FakeDb {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  // drizzle's select builder is used by loadDrafts; we stub it to return [].
  select: () => FakeDb;
  from: () => FakeDb;
  where: () => FakeDb;
  orderBy: () => FakeDb;
  limit: () => Promise<unknown[]>;
  transaction: (fn: (tx: FakeDb) => Promise<unknown>) => Promise<unknown>;
}

const fakeDb: FakeDb = {
  execute: dbExecute as FakeDb['execute'],
  select: () => fakeDb,
  from: () => fakeDb,
  where: () => fakeDb,
  orderBy: () => fakeDb,
  limit: () => Promise.resolve([]),
  transaction: async (fn) => fn(fakeDb),
};

vi.mock('../src/db.js', () => ({
  getDb: async () => fakeDb,
  __setDbForTest: () => {},
}));

// Notion is not used by the new sections — but loadBrief / loadPriorities
// still call getNotion(). Stub it to avoid network calls.
vi.mock('../src/notion.js', () => ({
  getNotion: () => ({
    pages: { retrieve: async () => ({ properties: {} }) },
    databases: { query: async () => ({ results: [] }) },
  }),
}));

beforeEach(() => {
  recordedQueries.length = 0;
  capturesRows = [];
  statTilesRow = [];
  channelsRows = [];
  // Clear NOTION_*_ID env vars so loadBrief/loadPriorities short-circuit
  // to null/[] without hitting the stub.
  delete process.env.NOTION_TODAY_PAGE_ID;
  delete process.env.NOTION_COMMAND_CENTER_DB_ID;
});

// --- Contract shape tests --------------------------------------------------

describe('today response schema', () => {
  it('accepts an empty Phase-3 payload (brief=null, meetings=[])', () => {
    const empty = {
      brief: null,
      priorities: [],
      drafts: [],
      dropped: [],
      meetings: [],
    };
    expect(() => TodayResponseSchema.parse(empty)).not.toThrow();
  });

  it('accepts a realistic populated payload', () => {
    const populated = {
      brief: { body: 'Go ship Phase 3.', generated_at: '2026-04-23T08:00:00Z' },
      priorities: [
        {
          id: 'n-1',
          title: 'Ship dashboard',
          bolag: 'tale-forge',
          entity_id: null,
          entity_name: null,
        },
      ],
      drafts: [
        {
          id: 'i-1',
          entity: 'Damien',
          preview: 'Re: funding',
          from: 'damien@example.com',
          subject: 'Re: funding',
          received_at: '2026-04-23T07:30:00Z',
        },
      ],
      dropped: [
        {
          id: 'e-1',
          entity_id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
          entity: 'Christina',
          age_days: 8.2,
          bolag: 'tale-forge',
        },
      ],
      meetings: [],
    };
    expect(() => TodayResponseSchema.parse(populated)).not.toThrow();
  });

  it('rejects an unknown bolag', () => {
    const bad = {
      brief: null,
      priorities: [
        {
          id: 'n-1',
          title: 'x',
          bolag: 'unknown-co',
          entity_id: null,
          entity_name: null,
        },
      ],
      drafts: [],
      dropped: [],
      meetings: [],
    };
    expect(() => TodayResponseSchema.parse(bad)).toThrow();
  });

  // Phase 11 Plan 11-04: today response gains additive captures_today (UNION
  // across email_drafts + event_log + mention_events + inbox_index +
  // telegram_inbox_queue), stat_tiles (4 ints), and channels strips.
  it('TodayResponseSchema accepts old-shape payload without captures_today/stat_tiles/channels (backwards-compat)', () => {
    const oldShape = {
      brief: null,
      priorities: [],
      drafts: [],
      dropped: [],
      meetings: [],
    };
    const parsed = TodayResponseSchema.parse(oldShape);
    // .default([]) ensures these are present even when the wire-payload omits them.
    expect(parsed.captures_today).toEqual([]);
    expect(parsed.channels).toEqual([]);
    expect(parsed.stat_tiles).toBeUndefined();
  });

  it('TodayResponseSchema accepts new-shape payload with all three additive sections', () => {
    const newShape = {
      brief: null,
      priorities: [],
      drafts: [],
      dropped: [],
      meetings: [],
      captures_today: [
        {
          source: 'email',
          id: 'e-1',
          title: 'Re: thing',
          detail: 'urgent',
          at: '2026-04-26T08:00:00Z',
        },
      ],
      stat_tiles: {
        captures_today: 1,
        drafts_pending: 0,
        entities_active: 12,
        events_upcoming: 3,
      },
      channels: [
        {
          name: 'Telegram',
          type: 'capture',
          status: 'healthy',
          last_event_at: '2026-04-26T08:00:00Z',
        },
      ],
    };
    const parsed = TodayResponseSchema.parse(newShape);
    expect(parsed.captures_today).toHaveLength(1);
    expect(parsed.stat_tiles?.entities_active).toBe(12);
    expect(parsed.channels).toHaveLength(1);
  });

  it('CaptureSourceSchema rejects deprecated capture_text/capture_voice (Wave 0 deviation: tables do not exist)', () => {
    const bad = {
      brief: null,
      priorities: [],
      drafts: [],
      dropped: [],
      meetings: [],
      captures_today: [
        {
          source: 'capture_text', // not in enum — Wave 0 schema-verified that table doesn't exist
          id: 'x',
          title: 'x',
          detail: null,
          at: '2026-04-26T08:00:00Z',
        },
      ],
    };
    expect(() => TodayResponseSchema.parse(bad)).toThrow();
  });
});

// --- Handler integration tests ---------------------------------------------

describe('today handler — Phase 11 Plan 11-04 sections', () => {
  it('Test 1: captures_today aggregates rows from the UNION query', async () => {
    capturesRows = [
      {
        source: 'email',
        id: 'd-1',
        title: 'Re: funding',
        detail: 'urgent',
        at: '2026-04-26T09:00:00.000Z',
      },
      {
        source: 'mention',
        id: 'm-1',
        title: 'telegram-voice',
        detail: 'Damien said hi',
        at: '2026-04-26T08:30:00.000Z',
      },
      {
        source: 'event',
        id: 'ev-1',
        title: 'capture.text',
        detail: 'Note from chrome',
        at: '2026-04-26T08:00:00.000Z',
      },
    ];
    statTilesRow = [
      {
        drafts_pending: '5',
        entities_active: '12',
        events_upcoming: '3',
      },
    ];
    channelsRows = [];

    const { __clearRoutesForTest } = await import('../src/router.js');
    __clearRoutesForTest();
    const { todayHandler } = await import('../src/handlers/today.js');
    const res = await todayHandler({
      method: 'GET',
      path: '/today',
      params: {},
      query: {},
      body: null,
      headers: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ReturnType<typeof TodayResponseSchema.parse>;
    expect(body.captures_today).toHaveLength(3);
    expect(body.captures_today.map((c) => c.source).sort()).toEqual(
      ['email', 'event', 'mention'].sort(),
    );
    // Verify the UNION query was actually executed
    expect(recordedQueries.some((q) => q.text.includes('UNION ALL'))).toBe(true);
  });

  it('Test 2: stat_tiles include 4 numeric counts (captures_today is computed from the captures array length)', async () => {
    capturesRows = [
      {
        source: 'email',
        id: 'd-1',
        title: 't',
        detail: null,
        at: '2026-04-26T09:00:00.000Z',
      },
      {
        source: 'mention',
        id: 'm-1',
        title: 't',
        detail: null,
        at: '2026-04-26T08:00:00.000Z',
      },
    ];
    statTilesRow = [
      {
        drafts_pending: 5,
        entities_active: 12,
        events_upcoming: 3,
      },
    ];

    const { __clearRoutesForTest } = await import('../src/router.js');
    __clearRoutesForTest();
    const { todayHandler } = await import('../src/handlers/today.js');
    const res = await todayHandler({
      method: 'GET',
      path: '/today',
      params: {},
      query: {},
      body: null,
      headers: {},
    });

    const body = JSON.parse(res.body) as ReturnType<typeof TodayResponseSchema.parse>;
    expect(body.stat_tiles).toEqual({
      captures_today: 2, // matches captures array length
      drafts_pending: 5,
      entities_active: 12,
      events_upcoming: 3,
    });
  });

  it('Test 3: channels classified from agent_runs last_finished timestamps', async () => {
    capturesRows = [];
    statTilesRow = [{ drafts_pending: 0, entities_active: 0, events_upcoming: 0 }];

    const now = Date.now();
    const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
    channelsRows = [
      // Telegram → 5 minutes ago → max_age_min=1440 → healthy
      { agent_name: 'triage', last_finished: minutesAgo(5) },
      // Gmail → 20 minutes ago → max_age_min=30 → healthy
      { agent_name: 'gmail-poller', last_finished: minutesAgo(20) },
      // Granola → 90 minutes ago → max_age_min=60 → degraded (60 < 90 < 120)
      { agent_name: 'granola-poller', last_finished: minutesAgo(90) },
      // Calendar absent → down
    ];

    const { __clearRoutesForTest } = await import('../src/router.js');
    __clearRoutesForTest();
    const { todayHandler } = await import('../src/handlers/today.js');
    const res = await todayHandler({
      method: 'GET',
      path: '/today',
      params: {},
      query: {},
      body: null,
      headers: {},
    });

    const body = JSON.parse(res.body) as ReturnType<typeof TodayResponseSchema.parse>;
    expect(body.channels.length).toBe(4);
    const map = Object.fromEntries(
      body.channels.map((c) => [c.name, c] as const),
    ) as Record<string, (typeof body.channels)[number] | undefined>;
    expect(map['Telegram']?.status).toBe('healthy');
    expect(map['Gmail']?.status).toBe('healthy');
    expect(map['Granola']?.status).toBe('degraded');
    expect(map['Calendar']?.status).toBe('down');
    expect(map['Calendar']?.last_event_at).toBeNull();
  });

  it('Test 4: empty results return safe defaults (captures_today=[], stat_tiles all 0, all channels down)', async () => {
    capturesRows = [];
    statTilesRow = []; // missing row → handler must default
    channelsRows = [];

    const { __clearRoutesForTest } = await import('../src/router.js');
    __clearRoutesForTest();
    const { todayHandler } = await import('../src/handlers/today.js');
    const res = await todayHandler({
      method: 'GET',
      path: '/today',
      params: {},
      query: {},
      body: null,
      headers: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ReturnType<typeof TodayResponseSchema.parse>;
    expect(body.captures_today).toEqual([]);
    expect(body.stat_tiles).toEqual({
      captures_today: 0,
      drafts_pending: 0,
      entities_active: 0,
      events_upcoming: 0,
    });
    // 4 expected channels — all without rows → all 'down' with last_event_at=null
    expect(body.channels.length).toBe(4);
    expect(body.channels.every((c) => c.status === 'down')).toBe(true);
    expect(body.channels.every((c) => c.last_event_at === null)).toBe(true);
  });
});
