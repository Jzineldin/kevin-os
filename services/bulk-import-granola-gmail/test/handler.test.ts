/**
 * Plan 02-09 Task 1 — bulk-import-granola-gmail handler tests.
 *
 * Verifies the runImport pure-function core:
 *   - Reads Granola (Transkripten) bodies + Gmail From-headers
 *   - Cross-source dedup: same name in both legs → 1 createInboxRow with provenance='both'
 *   - Inbox dedup (Pending) skips already-imported names
 *   - entity_index dedup (LOWER(name) match) skips already-promoted entities
 *   - Re-run idempotency: second invocation with all names in Inbox → 0 creates
 *   - Graceful partial: missing Gmail (gmail=null) → granolaSkipped=false, gmailSkipped=true,
 *     handler still returns counters
 *   - Source provenance: each rawContext begins with `[source=…]`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const KOS_INBOX_ID = 'kos-inbox-db-uuid';

function makePool(opts: { existingEntityNames?: Set<string> } = {}) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const existing = opts.existingEntityNames ?? new Set<string>();
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (/SELECT 1 FROM entity_index/i.test(text)) {
        const norm = (values?.[0] as string) ?? '';
        return existing.has(norm)
          ? { rowCount: 1, rows: [{ '?column?': 1 }] }
          : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO event_log/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function makeNotion(opts: {
  inboxPending?: Record<string, string>;
}) {
  // Notion search not relied on — caller passes transkriptenDbId directly.
  const search = vi.fn(async () => ({
    results: [
      { id: 'transkripten-db-uuid', object: 'database', title: [{ plain_text: 'Transkripten' }] },
    ],
  }));
  const databasesQuery = vi.fn(async ({ database_id }: any) => {
    // KOS Inbox dual-read query path
    if (database_id === KOS_INBOX_ID) {
      const inboxPending = opts.inboxPending ?? {};
      const matches = Object.entries(inboxPending).map(([norm, id]) => ({
        id,
        properties: {
          'Proposed Entity Name': { title: [{ plain_text: norm }] },
          Status: { select: { name: 'Pending' } },
        },
      }));
      return { results: matches, has_more: false, next_cursor: null };
    }
    return { results: [], has_more: false, next_cursor: null };
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

async function* asGenerator<T>(arr: T[]): AsyncGenerator<T> {
  for (const x of arr) yield x;
}

describe('bulk-import-granola-gmail runImport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NOTION_TOKEN = 'test-token';
    process.env.NOTION_KOS_INBOX_DB_ID = KOS_INBOX_ID;
  });

  it('cross-source dedup: 2 transcripts (Christina, Henrik) + 2 Gmail (Jezper, Henrik) → 3 unique candidates, 3 creates, 1 cross-dup', async () => {
    const transcripts = [
      {
        id: 'tr1',
        title: 'Möte med Almi',
        bodyText:
          'Sedan pratade vi med Christina Jönsson om finansieringen och hon var positiv. Också Kevin nämnde Tale Forge.',
      },
      {
        id: 'tr2',
        title: 'Investerarmöte',
        bodyText: 'Henrik Norén deltog och lyssnade på pitchen.',
      },
    ];
    const gmailMsgs = [
      {
        from: '"Jezper Andersson" <jezper@example.com>',
        snippet: 'Tjena Kevin',
        messageId: 'g1',
      },
      {
        from: '"Henrik Norén" <henrik@example.com>',
        snippet: 'Following up on the deal',
        messageId: 'g2',
      },
    ];
    const notion = makeNotion({});
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: {} as any,
      readTranskriptenFn: () => asGenerator(transcripts),
      readGmailFn: () => asGenerator(gmailMsgs),
    };

    const res = await runImport({ dryRun: false }, deps);

    expect(res.totalGranola).toBe(2);
    expect(res.totalGmail).toBe(2);
    expect(res.candidatesUnique).toBe(3); // Christina, Henrik, Jezper
    expect(res.created).toBe(3);
    expect(res.skippedDup).toBe(0);
    expect(res.errors).toBe(0);
    expect(notion.pagesCreate).toHaveBeenCalledTimes(3);

    // Verify provenance prefixes on each created row
    const ctxs = notion.pagesCreate.mock.calls.map(
      (call: any[]) =>
        (call[0] as any).properties['Raw Context'].rich_text[0].text.content,
    );
    for (const ctx of ctxs) {
      expect(ctx).toMatch(/^\[source=(granola|gmail|both)\]/);
    }
    // At least one row should be `both` (Henrik appears in both sources)
    expect(ctxs.some((ctx: string) => ctx.startsWith('[source=both]'))).toBe(true);

    // Each created row uses bulk-ent06-{date} as source_capture_id
    for (const call of notion.pagesCreate.mock.calls) {
      const captureId = (call[0] as any).properties['Source Capture ID']
        .rich_text[0].text.content;
      expect(captureId).toMatch(/^bulk-ent06-\d{8}$/);
      expect((call[0] as any).properties.Type.select.name).toBe('Person');
    }
  });

  it('Inbox dedup: existing Pending row for Christina → that row skipped, others created', async () => {
    const transcripts = [
      {
        id: 'tr1',
        title: 't',
        bodyText: 'Christina Jönsson kom på mötet idag och sen Henrik Norén.',
      },
    ];
    const notion = makeNotion({
      inboxPending: { 'christina jönsson': 'inbox-existing-1' },
    });
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: null,
      readTranskriptenFn: () => asGenerator(transcripts),
    };
    const res = await runImport({ dryRun: false }, deps);

    expect(res.candidatesUnique).toBe(2);
    expect(res.skippedInboxDup).toBe(1);
    expect(res.created).toBe(1);
    expect(notion.pagesCreate).toHaveBeenCalledTimes(1);
    const created = (notion.pagesCreate.mock.calls[0]![0] as any).properties[
      'Proposed Entity Name'
    ].title[0].text.content;
    expect(created).toBe('Henrik Norén');
  });

  it('entity_index dedup: existing entity → skip', async () => {
    const transcripts = [
      {
        id: 'tr1',
        title: 't',
        bodyText: 'Christina Jönsson och Henrik Norén var där.',
      },
    ];
    const notion = makeNotion({});
    // entity_index dedup uses normaliseName() which strips diacritics, so
    // "christina jönsson" → "christina jonsson" in the lookup key.
    const pool = makePool({ existingEntityNames: new Set(['christina jonsson']) });
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: null,
      readTranskriptenFn: () => asGenerator(transcripts),
    };
    const res = await runImport({ dryRun: false }, deps);

    expect(res.skippedEntityDup).toBe(1);
    expect(res.created).toBe(1);
    expect(notion.pagesCreate).toHaveBeenCalledTimes(1);
  });

  it('re-run idempotency: every candidate already in Inbox → 0 creates', async () => {
    const transcripts = [
      {
        id: 'tr1',
        title: 't',
        bodyText: 'Christina Jönsson och Henrik Norén deltog.',
      },
    ];
    const notion = makeNotion({
      inboxPending: {
        'christina jönsson': 'inbox-1',
        'henrik norén': 'inbox-2',
      },
    });
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: null,
      readTranskriptenFn: () => asGenerator(transcripts),
    };
    const res = await runImport({ dryRun: false }, deps);

    expect(res.created).toBe(0);
    expect(res.skippedInboxDup).toBe(2);
    expect(notion.pagesCreate).toHaveBeenCalledTimes(0);
  });

  it('graceful partial: gmail=null + Granola working → granolaSkipped=false, gmailSkipped=true, still creates from Granola', async () => {
    const transcripts = [
      { id: 'tr1', title: 't', bodyText: 'Henrik Norén var med på callet.' },
    ];
    const notion = makeNotion({});
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: null,
      readTranskriptenFn: () => asGenerator(transcripts),
    };
    const res = await runImport({ dryRun: false }, deps);

    expect(res.granolaSkipped).toBe(false);
    expect(res.gmailSkipped).toBe(true);
    expect(res.created).toBe(1);
    expect(res.totalGmail).toBe(0);
  });

  it('dryRun=true → 0 createInboxRow calls but counters report what WOULD be created', async () => {
    const transcripts = [
      {
        id: 'tr1',
        title: 't',
        bodyText: 'Henrik Norén kom på mötet och Christina Jönsson också.',
      },
    ];
    const notion = makeNotion({});
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: null,
      readTranskriptenFn: () => asGenerator(transcripts),
    };
    const res = await runImport({ dryRun: true }, deps);

    expect(res.created).toBe(2);
    expect(notion.pagesCreate).toHaveBeenCalledTimes(0);
  });

  it('sources=granola only → Gmail leg not invoked, gmailSkipped=true', async () => {
    const transcripts = [
      { id: 'tr1', title: 't', bodyText: 'Henrik Norén deltog.' },
    ];
    const gmailFn = vi.fn(() => asGenerator([] as any[]));
    const notion = makeNotion({});
    const pool = makePool();
    const deps: RunImportDeps = {
      notion: notion.client,
      pool,
      kosInboxId: KOS_INBOX_ID,
      transkriptenDbId: 'transkripten-db-uuid',
      gmail: {} as any,
      readTranskriptenFn: () => asGenerator(transcripts),
      readGmailFn: gmailFn,
    };
    const res = await runImport({ dryRun: false, sources: 'granola' }, deps);

    expect(res.gmailSkipped).toBe(true);
    expect(res.granolaSkipped).toBe(false);
    expect(gmailFn).not.toHaveBeenCalled();
  });
});
