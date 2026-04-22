/**
 * Plan 02-07 Task 2 — KOS Inbox indexer branch tests.
 *
 * Verifies the new dbKind='kos_inbox' dispatch in the notion-indexer:
 *   - Status=Approved (new proposed name)  → creates Entities-DB page +
 *     flips Inbox row to Merged with MergedInto pointing at the new page
 *   - Status=Approved (existing entity by normalised name OR alias)
 *     → Pitfall 7 dedup: NO new Entities page; reuses existing entity's
 *     notion_page_id; still flips Inbox row to Merged
 *   - Status=Rejected → archives the Notion page (archived: true);
 *     writes event_log kos-inbox-rejected
 *   - Status=Pending → skipped (Kevin hasn't acted yet)
 *   - Status=Merged → no-op (already processed in a previous tick)
 *   - Idempotency: re-running the same batch finds prior event_log rows and
 *     emits zero Notion mutations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processKosInboxBatch } from '../src/upsert';
import type { DbExec } from '../src/upsert';

// --- Helpers ----------------------------------------------------------------

type QueryCall = { text: string; values?: unknown[] };

function makeFakeDb(opts: {
  /** Map of normalised name → existing entity_index row { id, notion_page_id, aliases? } */
  existing?: Record<string, { id: string; notion_page_id: string; name: string; aliases?: string[] }>;
  /** event_log rows we should treat as already-present (set of `${pageId}|${toStatus}`) */
  alreadyProcessed?: Set<string>;
} = {}): DbExec & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const existing = opts.existing ?? {};
  const alreadyProcessed = opts.alreadyProcessed ?? new Set<string>();
  const db: DbExec & { calls: QueryCall[] } = {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });

      // Dedup check: SELECT 1 FROM event_log WHERE detail->>'inbox_page_id' = $1 AND detail->>'to_status' = $2
      if (/SELECT 1[\s\S]*FROM event_log[\s\S]*inbox_page_id/i.test(text)) {
        const [pageId, toStatus] = (values ?? []) as [string, string];
        const key = `${pageId}|${toStatus}`;
        return { rowCount: alreadyProcessed.has(key) ? 1 : 0, rows: alreadyProcessed.has(key) ? [{ '?column?': 1 }] : [] };
      }
      // Existing entity lookup (by normalised name OR aliases)
      if (/SELECT id, notion_page_id, name FROM entity_index/i.test(text)) {
        const [norm] = (values ?? []) as [string];
        const hit = existing[norm];
        if (hit) {
          return { rowCount: 1, rows: [{ id: hit.id, notion_page_id: hit.notion_page_id, name: hit.name }] };
        }
        return { rowCount: 0, rows: [] };
      }
      // event_log INSERT (idempotency marker + rejection record)
      if (/INSERT INTO event_log/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return db;
}

function makeInboxRow(overrides: {
  id: string;
  status: 'Approved' | 'Rejected' | 'Pending' | 'Merged';
  proposedName: string;
  type?: 'Person' | 'Project' | 'Org' | 'Other';
  rawContext?: string;
  sourceCaptureId?: string;
  lastEditedTime?: string;
}) {
  return {
    id: overrides.id,
    last_edited_time: overrides.lastEditedTime ?? '2026-04-22T10:00:00.000Z',
    properties: {
      'Proposed Entity Name': {
        type: 'title',
        title: [{ plain_text: overrides.proposedName }],
      },
      Type: { type: 'select', select: { name: overrides.type ?? 'Person' } },
      Status: { type: 'select', select: { name: overrides.status } },
      'Raw Context': {
        type: 'rich_text',
        rich_text: [{ plain_text: overrides.rawContext ?? '' }],
      },
      'Source Capture ID': {
        type: 'rich_text',
        rich_text: [{ plain_text: overrides.sourceCaptureId ?? 'cap_xyz' }],
      },
      MergedInto: { type: 'relation', relation: [] },
      'Candidate Matches': { type: 'relation', relation: [] },
    },
  };
}

function makeNotionClient() {
  let createCounter = 0;
  const pagesCreate = vi.fn(async (input: any) => {
    createCounter += 1;
    return {
      id: 'new-entity-page-' + createCounter,
      properties: input.properties,
    };
  });
  const pagesUpdate = vi.fn(async () => ({}));
  return {
    pagesCreate,
    pagesUpdate,
    client: {
      pages: {
        create: pagesCreate,
        update: pagesUpdate,
      },
    } as any,
  };
}

