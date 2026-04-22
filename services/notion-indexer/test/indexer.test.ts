/**
 * Unit tests for notion-indexer — all 5 tests run with mocked Notion + pg.
 *
 * Covers:
 *  1. 2-minute overlap when querying Notion
 *  2. Skip upsert when stored last_edited_time >= incoming
 *  3. handleArchivedOrMissing (object_not_found) logs event_log only
 *  4. Status='Archived' flows through normal upsert
 *  5. Cursor does not advance mid-pagination error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runIndexer, type IndexerEvent } from '../src/handler';
import { upsertEntity, handleArchivedOrMissing, type DbExec } from '../src/upsert';

// --- Fake DB ---------------------------------------------------------------

type QueryCall = { text: string; values?: unknown[] };
function makeFakeDb(opts: {
  cursorRow?: { last_cursor_at: string } | null;
  existingEditedTime?: string | null;
  insertResult?: { inserted: boolean };
  failOn?: RegExp; // if query text matches, throw
} = {}): DbExec & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db: DbExec & { calls: QueryCall[] } = {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (opts.failOn && opts.failOn.test(text)) throw new Error('simulated DB failure');
      if (/SELECT last_cursor_at FROM notion_indexer_cursor/i.test(text)) {
        return { rowCount: opts.cursorRow ? 1 : 0, rows: opts.cursorRow ? [opts.cursorRow] : [] };
      }
      if (/SELECT notion_last_edited_time FROM entity_index/i.test(text)) {
        return opts.existingEditedTime
          ? { rowCount: 1, rows: [{ notion_last_edited_time: opts.existingEditedTime }] }
          : { rowCount: 0, rows: [] };
      }
      if (/SELECT notion_last_edited_time FROM project_index/i.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO entity_index/i.test(text)) {
        return {
          rowCount: 1,
          rows: [{ inserted: opts.insertResult?.inserted ?? true }],
        };
      }
      if (/INSERT INTO project_index/i.test(text)) {
        return { rowCount: 1, rows: [{ inserted: true }] };
      }
      if (/INSERT INTO event_log/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO notion_indexer_cursor/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE notion_indexer_cursor/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return db;
}

function makePage(overrides: Partial<any> = {}): any {
  return {
    id: overrides.id ?? 'page-1',
    last_edited_time: overrides.last_edited_time ?? '2026-04-22T10:00:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Damien' }] },
      Aliases: { type: 'rich_text', rich_text: [{ plain_text: '' }] },
      Type: { type: 'select', select: { name: 'Person' } },
      Org: { type: 'rich_text', rich_text: [] },
      Role: { type: 'rich_text', rich_text: [] },
      Relationship: { type: 'select', select: null },
      Status: { type: 'select', select: overrides.statusName ? { name: overrides.statusName } : null },
      LinkedProjects: { type: 'relation', relation: [] },
      SeedContext: { type: 'rich_text', rich_text: [] },
      LastTouch: { type: 'date', date: null },
      ManualNotes: { type: 'rich_text', rich_text: [] },
      Confidence: { type: 'number', number: null },
      Source: { type: 'multi_select', multi_select: [] },
    },
    ...overrides,
  };
}

function makeNotion(queryImpl: Function) {
  return {
    databases: { query: queryImpl },
    pages: { retrieve: vi.fn() },
    blocks: { children: { list: vi.fn(async () => ({ results: [] })) } },
  };
}

const EV: IndexerEvent = { dbId: 'db-uuid-1', dbKind: 'entities' };

// --- Tests ------------------------------------------------------------------

describe('notion-indexer handler', () => {
  beforeEach(() => {
    process.env.CAPTURE_BUS_NAME = 'kos.capture';
  });

  it('applies 2-min overlap when querying Notion (after = cursor - 120000 ms)', async () => {
    const cursorISO = '2026-04-22T10:00:00.000Z';
    const expectedAfter = new Date(new Date(cursorISO).getTime() - 2 * 60 * 1000).toISOString();
    const db = makeFakeDb({ cursorRow: { last_cursor_at: cursorISO } });
    const queryMock = vi.fn(async () => ({ results: [], next_cursor: null }));
    const notion = makeNotion(queryMock);

    await runIndexer(EV, { notion: notion as any, db, putEvents: async () => {} });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const firstCall = (queryMock.mock.calls as unknown as any[][])[0];
    if (!firstCall) throw new Error('expected at least one query call');
    const call = firstCall[0];
    expect(call.filter.last_edited_time.after).toBe(expectedAfter);
    expect(call.page_size).toBe(100);
  });

  it('skips upsert when stored last_edited_time >= incoming', async () => {
    const db = makeFakeDb({
      cursorRow: { last_cursor_at: '2026-04-22T00:00:00.000Z' },
      existingEditedTime: '2026-04-22T10:00:00.000Z', // same as incoming → skip
    });
    // Direct unit test on upsertEntity — bypasses handler pagination.
    const page = makePage({ last_edited_time: '2026-04-22T10:00:00.000Z' });
    const result = await upsertEntity(db, page);
    expect(result.action).toBe('skipped');
    // Must not have issued the INSERT.
    const inserts = db.calls.filter((c) => /INSERT INTO entity_index/i.test(c.text));
    expect(inserts.length).toBe(0);
  });

  it("handleArchivedOrMissing logs event_log on object_not_found and does NOT mutate the row", async () => {
    const db = makeFakeDb();
    const err = Object.assign(new Error('missing'), { code: 'object_not_found' });
    const result = await handleArchivedOrMissing(db, 'ghost-page-id', 'entities', err);
    expect(result.action).toBe('hard-delete-logged');
    const logInserts = db.calls.filter((c) => /INSERT INTO event_log/i.test(c.text));
    expect(logInserts.length).toBe(1);
    expect(logInserts[0]!.values).toContain('ghost-page-id');
    // Crucially: no UPDATE/DELETE on entity_index.
    const mutations = db.calls.filter(
      (c) => /UPDATE entity_index|DELETE FROM entity_index/i.test(c.text),
    );
    expect(mutations.length).toBe(0);
  });

  it("Status='Archived' flows through normal upsert (row inserted/updated, not treated as delete)", async () => {
    const db = makeFakeDb({ insertResult: { inserted: false } }); // simulate update
    const archivedPage = makePage({
      id: 'archived-page',
      last_edited_time: '2026-04-22T11:00:00.000Z',
      statusName: 'Archived',
    });
    const result = await upsertEntity(db, archivedPage);
    expect(result.action).toBe('updated');
    const inserts = db.calls.filter((c) => /INSERT INTO entity_index/i.test(c.text));
    expect(inserts.length).toBe(1);
    // Values include status='Archived' at position 8 (0-indexed 7) per handler SQL.
    expect(inserts[0]!.values).toContain('Archived');
  });

  it('cursor does NOT advance when mid-pagination error is thrown; last_error is populated', async () => {
    const cursorISO = '2026-04-22T09:00:00.000Z';
    const db = makeFakeDb({ cursorRow: { last_cursor_at: cursorISO } });
    let callCount = 0;
    const queryMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          results: [makePage({ id: 'p1', last_edited_time: '2026-04-22T09:30:00.000Z' })],
          next_cursor: 'next-page-token',
        };
      }
      throw new Error('network boom');
    });
    const notion = makeNotion(queryMock);

    await expect(
      runIndexer(EV, { notion: notion as any, db, putEvents: async () => {} }),
    ).rejects.toThrow('network boom');

    // No INSERT INTO notion_indexer_cursor on failure.
    const advances = db.calls.filter((c) => /INSERT INTO notion_indexer_cursor/i.test(c.text));
    expect(advances.length).toBe(0);
    // UPDATE ... SET last_error = $1 must have been issued.
    const errUpdates = db.calls.filter((c) =>
      /UPDATE notion_indexer_cursor[\s\S]*last_error/i.test(c.text),
    );
    expect(errUpdates.length).toBe(1);
  });
});
