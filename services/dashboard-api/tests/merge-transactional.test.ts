/**
 * POST /entities/:target_id/merge - happy path + audit trail.
 * Plan 03-11 Task 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/events.js', () => ({
  publishOutput: vi.fn(async () => undefined),
  publishCapture: vi.fn(async () => undefined),
  __setEventsClientForTest: vi.fn(),
}));

vi.mock('../src/notion.js', () => ({
  getNotion: () => ({ pages: { update: vi.fn(async () => ({})) } }),
  __setNotionForTest: vi.fn(),
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
            if (mergeAuditRows.some((r) => r.merge_id === row.merge_id || r.mergeId === row.mergeId)) {
              const err = new Error('duplicate key') as Error & { code?: string };
              err.code = '23505';
              throw err;
            }
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

vi.mock('../src/handlers/notion-merge.js', () => ({
  sourceNotionPageId: vi.fn(async (id: string) => 'notion-page-' + id),
  copyRelations: vi.fn(async () => undefined),
  archiveNotionPage: vi.fn(async () => undefined),
  unarchiveNotionPage: vi.fn(async () => undefined),
}));

import { mergeExecute } from '../src/handlers/merge.js';
import * as events from '../src/events.js';

const publishOutputMock = events.publishOutput as unknown as ReturnType<typeof vi.fn>;

const VALID_ULID = '01HF8X0K6Z0A5W9V3B7C2D1E4F';
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
  publishOutputMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /entities/:id/merge - transactional', () => {
  it('writes 4 state transitions + agent_runs audit + publishOutput(entity_merge)', async () => {
    const res = await mergeExecute(
      makeCtx({ source_id: SOURCE, merge_id: VALID_ULID, diff: { role: ['A', 'B'] } }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; merge_id: string };
    expect(body.ok).toBe(true);
    expect(body.merge_id).toBe(VALID_ULID);

    expect(mergeAuditRows).toHaveLength(1);
    expect(mergeAuditRows[0]?.state).toBe('complete');
    expect(
      mergeAuditRows[0]?.notion_archived_at ?? mergeAuditRows[0]?.notionArchivedAt,
    ).toBeInstanceOf(Date);
    expect(
      mergeAuditRows[0]?.rds_updated_at ?? mergeAuditRows[0]?.rdsUpdatedAt,
    ).toBeInstanceOf(Date);
    expect(
      mergeAuditRows[0]?.completed_at ?? mergeAuditRows[0]?.completedAt,
    ).toBeInstanceOf(Date);

    expect(agentRunsRows).toHaveLength(1);
    expect(agentRunsRows[0]?.agentName ?? agentRunsRows[0]?.agent_name).toBe(
      'entity_merge_manual',
    );

    expect(publishOutputMock).toHaveBeenCalledTimes(1);
    const call = publishOutputMock.mock.calls[0] as unknown as [
      string,
      { id: string; entity_id: string },
    ];
    expect(call[0]).toBe('entity_merge');
    expect(call[1].id).toBe(VALID_ULID);
    expect(call[1].entity_id).toBe(TARGET);
  });

  it('rejects duplicate merge_id with 409 (T-3-11-01 replay mitigation)', async () => {
    await mergeExecute(makeCtx({ source_id: SOURCE, merge_id: VALID_ULID, diff: {} }));
    const res = await mergeExecute(
      makeCtx({ source_id: SOURCE, merge_id: VALID_ULID, diff: {} }),
    );
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { ok: boolean; merge_id: string };
    expect(body.ok).toBe(false);
    expect(body.merge_id).toBe(VALID_ULID);
  });

  it('returns 400 on invalid body (malformed merge_id)', async () => {
    const res = await mergeExecute(
      makeCtx({ source_id: SOURCE, merge_id: 'not-a-ulid', diff: {} }),
    );
    expect(res.statusCode).toBe(400);
  });
});
