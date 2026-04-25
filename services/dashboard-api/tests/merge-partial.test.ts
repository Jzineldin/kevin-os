/**
 * Merge partial-failure path (Plan 03-11 Task 1).
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

vi.mock('../src/notion.js', () => ({
  getNotion: () => ({ pages: { update: vi.fn(async () => ({})) } }),
  __setNotionForTest: vi.fn(),
}));

// archiveNotionPage throws -> the handler's step 2 fails, lastOk = 'notion_relations_copied'.
vi.mock('../src/handlers/notion-merge.js', () => ({
  sourceNotionPageId: vi.fn(async (id: string) => 'notion-page-' + id),
  copyRelations: vi.fn(async () => undefined),
  archiveNotionPage: vi.fn(async () => {
    throw new Error('notion-503-unavailable');
  }),
  unarchiveNotionPage: vi.fn(async () => undefined),
}));

import { mergeExecute } from '../src/handlers/merge.js';

const VALID_ULID = '01HF8X0K6Z0A5W9V3B7C2D1E4G';
const SOURCE = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';
const TPATH = '/entities/' + TARGET + '/merge';

function makeCtx(body: unknown) {
  return {
    method: 'POST' as const,
    path: TPATH,
    params: { id: TARGET },
    query: {},
    body: body === null ? null : JSON.stringify(body),
    headers: {},
  };
}

beforeEach(() => {
  resetFakes();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /entities/:id/merge - partial failure', () => {
  it('archive throw -> state=failed_at_notion_relations_copied + inbox_index merge_resume row', async () => {
    const res = await mergeExecute(
      makeCtx({ source_id: SOURCE, merge_id: VALID_ULID, diff: {} }),
    );

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      merge_id: string;
      resumable?: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.resumable).toBe(true);

    expect(mergeAuditRows).toHaveLength(1);
    expect(mergeAuditRows[0]?.state).toBe('failed_at_notion_relations_copied');
    const errMsg = String(
      mergeAuditRows[0]?.error_message ?? mergeAuditRows[0]?.errorMessage ?? '',
    );
    expect(errMsg).toMatch(/notion-503/);

    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]?.kind).toBe('merge_resume');
    expect(inboxRows[0]?.merge_id ?? inboxRows[0]?.mergeId).toBe(VALID_ULID);
    expect(String(inboxRows[0]?.title)).toMatch(/Resume merge/);

    expect(agentRunsRows).toHaveLength(0);
  });
});
