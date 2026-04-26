/**
 * Phase 11 Plan 11-03 Task 2 — /inbox-merged extension tests.
 *
 * Verifies the merged inbox handler now UNIONs three sources:
 *   - email_drafts (all statuses, classification + email_status carried)
 *   - agent_dead_letter (un-retried)
 *   - inbox_index (status='pending') — closes the doc-vs-code gap
 *
 * Uses the same vi.hoisted EventBridge mock + table-driven db.execute
 * pattern as services/dashboard-api/tests/email-drafts.test.ts. Each
 * SELECT branch is keyed off the table name in the SQL string.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const recordedQueries: Array<{ text: string }> = [];

interface FakeDb {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  transaction: (fn: (tx: FakeDb) => Promise<unknown>) => Promise<unknown>;
}

const fakeDb: FakeDb = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: ((q: any) => {
    const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
    recordedQueries.push({ text });
    return Promise.resolve({ rows: [] });
  }) as FakeDb['execute'],
  transaction: async (fn) => fn(fakeDb),
};

vi.mock('../src/db.js', () => ({
  getDb: async () => fakeDb,
  __setDbForTest: () => {},
}));

const draftId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const captureA = '01HK000000000000000000000A';

function makeCtx(method: 'GET' | 'POST', params: Record<string, string>) {
  return {
    method,
    path: '',
    params,
    query: {},
    body: null,
    headers: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedQueries.length = 0;
});

describe('/inbox-merged — Phase 11 Task 2 (UNION inbox_index)', () => {
  it('Test 1: returns items from email_drafts + agent_dead_letter + inbox_index', async () => {
    const draftRow = {
      draft_id: draftId,
      capture_id: captureA,
      from_email: 'damien@example.com',
      subject: 'Original',
      draft_subject: 'Re: Original',
      draft_body: 'draft body',
      classification: 'urgent',
      status: 'draft',
      received_at: '2026-04-26T10:00:00Z',
    };
    const dlRow = {
      id: 'dl-1',
      capture_id: captureA,
      tool_name: 'bedrock:sonnet',
      error_class: 'ThrottlingException',
      error_message: 'rate limit',
      occurred_at: '2026-04-26T11:00:00Z',
    };
    const indexRow = {
      id: 'idx-1',
      kind: 'entity_routing',
      title: 'Damien C. — needs disambiguation',
      preview: 'Two candidate entities matched',
      bolag: 'tale-forge',
      status: 'pending',
      entity_id: null,
      merge_id: null,
      payload: {},
      created_at: '2026-04-26T12:00:00Z',
    };
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      if (text.includes('FROM email_drafts'))
        return Promise.resolve({ rows: [draftRow] });
      if (text.includes('FROM agent_dead_letter'))
        return Promise.resolve({ rows: [dlRow] });
      if (text.includes('FROM inbox_index'))
        return Promise.resolve({ rows: [indexRow] });
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        items: Array<{ kind: string; id: string }>;
      };
      expect(body.items).toHaveLength(3);
      const kinds = body.items.map((i) => i.kind);
      expect(kinds).toContain('draft_reply');
      expect(kinds).toContain('dead_letter');
      expect(kinds).toContain('entity_routing');
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('Test 2: each email_draft item carries classification + email_status', async () => {
    const draftRow = {
      draft_id: draftId,
      capture_id: captureA,
      from_email: 'damien@example.com',
      subject: 'Original',
      draft_subject: 'Re: Original',
      draft_body: 'draft body',
      classification: 'informational',
      status: 'sent',
      received_at: '2026-04-26T10:00:00Z',
    };
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      if (text.includes('FROM email_drafts'))
        return Promise.resolve({ rows: [draftRow] });
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      const body = JSON.parse(res.body) as {
        items: Array<{
          kind: string;
          classification?: string | null;
          email_status?: string | null;
        }>;
      };
      const draft = body.items.find((i) => i.kind === 'draft_reply');
      expect(draft).toBeDefined();
      expect(draft?.classification).toBe('informational');
      expect(draft?.email_status).toBe('sent');
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('Test 3: inbox_index items have classification null (not email)', async () => {
    const indexRow = {
      id: 'idx-1',
      kind: 'new_entity',
      title: 'Sara at Almi',
      preview: 'New person mentioned',
      bolag: null,
      status: 'pending',
      entity_id: null,
      merge_id: null,
      payload: {},
      created_at: '2026-04-26T12:00:00Z',
    };
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      if (text.includes('FROM inbox_index'))
        return Promise.resolve({ rows: [indexRow] });
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      const body = JSON.parse(res.body) as {
        items: Array<{
          kind: string;
          classification?: string | null;
          email_status?: string | null;
        }>;
      };
      const indexItem = body.items.find((i) => i.kind === 'new_entity');
      expect(indexItem).toBeDefined();
      // Either undefined or explicitly null — both are non-classification.
      expect(
        indexItem?.classification === null ||
          indexItem?.classification === undefined,
      ).toBe(true);
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('Test 4: items merged + sorted by their respective time fields DESC', async () => {
    const oldDraft = {
      draft_id: draftId,
      capture_id: captureA,
      from_email: 'a@b',
      subject: 'old',
      draft_subject: null,
      draft_body: null,
      classification: 'urgent',
      status: 'draft',
      received_at: '2026-04-25T08:00:00Z',
    };
    const newDl = {
      id: 'dl-1',
      capture_id: captureA,
      tool_name: 'bedrock:sonnet',
      error_class: 'X',
      error_message: 'err',
      occurred_at: '2026-04-26T15:00:00Z',
    };
    const midIndex = {
      id: 'idx-1',
      kind: 'entity_routing',
      title: 'Mid',
      preview: 'p',
      bolag: null,
      status: 'pending',
      entity_id: null,
      merge_id: null,
      payload: {},
      created_at: '2026-04-26T10:00:00Z',
    };
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = ((q: any) => {
      const text = typeof q === 'string' ? q : (q.sql ?? JSON.stringify(q));
      if (text.includes('FROM email_drafts'))
        return Promise.resolve({ rows: [oldDraft] });
      if (text.includes('FROM agent_dead_letter'))
        return Promise.resolve({ rows: [newDl] });
      if (text.includes('FROM inbox_index'))
        return Promise.resolve({ rows: [midIndex] });
      return Promise.resolve({ rows: [] });
    }) as FakeDb['execute'];
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      const body = JSON.parse(res.body) as {
        items: Array<{ kind: string }>;
      };
      // Newest-first: dead_letter (15:00) > entity_routing (10:00) > draft (08:00)
      expect(body.items.map((i) => i.kind)).toEqual([
        'dead_letter',
        'entity_routing',
        'draft_reply',
      ]);
    } finally {
      fakeDb.execute = orig;
    }
  });

  it('Test 5: degraded path — pre-Phase 4 tables unavailable still returns 200 with []', async () => {
    const orig = fakeDb.execute;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeDb.execute = (() =>
      Promise.reject(new Error('relation does not exist'))) as FakeDb['execute'];
    try {
      const { mergedInboxHandler } = await import('../src/routes/inbox.js');
      const res = await mergedInboxHandler(makeCtx('GET', {}));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).items).toEqual([]);
    } finally {
      fakeDb.execute = orig;
    }
  });
});
