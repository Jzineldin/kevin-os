/**
 * Phase 4 Plan 04-05 — dashboard-api Approve / Edit / Skip + /inbox-merged tests.
 *
 * 10 tests cover:
 *   1. POST /approve → email_send_authorizations row written; email.approved emitted
 *   2. POST /approve on already-approved draft → 409
 *   3. POST /approve on skipped draft → 409
 *   4. POST /edit {body, subject} → draft_body/draft_subject updated; status=edited; draft_edited SSE
 *   5. POST /skip → status=skipped; draft_skipped SSE
 *   6. invalid draft id (not UUID) → 400
 *   7. unknown draft id → 404
 *   8. /inbox-merged returns email_drafts (status in draft/edited) + dead-letter rows
 *   9. /inbox-merged returns [] when no data (degraded path)
 *  10. Edit body schema rejects subject > 300 chars or body > 10_000 chars
 *
 * The Bearer-auth check is the dashboard-api Lambda's `verifyBearer`
 * (services/dashboard-api/src/index.ts) — covered separately by the
 * router test fixture. Here we exercise the per-handler logic directly,
 * mocking the Drizzle pool + EventBridge client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditDraftBodySchema } from '../src/routes/email-drafts.js';

// Capture EventBridge calls for assertion. vi.hoisted ensures the mock
// surface is constructed BEFORE any vi.mock factory runs (vi.mock is
// hoisted to top of file, ahead of all imports + const declarations).
const { ebSendMock } = vi.hoisted(() => ({
  ebSendMock: vi.fn(async () => ({})),
}));

vi.mock('@aws-sdk/client-eventbridge', () => {
  class MockEB {
    send = ebSendMock;
  }
  class MockCmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { EventBridgeClient: MockEB, PutEventsCommand: MockCmd };
});

// db.ts is replaced by a transactional mock — db.execute() returns rows
// from a table-driven map; db.transaction() runs the inner fn with the
// same mock as `tx` so INSERT/UPDATE inside transactions are recorded.
let storedDraft: Record<string, unknown> | null = null;
const recordedQueries: Array<{ text: string; params?: unknown[] }> = [];

function dbExecute(query: { sql: string; params?: unknown[] } | string): Promise<{
  rows: unknown[];
}> {
  // Drizzle's sql template returns an object with `.queryChunks` /
  // similar internals; calling db.execute(sql`...`) will pass that
  // through. For our mock we just inspect `.sql` if available, else
  // accept the string and rely on substring match.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = typeof query === 'string' ? query : (query as any).sql ?? JSON.stringify(query);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params = typeof query === 'string' ? [] : ((query as any).params ?? []);
  recordedQueries.push({ text, params });
  if (text.includes('FROM email_drafts') && text.includes('LIMIT 1')) {
    return Promise.resolve({ rows: storedDraft ? [storedDraft] : [] });
  }
  if (text.includes('FROM email_drafts')) {
    return Promise.resolve({ rows: storedDraft ? [storedDraft] : [] });
  }
  if (text.includes('FROM agent_dead_letter')) {
    return Promise.resolve({ rows: [] });
  }
  return Promise.resolve({ rows: [] });
}

interface FakeDb {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  transaction: (fn: (tx: FakeDb) => Promise<unknown>) => Promise<unknown>;
}
const fakeDb: FakeDb = {
  execute: dbExecute as FakeDb['execute'],
  transaction: async (fn: (tx: FakeDb) => Promise<unknown>) => fn(fakeDb),
};

vi.mock('../src/db.js', () => ({
  getDb: async () => fakeDb,
  __setDbForTest: () => {},
}));

const draftIdA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const captureA = '01HK000000000000000000000A';

beforeEach(() => {
  vi.clearAllMocks();
  recordedQueries.length = 0;
  storedDraft = {
    id: draftIdA,
    owner_id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
    capture_id: captureA,
    account_id: 'kevin-taleforge',
    message_id: '<orig.123@example.com>',
    from_email: 'damien@example.com',
    to_email: ['kevin@tale-forge.app'],
    subject: 'Original',
    classification: 'urgent',
    draft_body: 'draft body',
    draft_subject: 'Re: Original',
    status: 'draft',
    received_at: '2026-04-25T10:00:00.000Z',
    triaged_at: '2026-04-25T10:00:01.000Z',
    approved_at: null,
    sent_at: null,
    sent_message_id: null,
  };
});

function makeCtx(
  method: 'GET' | 'POST',
  params: Record<string, string>,
  body: unknown = null,
) {
  return {
    method,
    path: '',
    params,
    query: {},
    body: body === null ? null : JSON.stringify(body),
    headers: {},
  };
}

describe('email-drafts route handlers (Plan 04-05)', () => {
  it('Test 1: POST /approve writes email_send_authorizations + emits email.approved', async () => {
    const { approveEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await approveEmailDraftHandler(makeCtx('POST', { id: draftIdA }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; authorization_id: string };
    expect(body.ok).toBe(true);
    expect(body.authorization_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // email_send_authorizations INSERT issued.
    expect(
      recordedQueries.some((q) => q.text.includes('INSERT INTO email_send_authorizations')),
    ).toBe(true);
    // email_drafts UPDATE → 'approved'.
    expect(
      recordedQueries.some(
        (q) => q.text.includes('email_drafts') && q.text.includes("status='approved'"),
      ),
    ).toBe(true);
    // EventBridge fired with email.approved.
    const sentCall = ebSendMock.mock.calls.find((c: unknown[]) => {
      const cmd = c[0] as { input?: { Entries?: Array<{ DetailType?: string }> } };
      return cmd.input?.Entries?.[0]?.DetailType === 'email.approved';
    });
    expect(sentCall).toBeDefined();
  });

  it('Test 2: POST /approve on already-approved draft → 409', async () => {
    storedDraft!.status = 'approved';
    const { approveEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await approveEmailDraftHandler(makeCtx('POST', { id: draftIdA }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('invalid_status');
  });

  it('Test 3: POST /approve on skipped draft → 409', async () => {
    storedDraft!.status = 'skipped';
    const { approveEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await approveEmailDraftHandler(makeCtx('POST', { id: draftIdA }));
    expect(res.statusCode).toBe(409);
  });

  it('Test 4: POST /edit updates body+subject → status=edited + draft_edited SSE', async () => {
    const { editEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await editEmailDraftHandler(
      makeCtx('POST', { id: draftIdA }, { body: 'edited body', subject: 'Re: edited' }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('edited');
    // UPDATE issued.
    expect(
      recordedQueries.some(
        (q) => q.text.includes('UPDATE email_drafts') && q.text.includes("status = 'edited'"),
      ),
    ).toBe(true);
    // No authorization row.
    expect(
      recordedQueries.some((q) => q.text.includes('INSERT INTO email_send_authorizations')),
    ).toBe(false);
    // draft_edited SSE emitted.
    const editedCall = ebSendMock.mock.calls.find((c: unknown[]) => {
      const cmd = c[0] as { input?: { Entries?: Array<{ DetailType?: string }> } };
      return cmd.input?.Entries?.[0]?.DetailType === 'draft_edited';
    });
    expect(editedCall).toBeDefined();
  });

  it('Test 5: POST /skip sets status=skipped + draft_skipped SSE', async () => {
    const { skipEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await skipEmailDraftHandler(makeCtx('POST', { id: draftIdA }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('skipped');
    expect(
      recordedQueries.some(
        (q) => q.text.includes('UPDATE email_drafts') && q.text.includes("status = 'skipped'"),
      ),
    ).toBe(true);
    const skipCall = ebSendMock.mock.calls.find((c: unknown[]) => {
      const cmd = c[0] as { input?: { Entries?: Array<{ DetailType?: string }> } };
      return cmd.input?.Entries?.[0]?.DetailType === 'draft_skipped';
    });
    expect(skipCall).toBeDefined();
  });

  it('Test 6: invalid uuid path param → 400', async () => {
    const { approveEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await approveEmailDraftHandler(makeCtx('POST', { id: 'not-a-uuid' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_id');
  });

  it('Test 7: unknown draft id (uuid valid but no row) → 404', async () => {
    storedDraft = null;
    const { approveEmailDraftHandler } = await import('../src/routes/email-drafts.js');
    const res = await approveEmailDraftHandler(makeCtx('POST', { id: draftIdA }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('Test 8: /inbox-merged returns drafts as kind=draft_reply', async () => {
    // Override fakeDb.execute for the inbox SELECTs — return one draft.
    const draftRow = {
      draft_id: draftIdA,
      capture_id: captureA,
      from_email: 'damien@example.com',
      subject: 'Original',
      draft_subject: 'Re: Original',
      draft_body: 'draft body',
      classification: 'urgent',
      status: 'draft',
      received_at: '2026-04-25T10:00:00.000Z',
    };
    const dlRow = {
      id: 'dl-1',
      capture_id: captureA,
      tool_name: 'bedrock:sonnet',
      error_class: 'ThrottlingException',
      error_message: 'rate limit',
      occurred_at: '2026-04-25T11:00:00.000Z',
    };
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = (q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      if (text.includes('FROM email_drafts')) return Promise.resolve({ rows: [draftRow] });
      if (text.includes('FROM agent_dead_letter')) return Promise.resolve({ rows: [dlRow] });
      return Promise.resolve({ rows: [] });
    };
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        items: Array<{ kind: string; id: string }>;
      };
      expect(body.items).toHaveLength(2);
      const kinds = body.items.map((i) => i.kind);
      expect(kinds).toContain('draft_reply');
      expect(kinds).toContain('dead_letter');
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('Test 9: /inbox-merged with no data returns []', async () => {
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = () => Promise.resolve({ rows: [] });
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).items).toEqual([]);
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('Test 10: EditDraftBodySchema bounds — subject > 300 + body > 10_000 reject', () => {
    expect(() =>
      EditDraftBodySchema.parse({ body: 'ok', subject: 'a'.repeat(301) }),
    ).toThrow();
    expect(() =>
      EditDraftBodySchema.parse({ body: 'b'.repeat(10_001), subject: 'ok' }),
    ).toThrow();
    expect(() =>
      EditDraftBodySchema.parse({ body: 'ok', subject: 'ok' }),
    ).not.toThrow();
  });
});

/**
 * Phase 11 D-05 — drop urgent-only filter on listInboxDrafts.
 *
 * The previous implementation filtered `status IN ('draft','edited')`,
 * which hid skipped/sent/failed/approved/junk/informational rows from
 * the inbox. Phase 11 surfaces ALL classified email rows and lets the
 * renderer decide which controls (Approve/Skip/Edit) to show per-row.
 */
