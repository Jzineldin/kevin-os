/**
 * Plan 02-08 Task 1 — bulk-import-kontakter handler tests.
 *
 * Verifies the one-shot Lambda's contract:
 *   - Reads every row from Kevin's Kontakter Notion DB (paginated)
 *   - For each row: dedup against (a) KOS Inbox by normalised name and
 *     (b) entity_index by normalised name → only create if BOTH miss
 *   - Returns counters: {total, created, skippedInboxDup, skippedEntityDup}
 *   - dryRun=true short-circuits createInboxRow but still returns counters
 *     showing what WOULD have been created
 *   - Field-shape drift (missing Role, missing Org) does not throw — handler
 *     still creates the Inbox row with partial seed context (T-02-BULK-04)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// _shared mocks must be registered BEFORE the handler import (vi.mock hoisted).
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

import { runImport, type RunImportDeps } from '../src/handler.js';

type QueryCall = { text: string; values?: unknown[] };

function makePool(opts: {
  /** normalised names that DO exist in entity_index */
  existingEntityNames?: Set<string>;
} = {}) {
  const calls: QueryCall[] = [];
  const existing = opts.existingEntityNames ?? new Set<string>();
  const pool = {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      // entity_index dedup query: SELECT 1 ... WHERE LOWER(name) = $1 OR ...
      if (/SELECT 1 FROM entity_index/i.test(text)) {
        const norm = (values?.[0] as string) ?? '';
        return existing.has(norm)
          ? { rowCount: 1, rows: [{ '?column?': 1 }] }
          : { rowCount: 0, rows: [] };
      }
      // event_log INSERT (summary row) — no-op
      if (/INSERT INTO event_log/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return pool;
}

function makeKontakterRow(id: string, name: string, opts: {
  org?: string | null;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
} = {}) {
  return {
    id,
    last_edited_time: '2026-04-22T10:00:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: name }] },
      Org: opts.org === undefined
        ? { type: 'rich_text', rich_text: [{ plain_text: 'Tale Forge' }] }
        : opts.org === null
        ? { type: 'rich_text', rich_text: [] }
        : { type: 'rich_text', rich_text: [{ plain_text: opts.org }] },
      Role: opts.role === undefined
        ? { type: 'rich_text', rich_text: [{ plain_text: 'CEO' }] }
        : opts.role === null
        ? { type: 'rich_text', rich_text: [] }
        : { type: 'rich_text', rich_text: [{ plain_text: opts.role }] },
      Email: opts.email === undefined
        ? { type: 'email', email: 'test@example.com' }
        : opts.email === null
        ? { type: 'email', email: null }
        : { type: 'email', email: opts.email },
      Phone: opts.phone === undefined
        ? { type: 'phone_number', phone_number: '+46701234567' }
        : opts.phone === null
        ? { type: 'phone_number', phone_number: null }
        : { type: 'phone_number', phone_number: opts.phone },
    },
  };
}

function makeNotion(opts: {
  searchResults?: Array<{ id: string; object: 'database'; title: Array<{ plain_text: string }> }>;
  rows?: any[];
  /** map of existing-in-inbox normalised proposed name → page id (Pending) */
  inboxPending?: Record<string, string>;
}) {
  const search = vi.fn(async () => ({
    results: opts.searchResults ?? [
      { id: 'kontakter-db-uuid', object: 'database', title: [{ plain_text: 'Kontakter' }] },
    ],
  }));
  const databasesQuery = vi.fn(async ({ database_id }: any) => {
    if (database_id === 'kontakter-db-uuid') {
      return { results: opts.rows ?? [], has_more: false, next_cursor: null };
    }
    // KOS Inbox query (dedup dual-read)
    const inboxPending = opts.inboxPending ?? {};
    const matches = Object.entries(inboxPending).map(([norm, id]) => ({
      id,
      properties: {
        'Proposed Entity Name': { title: [{ plain_text: norm }] },
        Status: { select: { name: 'Pending' } },
      },
    }));
    return { results: matches, has_more: false, next_cursor: null };
  });
  const pagesCreate = vi.fn(async (input: any) => ({
    id: 'inbox-page-' + Math.random().toString(36).slice(2, 8),
    properties: input.properties,
  }));
  return {
    search,
    databasesQuery,
    pagesCreate,
    client: {
      search,
      databases: { query: databasesQuery },
      pages: { create: pagesCreate },
    } as any,
  };
}

const KOS_INBOX_ID = 'kos-inbox-db-uuid';

describe('bulk-import-kontakter handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NOTION_TOKEN = 'test-token';
    process.env.NOTION_KOS_INBOX_DB_ID = KOS_INBOX_ID;
  });

  it('imports every Kontakter row → creates one KOS Inbox Pending row per novel contact', async () => {
    const rows = [
      makeKontakterRow('k1', 'Damien Hateley'),
      makeKontakterRow('k2', 'Christina Loh'),
      makeKontakterRow('k3', 'Marcus Magnusson', { role: null }), // missing role
      makeKontakterRow('k4', 'Emma Burman', { org: null }), // missing org
      makeKontakterRow('k5', 'Sophia Nabil'),
    ];
    const notion = makeNotion({ rows });
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
    };
    const res = await runImport({ dryRun: false }, deps);

    expect(res).toEqual({
      total: 5,
      created: 5,
      skippedInboxDup: 0,
      skippedEntityDup: 0,
      errors: 0,
    });
    expect(notion.pagesCreate).toHaveBeenCalledTimes(5);
    // Each created row uses bulk-kontakter-{date} as source_capture_id
    for (const call of notion.pagesCreate.mock.calls) {
      const captureId = (call[0] as any).properties['Source Capture ID']
        .rich_text[0].text.content;
      expect(captureId).toMatch(/^bulk-kontakter-\d{8}$/);
      // Type=Person on every row
      expect((call[0] as any).properties.Type.select.name).toBe('Person');
    }
  });

  it('dedups: skips rows already present in KOS Inbox by normalised name', async () => {
    const rows = [
      makeKontakterRow('k1', 'Damien Hateley'),
      makeKontakterRow('k2', 'Christina Loh'),
    ];
    // 'damien hateley' already has a Pending Inbox row → should be skipped
    const notion = makeNotion({
      rows,
      inboxPending: { 'damien hateley': 'inbox-existing' },
    });
    const pool = makePool();
    const res = await runImport({ dryRun: false }, {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
    });

    expect(res).toEqual({
      total: 2,
      created: 1,
      skippedInboxDup: 1,
      skippedEntityDup: 0,
      errors: 0,
    });
    // Only Christina Loh creates an Inbox row
    expect(notion.pagesCreate).toHaveBeenCalledTimes(1);
    const created = (notion.pagesCreate.mock.calls[0]![0] as any).properties[
      'Proposed Entity Name'
    ].title[0].text.content;
    expect(created).toBe('Christina Loh');
  });

  it('dedups: skips rows already present in entity_index by normalised name', async () => {
    const rows = [
      makeKontakterRow('k1', 'Damien Hateley'),
      makeKontakterRow('k2', 'Christina Loh'),
    ];
    const notion = makeNotion({ rows });
    // 'christina loh' already in entity_index → skip
    const pool = makePool({
      existingEntityNames: new Set(['christina loh']),
    });
    const res = await runImport({ dryRun: false }, {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
    });

    expect(res).toEqual({
      total: 2,
      created: 1,
      skippedInboxDup: 0,
      skippedEntityDup: 1,
      errors: 0,
    });
    expect(notion.pagesCreate).toHaveBeenCalledTimes(1);
  });

  it('dryRun=true → 0 createInboxRow calls; counters still show what WOULD have been created', async () => {
    const rows = [
      makeKontakterRow('k1', 'Damien Hateley'),
      makeKontakterRow('k2', 'Christina Loh'),
      makeKontakterRow('k3', 'Marcus Magnusson'),
    ];
    const notion = makeNotion({ rows });
    const pool = makePool();
    const res = await runImport({ dryRun: true }, {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
    });

    expect(res).toEqual({
      total: 3,
      created: 3, // counters report what WOULD be created
      skippedInboxDup: 0,
      skippedEntityDup: 0,
      errors: 0,
    });
    expect(notion.pagesCreate).toHaveBeenCalledTimes(0);
  });

  it('flexible field mapping: rows with missing Role / Org / Email still produce Inbox rows', async () => {
    const rows = [
      makeKontakterRow('k1', 'Partial Person', {
        org: null,
        role: null,
        email: null,
        phone: null,
      }),
    ];
    const notion = makeNotion({ rows });
    const pool = makePool();
    const res = await runImport({ dryRun: false }, {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
    });

    expect(res.created).toBe(1);
    const ctx = (notion.pagesCreate.mock.calls[0]![0] as any).properties[
      'Raw Context'
    ].rich_text[0].text.content;
    // Missing fields fall back to placeholders, NOT empty / undefined
    expect(ctx).toContain('unknown role');
    expect(ctx).toContain('unknown org');
    expect(ctx).toContain('n/a');
  });

  it('honours injected kontakter DB ID (no notion.search call when KONTAKTER_DB_ID env is set)', async () => {
    const rows = [makeKontakterRow('k1', 'Direct Test')];
    const notion = makeNotion({ rows });
    const pool = makePool();
    const res = await runImport(
      { dryRun: false },
      {
        notion: notion.client,
        pool,
        kosInboxId: KOS_INBOX_ID,
        kontakterDbId: 'kontakter-db-uuid', // bypass discovery
      },
    );

    expect(res.total).toBe(1);
    expect(notion.search).not.toHaveBeenCalled();
  });

  it('limit option caps the number of rows processed', async () => {
    const rows = [
      makeKontakterRow('k1', 'Person 1'),
      makeKontakterRow('k2', 'Person 2'),
      makeKontakterRow('k3', 'Person 3'),
      makeKontakterRow('k4', 'Person 4'),
    ];
    const notion = makeNotion({ rows });
    const pool = makePool();
    const res = await runImport(
      { dryRun: false, limit: 2 },
      { notion: notion.client, pool, kosInboxId: KOS_INBOX_ID },
    );

    expect(res.total).toBe(2);
    expect(res.created).toBe(2);
    expect(notion.pagesCreate).toHaveBeenCalledTimes(2);
  });
});
