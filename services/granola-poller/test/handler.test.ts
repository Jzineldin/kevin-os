/**
 * granola-poller handler tests (Plan 06-01 Task 1).
 *
 * Behavioural coverage:
 *   1. Skip-on-prior-ok: existing agent_runs ok row → no PutEvents.
 *   2. Happy path: 2 transcripts → 2 PutEvents + cursor advance to
 *      `max(last_edited_time) - 1 min`.
 *   3. 64KB transcript_text cap: oversized page → raw_length capped.
 *   4. tagTraceWithCaptureId is invoked once per page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (declared BEFORE handler import so vi.mock hoisting wins) ------

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({ SecretString: 'secret-token' }) })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

vi.mock('@notionhq/client', () => ({
  Client: vi.fn().mockImplementation(() => ({})),
}));

const persistState = {
  prior: false,
  cursor: new Date('2026-04-20T00:00:00.000Z'),
  cursorDbId: 'real-transkripten-db-id',
  emitted: [] as Array<{ Source: string; DetailType: string; Detail: string }>,
  advancedTo: null as Date | null,
  runs: [] as unknown[],
};

vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({
    query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
  })),
  findPriorOkRun: vi.fn(async () => persistState.prior),
  insertAgentRun: vi.fn(async () => 'run-' + Math.random().toString(36).slice(2)),
  updateAgentRun: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    persistState.runs.push(patch);
  }),
  publishTranscriptAvailable: vi.fn(async (detail: Record<string, unknown>) => {
    persistState.emitted.push({
      Source: 'kos.capture',
      DetailType: 'transcript.available',
      Detail: JSON.stringify(detail),
    });
  }),
  __resetForTests: vi.fn(),
}));

vi.mock('../src/cursor.js', () => ({
  getCursor: vi.fn(async () => ({
    dbId: persistState.cursorDbId,
    lastCursorAt: persistState.cursor,
  })),
  advanceCursor: vi.fn(async (_pool: unknown, _owner: string, newCursor: Date) => {
    persistState.advancedTo = newCursor;
  }),
}));

const notionState = {
  pages: [] as Array<{ id: string; last_edited_time: string }>,
  contents: new Map<string, { title: string; transcript_text: string; recorded_at: Date; attendees: string[]; notion_url: string; raw_length: number }>(),
};

vi.mock('../src/notion.js', () => ({
  getTranskriptenDbId: vi.fn(async () => 'real-transkripten-db-id'),
  // eslint-disable-next-line require-yield
  queryTranskriptenSince: vi.fn(async function* () {
    for (const p of notionState.pages) yield { id: p.id, last_edited_time: p.last_edited_time, raw: p };
  }),
  readPageContent: vi.fn(async (_n: unknown, pageId: string) => {
    const c = notionState.contents.get(pageId);
    if (!c) throw new Error('No content fixture for ' + pageId);
    return c;
  }),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

const tagSpy = vi.fn();
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagSpy,
}));

beforeEach(() => {
  persistState.prior = false;
  persistState.emitted = [];
  persistState.advancedTo = null;
  persistState.runs = [];
  persistState.cursor = new Date('2026-04-20T00:00:00.000Z');
  notionState.pages = [];
  notionState.contents = new Map();
  tagSpy.mockClear();
  process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
  process.env.KOS_CAPTURE_BUS_NAME = 'kos.capture';
  process.env.NOTION_TOKEN = 'test-token';
  process.env.AWS_REGION = 'eu-north-1';
});

describe('granola-poller handler', () => {
  it('skips when prior agent_runs row with status=ok exists', async () => {
    persistState.prior = true;
    notionState.pages = [{ id: 'page-1', last_edited_time: '2026-04-21T10:00:00.000Z' }];

    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<{ processed: number; skipped: number }>)({});

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(persistState.emitted).toHaveLength(0);
    expect(persistState.advancedTo).toBeNull();
  });

  it('publishes transcript.available + advances cursor by max-edited - 1min on success', async () => {
    notionState.pages = [
      { id: 'page-1', last_edited_time: '2026-04-21T10:00:00.000Z' },
      { id: 'page-2', last_edited_time: '2026-04-21T11:00:00.000Z' },
    ];
    notionState.contents.set('page-1', {
      title: 'Möte 1',
      transcript_text: 'Hej Damien...',
      recorded_at: new Date('2026-04-21T09:00:00.000Z'),
      attendees: ['Damien'],
      notion_url: 'https://notion.so/page-1',
      raw_length: 12,
    });
    notionState.contents.set('page-2', {
      title: 'Möte 2',
      transcript_text: 'Almi review...',
      recorded_at: new Date('2026-04-21T10:30:00.000Z'),
      attendees: [],
      notion_url: 'https://notion.so/page-2',
      raw_length: 14,
    });

    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<{ processed: number; advancedTo: string | null }>)({});

    expect(result.processed).toBe(2);
    expect(persistState.emitted).toHaveLength(2);

    // Both events validate against TranscriptAvailableSchema (handler does the parse).
    for (const ev of persistState.emitted) {
      expect(ev.Source).toBe('kos.capture');
      expect(ev.DetailType).toBe('transcript.available');
      const detail = JSON.parse(ev.Detail);
      expect(detail.source).toBe('granola');
      expect(detail.transcript_id).toBeDefined();
      expect(detail.notion_page_id).toBeDefined();
      expect(detail.last_edited_time).toBeDefined();
    }

    // Cursor advanced to max(11:00) - 60s = 10:59:00.
    const expected = new Date('2026-04-21T10:59:00.000Z');
    expect(persistState.advancedTo).not.toBeNull();
    expect(persistState.advancedTo!.getTime()).toBe(expected.getTime());
    expect(result.advancedTo).toBe(expected.toISOString());
  });

  it('caps oversized transcript_text via 64 KB raw_length', async () => {
    const huge = 'a'.repeat(100_000);
    notionState.pages = [{ id: 'page-big', last_edited_time: '2026-04-21T12:00:00.000Z' }];
    notionState.contents.set('page-big', {
      title: 'Big',
      // readPageContent applies the truncation; we stub the post-truncation
      // shape (raw_length ≤ 64_000) to verify the handler emits the capped value.
      transcript_text: huge.slice(0, 64_000),
      recorded_at: new Date('2026-04-21T11:00:00.000Z'),
      attendees: [],
      notion_url: 'https://notion.so/page-big',
      raw_length: 64_000,
    });

    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    expect(persistState.emitted).toHaveLength(1);
    const detail = JSON.parse(persistState.emitted[0]!.Detail);
    expect(detail.raw_length).toBe(64_000);
    expect(detail.raw_length).toBeLessThanOrEqual(64_000);
  });

  it('tagTraceWithCaptureId is called with transcript_id per page', async () => {
    notionState.pages = [
      { id: 'page-A', last_edited_time: '2026-04-21T10:00:00.000Z' },
      { id: 'page-B', last_edited_time: '2026-04-21T11:00:00.000Z' },
    ];
    notionState.contents.set('page-A', {
      title: 'A',
      transcript_text: 'a',
      recorded_at: new Date(),
      attendees: [],
      notion_url: 'https://notion.so/A',
      raw_length: 1,
    });
    notionState.contents.set('page-B', {
      title: 'B',
      transcript_text: 'b',
      recorded_at: new Date(),
      attendees: [],
      notion_url: 'https://notion.so/B',
      raw_length: 1,
    });

    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    expect(tagSpy).toHaveBeenCalledWith('page-A');
    expect(tagSpy).toHaveBeenCalledWith('page-B');
  });
});
