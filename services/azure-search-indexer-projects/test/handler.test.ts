/**
 * azure-search-indexer-projects handler tests (Plan 06-03 Task 2).
 *
 * Mirror of the entities-indexer test shape — same upsert/cursor invariants
 * applied to project_index rows with source='project' and id prefix
 * 'project:<id>'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolState = {
  rows: [] as Array<{
    project_id: string;
    name: string;
    bolag: string | null;
    status: string | null;
    description: string | null;
    seed_context: string | null;
    updated_at: Date;
  }>,
  cursor: null as Date | null,
  cursorWrites: [] as Array<{ key: string; at: Date }>,
};

vi.mock('../src/common.js', () => ({
  getPool: vi.fn(async () => ({
    query: vi.fn(async (sql: string) => {
      if (/SELECT project_id/.test(sql)) return { rows: poolState.rows };
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

describe('azure-search-indexer-projects handler', () => {
  it('empty source → no upsert call', async () => {
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number }>)();
    expect(out.read).toBe(0);
    expect(upsertCalls).toHaveLength(0);
    expect(poolState.cursorWrites).toHaveLength(0);
  });

  it('happy path: 2 rows → source=project + id prefix project: + bolag in title', async () => {
    upsertResult = { succeeded: 2, failed: 0, errors: [] };
    poolState.rows = [
      {
        project_id: 'proj-tf',
        name: 'Tale Forge',
        bolag: 'Tale Forge AB',
        status: 'active',
        description: 'AI storytelling app for children, Swedish-first.',
        seed_context: 'Founded 2024.',
        updated_at: new Date('2026-04-24T10:00:00.000Z'),
      },
      {
        project_id: 'proj-skol',
        name: 'Skolpilot',
        bolag: 'Tale Forge AB',
        status: 'pilot',
        description: null,
        seed_context: 'School pilot programme; 6 schools onboarded.',
        updated_at: new Date('2026-04-24T11:30:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    const out = await (handler as unknown as () => Promise<{ read: number; upserted: number; errors: number; cursor: string | null }>)();
    expect(out.read).toBe(2);
    expect(out.upserted).toBe(2);
    const docs = upsertCalls[0]!.documents as Array<{ id: string; source: string; title: string; content_for_embedding: string }>;
    expect(docs[0]!.source).toBe('project');
    expect(docs[0]!.id).toBe('project:proj-tf');
    // title includes bolag separator
    expect(docs[0]!.title).toContain('Tale Forge');
    expect(docs[0]!.title).toContain('Tale Forge AB');
    // content_for_embedding contains the description
    expect(docs[0]!.content_for_embedding).toContain('storytelling');
    // cursor advances to last row
    expect(poolState.cursorWrites[0]!.at.toISOString()).toBe('2026-04-24T11:30:00.000Z');
    expect(poolState.cursorWrites[0]!.key).toBe('azure-indexer-projects');
  });

  it('row with missing bolag → title still safe (no leading separator)', async () => {
    upsertResult = { succeeded: 1, failed: 0, errors: [] };
    poolState.rows = [
      {
        project_id: 'proj-x',
        name: 'X',
        bolag: null,
        status: null,
        description: 'desc',
        seed_context: null,
        updated_at: new Date('2026-04-24T12:00:00.000Z'),
      },
    ];
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    const docs = upsertCalls[0]!.documents as Array<{ title: string }>;
    expect(docs[0]!.title).toBe('X');
  });

  it('tagTraceWithCaptureId called with azure-indexer-projects prefix', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as () => Promise<unknown>)();
    expect(tagSpy).toHaveBeenCalledTimes(1);
    expect(tagSpy.mock.calls[0]![0]).toMatch(/^azure-indexer-projects-/);
  });
});
