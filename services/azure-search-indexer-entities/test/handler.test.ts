/**
 * azure-search-indexer-entities handler tests (Plan 06-03 Task 2).
 *
 * Coverage:
 *   1. Empty source → no upsert call, cursor unchanged.
 *   2. Happy path: N rows → N AzureDocuments with source='entity', id prefix
 *      'entity:<id>', content shape includes name+aliases+role+org, cursor
 *      advances to last row's updated_at.
 *   3. upsertDocuments returns failures → cursor still advances (the row was
 *      attempted; partial-failure rows surfaced via errors[]). Behaviour
 *      matches the existing handler — explicit assertion documents the
 *      retry policy boundary.
 *   4. tagTraceWithCaptureId is called once with the indexer trace tag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolState = {
  rows: [] as Array<{
    entity_id: string;
    name: string;
    aliases: string[] | null;
    type: string;
    org: string | null;
    role: string | null;
    seed_context: string | null;
    manual_notes: string | null;
    updated_at: Date;
  }>,
  cursor: null as Date | null,
  cursorWrites: [] as Array<{ key: string; at: Date }>,
};

vi.mock('../src/common.js', () => ({
  getPool: vi.fn(async () => ({
    query: vi.fn(async (sql: string) => {
      if (/FROM entity_index/.test(sql)) {
        return { rows: poolState.rows };
      }
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

describe('azure-search-indexer-entities handler', () => {
  it('empty source → no upsert call, no cursor write, returns 0/0/0', async () => {
    poolState.rows = [];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number }>)();
    expect(out).toEqual({ read: 0, upserted: 0, errors: 0, cursor: null });
    expect(upsertCalls).toHaveLength(0);
    expect(poolState.cursorWrites).toHaveLength(0);
  });

  it('happy path: 2 rows → 2 documents upserted with source=entity + id prefix entity:', async () => {
    upsertResult = { succeeded: 2, failed: 0, errors: [] };
    poolState.rows = [
      {
        entity_id: 'ent-1',
        name: 'Damien Mathiot',
        aliases: ['Damien'],
        type: 'Person',
        org: 'Outbehaving',
        role: 'CTO',
        seed_context: 'Co-founder; Tale Forge investor.',
        manual_notes: 'Met 2024-01-12.',
        updated_at: new Date('2026-04-24T10:00:00.000Z'),
      },
      {
        entity_id: 'ent-2',
        name: 'Christina Bosch',
        aliases: [],
        type: 'Person',
        org: 'Almi Invest',
        role: null,
        seed_context: 'Lead VC contact.',
        manual_notes: null,
        updated_at: new Date('2026-04-24T11:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number; cursor: string | null }>)();
    expect(out.read).toBe(2);
    expect(out.upserted).toBe(2);
    expect(out.errors).toBe(0);
    expect(upsertCalls).toHaveLength(1);
    const docs = upsertCalls[0]!.documents as Array<{ id: string; source: string; title: string; content_for_embedding: string; entity_ids: string[] }>;
    expect(docs).toHaveLength(2);
    expect(docs[0]!.source).toBe('entity');
    expect(docs[0]!.id).toBe('entity:ent-1');
    expect(docs[0]!.entity_ids).toEqual(['ent-1']);
    // content_for_embedding includes the relationship fields.
    expect(docs[0]!.content_for_embedding).toContain('Damien Mathiot');
    expect(docs[0]!.content_for_embedding).toContain('Outbehaving');
    expect(docs[0]!.content_for_embedding).toContain('CTO');
    // cursor advances to the last row's updated_at.
    expect(poolState.cursorWrites).toHaveLength(1);
    expect(poolState.cursorWrites[0]!.key).toBe('azure-indexer-entities');
    expect(poolState.cursorWrites[0]!.at.toISOString()).toBe('2026-04-24T11:00:00.000Z');
  });

  it('upsert per-doc failures → errors counter reported, cursor still advances', async () => {
    upsertResult = { succeeded: 0, failed: 1, errors: ['entity:ent-bad: index full'] };
    poolState.rows = [
      {
        entity_id: 'ent-bad',
        name: 'Bad',
        aliases: null,
        type: 'Person',
        org: null,
        role: null,
        seed_context: null,
        manual_notes: null,
        updated_at: new Date('2026-04-24T12:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number; cursor: string | null }>)();
    expect(out.read).toBe(1);
    expect(out.upserted).toBe(0);
    expect(out.errors).toBe(1);
    expect(poolState.cursorWrites).toHaveLength(1);
  });

  it('tagTraceWithCaptureId is invoked once with an azure-indexer-entities prefix', async () => {
    poolState.rows = [];
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    expect(tagSpy).toHaveBeenCalledTimes(1);
    expect(tagSpy.mock.calls[0]![0]).toMatch(/^azure-indexer-entities-/);
  });
});
