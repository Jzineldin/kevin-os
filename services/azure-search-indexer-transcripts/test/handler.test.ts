/**
 * azure-search-indexer-transcripts handler tests (Plan 06-03 Task 2).
 *
 * Source: agent_runs WHERE agent_name='transcript-extractor' (D-09 transcript
 * subset). content_for_embedding pulls title + summary + decisions +
 * open_questions from the structured agent_runs.context JSON.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolState = {
  rows: [] as Array<{
    capture_id: string;
    owner_id: string;
    context: {
      transcript_id?: string;
      title?: string | null;
      summary?: string;
      decisions?: string[];
      open_questions?: string[];
    };
    created_at: Date;
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

describe('azure-search-indexer-transcripts handler', () => {
  it('empty source → no upsert', async () => {
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number }>)();
    expect(out.read).toBe(0);
    expect(upsertCalls).toHaveLength(0);
    expect(poolState.cursorWrites).toHaveLength(0);
  });

  it('happy path: agent_runs row with transcript_id → id prefix transcript: + summary as snippet', async () => {
    upsertResult = { succeeded: 1, failed: 0, errors: [] };
    poolState.rows = [
      {
        capture_id: 'cap-A',
        owner_id: 'owner-1',
        context: {
          transcript_id: 'tx-A',
          title: 'Almi konvertibellån diskussion',
          summary: 'Damien presenterade konvertibel-strukturen för Almi Invest. Christina ställde frågor om vesting.',
          decisions: ['Tale Forge tar emot konvertibel'],
          open_questions: ['När triggas konverteringen?'],
        },
        created_at: new Date('2026-04-24T13:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number; cursor: string | null }>)();
    expect(out.read).toBe(1);
    expect(out.upserted).toBe(1);
    const docs = upsertCalls[0]!.documents as Array<{ id: string; source: string; title: string; snippet: string; content_for_embedding: string }>;
    expect(docs[0]!.id).toBe('transcript:tx-A');
    expect(docs[0]!.source).toBe('transcript');
    expect(docs[0]!.title).toBe('Almi konvertibellån diskussion');
    // snippet is the summary (truncated to 600 chars).
    expect(docs[0]!.snippet).toContain('konvertibel');
    // content_for_embedding includes decisions + open_questions for retrieval relevance.
    expect(docs[0]!.content_for_embedding).toContain('Tale Forge tar emot konvertibel');
    expect(docs[0]!.content_for_embedding).toContain('När triggas konverteringen?');
    // cursor advances by created_at
    expect(poolState.cursorWrites[0]!.at.toISOString()).toBe('2026-04-24T13:00:00.000Z');
    expect(poolState.cursorWrites[0]!.key).toBe('azure-indexer-transcripts');
  });

  it('row with no transcript_id → falls back to capture_id for the index id', async () => {
    upsertResult = { succeeded: 1, failed: 0, errors: [] };
    poolState.rows = [
      {
        capture_id: 'cap-fallback',
        owner_id: 'owner-1',
        context: { summary: 'x' },
        created_at: new Date('2026-04-24T14:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    const docs = upsertCalls[0]!.documents as Array<{ id: string; title: string }>;
    expect(docs[0]!.id).toBe('transcript:cap-fallback');
    // title falls back to "Transcript <capture_id>" when ctx.title is missing
    expect(docs[0]!.title).toContain('Transcript');
  });

  it('summary >600 chars → snippet truncated', async () => {
    upsertResult = { succeeded: 1, failed: 0, errors: [] };
    const long = 'x'.repeat(800);
    poolState.rows = [
      {
        capture_id: 'cap-long',
        owner_id: 'owner-1',
        context: { transcript_id: 'tx-long', title: 'L', summary: long },
        created_at: new Date('2026-04-24T15:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    const docs = upsertCalls[0]!.documents as Array<{ snippet: string }>;
    expect(docs[0]!.snippet.length).toBe(600);
  });

  it('tagTraceWithCaptureId called with azure-indexer-transcripts prefix', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    expect(tagSpy).toHaveBeenCalledTimes(1);
    expect(tagSpy.mock.calls[0]![0]).toMatch(/^azure-indexer-transcripts-/);
  });
});