describe('listInboxDrafts (Phase 11 D-05)', () => {
  beforeEach(() => {
    recordedQueries.length = 0;
  });

  it('returns rows with all statuses (no status-IN filter)', async () => {
    const orig = fakeDb.execute;
    const allStatusRows = [
      {
        draft_id: 'a',
        capture_id: captureA,
        from_email: 'x@y',
        subject: 's',
        draft_subject: null,
        draft_body: null,
        classification: 'junk',
        status: 'skipped',
        received_at: '2026-04-26T10:00:00Z',
      },
      {
        draft_id: 'b',
        capture_id: captureA,
        from_email: 'x@y',
        subject: 's',
        draft_subject: null,
        draft_body: null,
        classification: 'urgent',
        status: 'sent',
        received_at: '2026-04-26T09:00:00Z',
      },
      {
        draft_id: 'c',
        capture_id: captureA,
        from_email: 'x@y',
        subject: 's',
        draft_subject: null,
        draft_body: null,
        classification: 'urgent',
        status: 'draft',
        received_at: '2026-04-26T08:00:00Z',
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      recordedQueries.push({ text });
      if (text.includes('FROM email_drafts')) {
        return Promise.resolve({ rows: allStatusRows });
      }
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { listInboxDrafts } = await import(
        '../src/email-drafts-persist.js'
      );
      const rows = await listInboxDrafts(fakeDb as never);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.status).sort()).toEqual([
        'draft',
        'sent',
        'skipped',
      ]);
    } finally {
      fakeDb.execute = orig;
    }
  });

  it("SQL has NO status IN ('draft','edited') filter", async () => {
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      recordedQueries.push({ text });
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { listInboxDrafts } = await import(
        '../src/email-drafts-persist.js'
      );
      await listInboxDrafts(fakeDb as never);
      const lastQuery =
        recordedQueries[recordedQueries.length - 1]?.text ?? '';
      expect(lastQuery).not.toMatch(/status IN \('draft','edited'\)/);
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('SQL orders by received_at DESC', async () => {
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      recordedQueries.push({ text });
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { listInboxDrafts } = await import(
        '../src/email-drafts-persist.js'
      );
      await listInboxDrafts(fakeDb as never);
      const lastQuery =
        recordedQueries[recordedQueries.length - 1]?.text ?? '';
      expect(lastQuery).toMatch(/ORDER BY received_at DESC/);
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('default limit raised to 100 (was 50)', async () => {
    // Drizzle's sql template lays params out inline between chunk objects
    // in `.queryChunks`. To verify the default-limit value we scan the
    // chunk array for primitive values (strings/numbers) — the LAST
    // primitive is the LIMIT bound (the OWNER_ID is also a string param,
    // but it appears earlier in the chunk sequence).
    const orig = fakeDb.execute;
    let capturedQuery: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      recordedQueries.push({ text });
      if (capturedQuery === undefined) capturedQuery = q;
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { listInboxDrafts } = await import(
        '../src/email-drafts-persist.js'
      );
      await listInboxDrafts(fakeDb as never);
      expect(capturedQuery).toBeDefined();
      // Walk queryChunks, collect primitives (non-{value:...} entries).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks = (capturedQuery as any).queryChunks ?? [];
      const primitives = chunks.filter(
        (c: unknown) =>
          typeof c === 'string' ||
          typeof c === 'number' ||
          typeof c === 'boolean',
      );
      // Default-limit param sits at the end of the chunk-primitive list.
      expect(primitives[primitives.length - 1]).toBe(100);
    } finally {
      fakeDb.execute = orig;
    }
  });
});