const ENTITIES_DB_ID = 'entities-db-uuid';
const OWNER_ID = 'owner-1';

// --- Tests ------------------------------------------------------------------

describe('processKosInboxBatch — Plan 02-07 KOS Inbox sync', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Approved (new name) → creates Entities page AND flips Inbox row to Merged with MergedInto', async () => {
    const db = makeFakeDb();
    const { client, pagesCreate, pagesUpdate } = makeNotionClient();
    const rows = [
      makeInboxRow({
        id: 'inbox-1',
        status: 'Approved',
        proposedName: 'Damien Hateley',
        type: 'Person',
        rawContext: 'Outbehaving cofounder mentioned in voice memo',
        sourceCaptureId: 'cap_001',
      }),
    ];

    const counters = await processKosInboxBatch({
      client,
      db,
      rows,
      ownerId: OWNER_ID,
      entitiesDbId: ENTITIES_DB_ID,
    });

    expect(counters).toEqual({ approved: 1, rejected: 0, skipped: 0 });
    // Entities-DB page created with the proposed name + type + seed context
    expect(pagesCreate).toHaveBeenCalledTimes(1);
    const createArg = pagesCreate.mock.calls[0]![0];
    expect(createArg.parent).toEqual({ database_id: ENTITIES_DB_ID });
    expect(createArg.properties.Name.title[0].text.content).toBe('Damien Hateley');
    expect(createArg.properties.Type.select.name).toBe('Person');
    expect(createArg.properties.SeedContext.rich_text[0].text.content).toContain('Outbehaving');
    // Source includes 'kos-inbox' so origin is auditable
    expect(createArg.properties.Source.multi_select.map((s: { name: string }) => s.name)).toContain('kos-inbox');
    // Inbox row flipped to Merged with MergedInto pointing at the new page
    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    const updateArg = (pagesUpdate.mock.calls[0] as unknown as [any])[0];
    expect(updateArg.page_id).toBe('inbox-1');
    expect(updateArg.properties.Status.select.name).toBe('Merged');
    expect(updateArg.properties.MergedInto.relation[0].id).toBe('new-entity-page-1');
    // event_log idempotency marker written
    const transitionInserts = db.calls.filter(
      (c) =>
        /INSERT INTO event_log/i.test(c.text) &&
        Array.isArray(c.values) &&
        (c.values as unknown[]).some((v) => v === 'kos-inbox-transition'),
    );
    expect(transitionInserts.length).toBe(1);
  });

  it('Approved (existing entity by normalised name) → Pitfall 7 dedup: NO new Entities page; reuses existing notion_page_id', async () => {
    const db = makeFakeDb({
      existing: {
        'damien hateley': {
          id: 'ent-uuid-existing',
          notion_page_id: 'existing-entity-page',
          name: 'Damien Hateley',
        },
      },
    });
    const { client, pagesCreate, pagesUpdate } = makeNotionClient();
    const rows = [
      makeInboxRow({
        id: 'inbox-2',
        status: 'Approved',
        proposedName: 'damien hateley', // case-different — must still match
        type: 'Person',
      }),
    ];

    const counters = await processKosInboxBatch({
      client,
      db,
      rows,
      ownerId: OWNER_ID,
      entitiesDbId: ENTITIES_DB_ID,
    });

    expect(counters).toEqual({ approved: 1, rejected: 0, skipped: 0 });
    // No new Entities page created (Pitfall 7 dedup hit)
    expect(pagesCreate).toHaveBeenCalledTimes(0);
    // Inbox row still flipped to Merged with MergedInto = existing entity's notion_page_id
    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    const updateArg = (pagesUpdate.mock.calls[0] as unknown as [any])[0];
    expect(updateArg.properties.Status.select.name).toBe('Merged');
    expect(updateArg.properties.MergedInto.relation[0].id).toBe('existing-entity-page');
  });

  it('Rejected → archives the Notion page (archived: true) and writes kos-inbox-rejected event_log', async () => {
    const db = makeFakeDb();
    const { client, pagesCreate, pagesUpdate } = makeNotionClient();
    const rows = [
      makeInboxRow({
        id: 'inbox-3',
        status: 'Rejected',
        proposedName: 'TypoEntity',
        sourceCaptureId: 'cap_999',
      }),
    ];

    const counters = await processKosInboxBatch({
      client,
      db,
      rows,
      ownerId: OWNER_ID,
      entitiesDbId: ENTITIES_DB_ID,
    });

    expect(counters).toEqual({ approved: 0, rejected: 1, skipped: 0 });
    // No Entities page created
    expect(pagesCreate).toHaveBeenCalledTimes(0);
    // Page updated with archived: true (archive-not-delete)
    expect(pagesUpdate).toHaveBeenCalledTimes(1);
    const updateArg = (pagesUpdate.mock.calls[0] as unknown as [any])[0];
    expect(updateArg.page_id).toBe('inbox-3');
    expect(updateArg.archived).toBe(true);
    // event_log kos-inbox-rejected written
    const rejectedLogs = db.calls.filter(
      (c) =>
        /INSERT INTO event_log/i.test(c.text) &&
        Array.isArray(c.values) &&
        (c.values as unknown[]).some((v) => v === 'kos-inbox-rejected'),
    );
    expect(rejectedLogs.length).toBe(1);
  });

  it('Pending → skipped (no mutations); Merged → skipped (already processed)', async () => {
    const db = makeFakeDb();
    const { client, pagesCreate, pagesUpdate } = makeNotionClient();
    const rows = [
      makeInboxRow({ id: 'pending-1', status: 'Pending', proposedName: 'WaitingOnKevin' }),
      makeInboxRow({ id: 'merged-1', status: 'Merged', proposedName: 'AlreadyDone' }),
    ];

    const counters = await processKosInboxBatch({
      client,
      db,
      rows,
      ownerId: OWNER_ID,
      entitiesDbId: ENTITIES_DB_ID,
    });

    expect(counters).toEqual({ approved: 0, rejected: 0, skipped: 2 });
    expect(pagesCreate).toHaveBeenCalledTimes(0);
    expect(pagesUpdate).toHaveBeenCalledTimes(0);
  });

  it('mixed batch (Approved/Rejected/Pending) → 1 page create, 2 page updates, counters {1,1,1}', async () => {
    const db = makeFakeDb();
    const { client, pagesCreate, pagesUpdate } = makeNotionClient();
    const rows = [
      makeInboxRow({ id: 'a1', status: 'Approved', proposedName: 'NewPerson', type: 'Person' }),
      makeInboxRow({ id: 'r1', status: 'Rejected', proposedName: 'Garbage' }),
      makeInboxRow({ id: 'p1', status: 'Pending', proposedName: 'NotYet' }),
    ];

    const counters = await processKosInboxBatch({
      client,
      db,
      rows,
      ownerId: OWNER_ID,
      entitiesDbId: ENTITIES_DB_ID,
    });

    expect(counters).toEqual({ approved: 1, rejected: 1, skipped: 1 });
    expect(pagesCreate).toHaveBeenCalledTimes(1); // one Entities page for Approved
    expect(pagesUpdate).toHaveBeenCalledTimes(2); // Approved Merge-flip + Rejected archive
  });

  it('idempotency — re-running the same batch with event_log marker present results in zero Notion mutations', async () => {
    const alreadyProcessed = new Set<string>([
      'inbox-1|Merged',
      'inbox-3|Rejected',
    ]);
    const db = makeFakeDb({ alreadyProcessed });
    const { client, pagesCreate, pagesUpdate } = makeNotionClient();
    const rows = [
      makeInboxRow({ id: 'inbox-1', status: 'Approved', proposedName: 'Damien Hateley' }),
      makeInboxRow({ id: 'inbox-3', status: 'Rejected', proposedName: 'TypoEntity' }),
    ];

    const counters = await processKosInboxBatch({
      client,
      db,
      rows,
      ownerId: OWNER_ID,
      entitiesDbId: ENTITIES_DB_ID,
    });

    // Both rows fall through to skipped because the dedup check short-circuits
    expect(counters).toEqual({ approved: 0, rejected: 0, skipped: 2 });
    expect(pagesCreate).toHaveBeenCalledTimes(0);
    expect(pagesUpdate).toHaveBeenCalledTimes(0);
  });
});
