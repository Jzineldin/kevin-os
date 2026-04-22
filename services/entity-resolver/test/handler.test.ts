/**
 * Entity-resolver handler unit tests (Plan 02-05 Task 1).
 *
 * Covers all 7 branches of the 3-stage ENT-09 pipeline:
 *   1. auto-merge (with project co-occurrence) → mention_events + entity_merge audit
 *   2. auto-merge demoted (no co-occurrence) → falls through to llm-disambig
 *   3. llm-disambig matched → mention_events + entity_merge audit (secondary_signal='none')
 *   4. llm-disambig unknown (no pending) → createInboxRow (outcome='inbox-new')
 *   5. inbox stage (no pending) → createInboxRow
 *   6. inbox-appended: pendingPageId exists → appendCaptureIdToPending (no new row)
 *   7. approved-inbox: approvedPageId exists → mention_events(NULL) + approved hint, no disambig/no createInboxRow
 *
 * All external dependencies are mocked: @kos/resolver, @kos/contracts parse
 * is exercised directly, ./inbox.js, ./disambig.js, ./persist.js, and
 * EventBridge. Assertions drill into the arguments each collaborator
 * received to verify the routing contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (declared BEFORE handler import so vi.mock hoisting wins) ------

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

interface MockCandidate {
  id: string;
  name: string;
  aliases: string[];
  linkedProjects: string[];
  type: string;
  role: string | null;
  org: string | null;
  lastTouch: Date | null;
  trigramScore: number;
  cosineScore: number;
  hybridScore: number;
  stage: 'auto-merge' | 'llm-disambig' | 'inbox';
}

const resolverState = {
  candidates: [] as MockCandidate[],
  hasCooc: false,
};

vi.mock('@kos/resolver', () => ({
  embedBatch: vi.fn(async () => [new Array(1024).fill(0.01)]),
  findCandidates: vi.fn(async () => resolverState.candidates),
  hasProjectCooccurrence: vi.fn(() => resolverState.hasCooc),
}));

const poolQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
  // resolveCandidateNotionPageIds query
  if (/FROM entity_index WHERE id = ANY/.test(sql)) {
    return {
      rows: resolverState.candidates.map((c) => ({
        id: c.id,
        notion_page_id: `notion-${c.id}`,
      })),
    };
  }
  return { rows: [] };
});

const persistState = {
  prior: false,
  mentionEvents: [] as unknown[],
  mergeAudits: [] as unknown[],
  projectIds: [] as string[],
  runs: [] as unknown[],
};

vi.mock('../src/persist.js', () => ({
  findPriorOkRun: vi.fn(async () => persistState.prior),
  insertAgentRun: vi.fn(async (r: Record<string, unknown>) => {
    persistState.runs.push({ ...r, status: 'started' });
    return 'run-xyz';
  }),
  updateAgentRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    persistState.runs.push({ id, ...patch });
  }),
  insertMentionEvent: vi.fn(async (row: unknown) => {
    persistState.mentionEvents.push(row);
    return 'me-1';
  }),
  writeMergeAuditRow: vi.fn(async (row: unknown) => {
    persistState.mergeAudits.push(row);
  }),
  getCaptureProjectIds: vi.fn(async () => persistState.projectIds),
  getPool: vi.fn(async () => ({ query: poolQuery })),
}));

const inboxState = {
  lookup: {} as { approvedPageId?: string; pendingPageId?: string },
  createdPageId: 'inbox-page-NEW',
  appendedCaptures: [] as Array<{ pageId: string; captureId: string }>,
  createCalls: 0,
};

vi.mock('../src/inbox.js', () => ({
  findApprovedOrPendingInbox: vi.fn(async () => inboxState.lookup),
  createInboxRow: vi.fn(async (i: { proposedName: string }) => {
    inboxState.createCalls += 1;
    void i.proposedName;
    return inboxState.createdPageId;
  }),
  appendCaptureIdToPending: vi.fn(async (pageId: string, captureId: string) => {
    inboxState.appendedCaptures.push({ pageId, captureId });
  }),
  normaliseName: (s: string) => s.toLowerCase(),
}));

const disambigState = { result: { matched_id: 'unknown' } as { matched_id: string } };

vi.mock('../src/disambig.js', () => ({
  runDisambigWithRetry: vi.fn(async () => disambigState.result),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

// --- Helpers -------------------------------------------------------------

const ULID = '01HABCDEFGHJKMNPQRSTVWXYZ0';
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function mkCandidate(over: Partial<MockCandidate> & { id: string; hybridScore: number }): MockCandidate {
  return {
    name: 'Damien',
    aliases: [],
    linkedProjects: [],
    type: 'Person',
    role: null,
    org: null,
    lastTouch: null,
    trigramScore: 0.9,
    cosineScore: 0.9,
    stage:
      over.hybridScore > 0.95
        ? 'auto-merge'
        : over.hybridScore >= 0.75
          ? 'llm-disambig'
          : 'inbox',
    ...over,
  };
}

function baseEvent() {
  return {
    detail: {
      capture_id: ULID,
      mention_text: 'Damien',
      context_snippet: 'convertible loan signing',
      candidate_type: 'Person',
      source: 'telegram-text',
      occurred_at: new Date().toISOString(),
    },
  };
}

function getEmittedResolved(): Record<string, unknown> | null {
  const call = ebSend.mock.calls.find((c) =>
    JSON.stringify(c[0]).includes('mention.resolved'),
  );
  if (!call) return null;
  const detail = (call as unknown as [{ input: { Entries: { Detail: string }[] } }])[0]
    .input.Entries[0]!.Detail;
  return JSON.parse(detail) as Record<string, unknown>;
}

describe('entity-resolver handler', () => {
  beforeEach(() => {
    ebSend.mockClear();
    poolQuery.mockClear();
    persistState.prior = false;
    persistState.mentionEvents = [];
    persistState.mergeAudits = [];
    persistState.projectIds = [];
    persistState.runs = [];
    inboxState.lookup = {};
    inboxState.appendedCaptures = [];
    inboxState.createCalls = 0;
    resolverState.candidates = [];
    resolverState.hasCooc = false;
    disambigState.result = { matched_id: 'unknown' };
    process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('Branch 1 — auto-merge with project co-occurrence: writes mention_events + entity_merge audit (project_cooccurrence)', async () => {
    resolverState.candidates = [
      mkCandidate({ id: UUID_A, hybridScore: 0.97, linkedProjects: ['proj-tf'] }),
    ];
    resolverState.hasCooc = true;
    persistState.projectIds = ['proj-tf'];

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('matched');
    expect(res.stage).toBe('auto-merge');

    expect(persistState.mentionEvents).toHaveLength(1);
    expect((persistState.mentionEvents[0] as { entityId: string }).entityId).toBe(UUID_A);

    expect(persistState.mergeAudits).toHaveLength(1);
    expect(persistState.mergeAudits[0]).toMatchObject({
      targetEntityId: UUID_A,
      secondarySignal: 'project_cooccurrence',
    });

    const resolved = getEmittedResolved();
    expect(resolved?.outcome).toBe('matched');
    expect(resolved?.stage).toBe('auto-merge');
    expect(resolved?.matched_entity_id).toBe(UUID_A);

    expect(inboxState.createCalls).toBe(0);
  });

  it('Branch 2 — auto-merge demoted (no co-occurrence): calls runDisambigWithRetry; on match writes audit with secondary_signal="none"', async () => {
    resolverState.candidates = [
      mkCandidate({ id: UUID_A, hybridScore: 0.97, linkedProjects: ['proj-other'] }),
    ];
    resolverState.hasCooc = false; // demote
    persistState.projectIds = [];
    disambigState.result = { matched_id: UUID_A };

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('matched');
    expect(res.stage).toBe('llm-disambig');

    expect(persistState.mergeAudits).toHaveLength(1);
    expect(persistState.mergeAudits[0]).toMatchObject({
      targetEntityId: UUID_A,
      secondarySignal: 'none',
    });
    expect(inboxState.createCalls).toBe(0);
  });

  it('Branch 3 — llm-disambig native stage matched: writes audit with secondary_signal="none"', async () => {
    resolverState.candidates = [
      mkCandidate({ id: UUID_B, hybridScore: 0.82 }),
    ];
    disambigState.result = { matched_id: UUID_B };

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('matched');
    expect(res.stage).toBe('llm-disambig');
    expect(persistState.mergeAudits[0]).toMatchObject({
      targetEntityId: UUID_B,
      secondarySignal: 'none',
    });
    expect(inboxState.createCalls).toBe(0);
  });

  it('Branch 4 — llm-disambig unknown + no pending Inbox row: createInboxRow fires (outcome="inbox-new")', async () => {
    resolverState.candidates = [
      mkCandidate({ id: UUID_A, hybridScore: 0.82 }),
    ];
    disambigState.result = { matched_id: 'unknown' };

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('inbox-new');
    expect(res.stage).toBe('inbox');
    expect(inboxState.createCalls).toBe(1);

    expect(persistState.mentionEvents).toHaveLength(1);
    const me = persistState.mentionEvents[0] as { entityId: string | null; context: string };
    expect(me.entityId).toBeNull();
    expect(me.context).toContain('inbox=inbox-page-NEW');

    const resolved = getEmittedResolved();
    expect(resolved?.outcome).toBe('inbox-new');
    expect(resolved?.inbox_page_id).toBe('inbox-page-NEW');
  });

  it('Branch 5 — inbox stage (low score) + no pending: createInboxRow fires', async () => {
    resolverState.candidates = [
      mkCandidate({ id: UUID_A, hybridScore: 0.5 }),
    ];

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('inbox-new');
    expect(res.stage).toBe('inbox');
    expect(inboxState.createCalls).toBe(1);
  });

  it('Branch 6 — inbox-appended: pendingPageId exists → appendCaptureIdToPending; createInboxRow NOT called', async () => {
    resolverState.candidates = []; // empty candidates path
    inboxState.lookup = { pendingPageId: 'pending-xyz' };

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('inbox-appended');
    expect(res.stage).toBe('inbox');
    expect(inboxState.appendedCaptures).toEqual([{ pageId: 'pending-xyz', captureId: ULID }]);
    expect(inboxState.createCalls).toBe(0);

    const me = persistState.mentionEvents[0] as { entityId: string | null };
    expect(me.entityId).toBeNull();
  });

  it('Branch 7 — approved-inbox: approvedPageId exists → mention_events(entityId=NULL) with approved_inbox hint; no disambig, no createInboxRow', async () => {
    resolverState.candidates = [
      mkCandidate({ id: UUID_A, hybridScore: 0.97, linkedProjects: ['proj-tf'] }),
    ];
    resolverState.hasCooc = true; // would otherwise auto-merge
    persistState.projectIds = ['proj-tf'];
    inboxState.lookup = { approvedPageId: 'approved-abc' };

    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      outcome: string;
      stage: string;
    };
    expect(res.outcome).toBe('approved-inbox');
    expect(res.stage).toBe('inbox');

    expect(persistState.mentionEvents).toHaveLength(1);
    const me = persistState.mentionEvents[0] as { entityId: string | null; context: string };
    expect(me.entityId).toBeNull();
    expect(me.context).toContain('approved_inbox=approved-abc');

    // Critical assertions: approved path short-circuits BEFORE merge + BEFORE disambig
    expect(persistState.mergeAudits).toHaveLength(0);
    expect(inboxState.createCalls).toBe(0);
  });

  it('Idempotency: prior ok run → returns { idempotent } and emits no events', async () => {
    persistState.prior = true;
    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent())) as {
      idempotent?: string;
    };
    expect(res.idempotent).toBe('Damien');
    expect(ebSend).not.toHaveBeenCalled();
  });
});
