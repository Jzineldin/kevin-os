/**
 * azure-search-indexer-daily-brief handler tests (Plan 06-03 Task 2).
 *
 * Per CONTEXT D-09: this is a placeholder Lambda — the daily-brief source
 * (agent_runs WHERE agent_name IN morning-brief/day-close/weekly-review) is
 * populated by Phase 7. Wave-2 implementation must:
 *   - return zero counts when no source rows exist (degenerate case = "Phase 7
 *     not yet shipped")
 *   - upsert correctly once briefs do appear, with source='daily_brief'
 *   - prefix the index id with 'brief:'
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolState = {
  rows: [] as Array<{
    capture_id: string;
    agent_name: string;
    output_json: { brief_body?: string; date?: string; top_priorities?: string[]; slipped_items?: string[] };
    started_at: Date;
  }>,
  cursor: null as Date | null,
  cursorWrites: [] as Array<{ key: string; at: Date }>,
};

vi.mock('../src/common.js', () => ({
  getPool: vi.fn(async () => ({
    query: vi.fn(async (sql: string) => {
      if (/SELECT capture_id/.test(sql)) return { rows: poolState.rows };
      return { rows: [] };
    }),
  })),
  readCursor: vi.fn(async () => poolState.cursor),
  writeCursor: vi.fn(async (_p: unknown, key: string, at: Date) => {
    poolState.cursorWrites.push({ key, at });
  }),
}));

const upsertCalls: Array<{ documents: unknown[] }> = [];
let upsertResult = { succeeded: 0, failed: 0, errors: [] as string[] };
vi.mock('@kos/azure-search', () => ({
  upsertDocuments: vi.fn(async (b: { documents: unknown[] }) => {
    upsertCalls.push({ documents: b.documents });
    return upsertResult;
  }),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
}));
const tagSpy = vi.fn();
vi.mock('../../_shared/tracing.js', () => ({
  tagTraceWithCaptureId: tagSpy,
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
}));

beforeEach(() => {
  poolState.rows = [];
  poolState.cursor = null;
  poolState.cursorWrites = [];
  upsertCalls.length = 0;
  upsertResult = { succeeded: 0, failed: 0, errors: [] };
  tagSpy.mockClear();
});

describe('azure-search-indexer-daily-brief handler', () => {
  it('Phase 7 not yet shipped → no source rows → graceful no-op (read=0, no upsert)', async () => {
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number }>)();
    expect(out).toEqual({ read: 0, upserted: 0, errors: 0, cursor: null });
    expect(upsertCalls).toHaveLength(0);
    expect(poolState.cursorWrites).toHaveLength(0);
  });

  it('once Phase 7 lands: morning-brief row indexed with source=daily_brief + brief: prefix', async () => {
    upsertResult = { succeeded: 1, failed: 0, errors: [] };
    poolState.rows = [
      {
        capture_id: 'cap-mb-2026-04-24',
        agent_name: 'morning-brief',
        output_json: {
          date: '2026-04-24',
          brief_body: 'Top priority today: Almi term sheet response. Slipped from yesterday: Skolpilot escalation note.',
          top_priorities: ['Almi term sheet response'],
          slipped_items: ['Skolpilot escalation note'],
        },
        started_at: new Date('2026-04-24T07:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number; cursor: string | null }>)();
    expect(out.read).toBe(1);
    expect(out.upserted).toBe(1);
    const docs = upsertCalls[0]!.documents as Array<{ id: string; source: string; title: string; snippet: string; content_for_embedding: string }>;
    expect(docs[0]!.id).toBe('brief_cap-mb-2026-04-24');
    expect(docs[0]!.source).toBe('daily_brief');
    // title prefixed by agent_name + date
    expect(docs[0]!.title).toContain('morning-brief');
    expect(docs[0]!.title).toContain('2026-04-24');
    // snippet contains the brief_body
    expect(docs[0]!.snippet).toContain('Almi');
    // content_for_embedding contains priorities + slipped items for retrieval relevance.
    expect(docs[0]!.content_for_embedding).toContain('Almi term sheet response');
    expect(docs[0]!.content_for_embedding).toContain('Skolpilot escalation note');
    expect(poolState.cursorWrites[0]!.key).toBe('azure-indexer-daily-brief');
  });

  it('day-close + weekly-review agents also routed (BRIEF_AGENTS allowlist)', async () => {
    upsertResult = { succeeded: 2, failed: 0, errors: [] };
    poolState.rows = [
      {
        capture_id: 'cap-dc',
        agent_name: 'day-close',
        output_json: { brief_body: 'Day close summary.', date: '2026-04-24' },
        started_at: new Date('2026-04-24T18:00:00.000Z'),
      },
      {
        capture_id: 'cap-wr',
        agent_name: 'weekly-review',
        output_json: { brief_body: 'Weekly review.', date: '2026-04-25' },
        started_at: new Date('2026-04-25T17:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number }>)();
    expect(out.read).toBe(2);
    const docs = upsertCalls[0]!.documents as Array<{ source: string; title: string }>;
    expect(docs[0]!.source).toBe('daily_brief');
    expect(docs[0]!.title).toContain('day-close');
    expect(docs[1]!.title).toContain('weekly-review');
  });

  it('tagTraceWithCaptureId called with azure-indexer-daily-brief prefix', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    expect(tagSpy).toHaveBeenCalledTimes(1);
    expect(tagSpy.mock.calls[0]![0]).toMatch(/^azure-indexer-daily-brief-/);
  });
});
