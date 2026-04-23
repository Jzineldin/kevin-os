/**
 * Merge resume + cancel + revert (Plan 03-11 Task 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/events.js', () => ({
  publishOutput: vi.fn(async () => undefined),
  publishCapture: vi.fn(async () => undefined),
  __setEventsClientForTest: vi.fn(),
}));

const mergeAuditRows: Array<Record<string, unknown>> = [];
const inboxRows: Array<Record<string, unknown>> = [];
const agentRunsRows: Array<Record<string, unknown>> = [];

function resetFakes() {
  mergeAuditRows.length = 0;
  inboxRows.length = 0;
  agentRunsRows.length = 0;
}

function tableName(t: unknown): string {
  if (t && typeof t === 'object') {
    const syms = Object.getOwnPropertySymbols(t);
    for (const s of syms) {
      if (s.description === 'Name' || s.description?.includes('Name')) {
        const v = (t as unknown as Record<symbol, unknown>)[s];
        if (typeof v === 'string') return v;
      }
    }
  }
  return '';
}

function makeDb(): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  type Row = Record<string, unknown>;
  const db: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values: async (row: Row) => {
          if (name === 'entity_merge_audit') {
            mergeAuditRows.push({ ...row });
          } else if (name === 'inbox_index') {
            inboxRows.push({ ...row });
          } else if (name === 'agent_runs') {
            agentRunsRows.push({ ...row });
          }
        },
      };
    },
    update(table: unknown) {
      const name = tableName(table);
      return {
        set(patch: Row) {
          return {
            where: async () => {
              if (name === 'entity_merge_audit') {
                const target = mergeAuditRows[mergeAuditRows.length - 1];
                if (target) Object.assign(target, patch);
              }
            },
          };
        },
      };
    },
    select(_cols?: unknown) {
      return {
        from(table: unknown) {
          const name = tableName(table);
          return {
            where(_pred?: unknown) {
              return {
                limit(_n: number) {
                  if (name === 'entity_merge_audit') {
                    const last = mergeAuditRows[mergeAuditRows.length - 1];
                    return last ? [last] : [];
                  }
                  return [];
                },
              };
            },
          };
        },
      };
    },
    async transaction(fn: (tx: typeof db) => Promise<unknown>) {
      return fn(db);
    },
  };
  return db;
}

vi.mock('../src/db.js', () => {
  const db = makeDb();
  return { getDb: async () => db, __setDbForTest: vi.fn() };
});

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
    and: (...parts: unknown[]) => ({ __and: parts }),
  };
});

// Mock notion-merge with inlined spies (vi.mock factories are hoisted —
// spies declared outside the factory hit a TDZ error).
vi.mock('../src/handlers/notion-merge.js', () => ({
  sourceNotionPageId: vi.fn(async (id: string) => 'notion-page-' + id),
  copyRelations: vi.fn(async () => undefined),
  archiveNotionPage: vi.fn(async () => undefined),
  unarchiveNotionPage: vi.fn(async () => undefined),
}));

vi.mock('../src/notion.js', () => ({
  getNotion: () => ({ pages: { update: vi.fn() } }),
  __setNotionForTest: vi.fn(),
}));

import { mergeResume } from '../src/handlers/merge.js';
import * as notionMerge from '../src/handlers/notion-merge.js';

const archiveSpy = notionMerge.archiveNotionPage as unknown as ReturnType<typeof vi.fn>;
const unarchiveSpy = notionMerge.unarchiveNotionPage as unknown as ReturnType<typeof vi.fn>;
const copyRelationsSpy = notionMerge.copyRelations as unknown as ReturnType<typeof vi.fn>;

const VALID_ULID = '01HF8X0K6Z0A5W9V3B7C2D1E4H';
const SOURCE = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';
const RESUME_PATH = '/entities/' + TARGET + '/merge/resume';

function seedAudit(partial: Record<string, unknown>) {
  mergeAuditRows.push({
    merge_id: VALID_ULID,
    mergeId: VALID_ULID,
    source_entity_id: SOURCE,
    sourceEntityId: SOURCE,
    target_entity_id: TARGET,
    targetEntityId: TARGET,
    state: 'failed_at_notion_archived',
    diff: {},
    created_at: new Date(),
    ...partial,
  });
}

function makeCtx(body: unknown, query: Record<string, string> = {}) {
  return {
    method: 'POST' as const,
    path: RESUME_PATH,
    params: { id: TARGET },
    query,
    body: body === null ? null : JSON.stringify(body),
    headers: {},
  };
}

beforeEach(() => {
  resetFakes();
  archiveSpy.mockClear();
  unarchiveSpy.mockClear();
  copyRelationsSpy.mockClear();
  archiveSpy.mockImplementation(async () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /entities/:id/merge/resume', () => {
  it('seeded at notion_archived -> resume runs only rds + complete', async () => {
    seedAudit({ state: 'notion_archived' });

    const res = await mergeResume(makeCtx({ merge_id: VALID_ULID }));

    expect(res.statusCode).toBe(200);
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(copyRelationsSpy).not.toHaveBeenCalled();
    expect(mergeAuditRows[0]?.state).toBe('complete');
    expect(agentRunsRows).toHaveLength(1);
  });

  it('seeded at failed_at_notion_relations_copied -> resume retries archive + rds + complete', async () => {
    seedAudit({ state: 'failed_at_notion_relations_copied' });

    const res = await mergeResume(makeCtx({ merge_id: VALID_ULID }));

    expect(res.statusCode).toBe(200);
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(copyRelationsSpy).not.toHaveBeenCalled();
    expect(mergeAuditRows[0]?.state).toBe('complete');
  });

  it('idempotent no-op when state=complete', async () => {
    seedAudit({ state: 'complete' });

    const res = await mergeResume(makeCtx({ merge_id: VALID_ULID }));
    expect(res.statusCode).toBe(200);
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(copyRelationsSpy).not.toHaveBeenCalled();
  });

  it('404 when merge_id is not found', async () => {
    const res = await mergeResume(makeCtx({ merge_id: VALID_ULID }));
    expect(res.statusCode).toBe(404);
  });

  it('cancel action -> state=cancelled, no Notion calls', async () => {
    seedAudit({ state: 'failed_at_notion_archived' });
    const res = await mergeResume(
      makeCtx({ merge_id: VALID_ULID }, { action: 'cancel' }),
    );
    expect(res.statusCode).toBe(200);
    expect(mergeAuditRows[0]?.state).toBe('cancelled');
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(unarchiveSpy).not.toHaveBeenCalled();
  });

  it('revert action -> un-archives Notion + state=reverted', async () => {
    seedAudit({ state: 'notion_archived' });
    const res = await mergeResume(
      makeCtx({ merge_id: VALID_ULID }, { action: 'revert' }),
    );
    expect(res.statusCode).toBe(200);
    expect(unarchiveSpy).toHaveBeenCalledTimes(1);
    expect(mergeAuditRows[0]?.state).toBe('reverted');
  });

  it('validates merge_id with zod (400 on malformed)', async () => {
    const res = await mergeResume(makeCtx({ merge_id: 'not-a-ulid' }));
    expect(res.statusCode).toBe(400);
  });
});
