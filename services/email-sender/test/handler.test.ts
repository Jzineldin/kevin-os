/**
 * email-sender handler tests (Plan 04-05 Task 1).
 *
 * 8 tests cover the complete approve-gate enforcement contract:
 *   1. event.detail-type=email.approved → SES SendRawEmail invoked once
 *   2. email_drafts.sent_at populated after successful SES send
 *   3. email_send_authorizations.consumed_at populated
 *   4. draft already consumed (authorization.consumed_at set) → skip + log; no duplicate send
 *   5. SES throttle → withTimeoutAndRetry retries (handler returns success after retry)
 *   6. SES final failure → agent_dead_letter + inbox.dead_letter emitted; draft status='failed'
 *   7. invalid authorization_id → 400-like skip
 *   8. emitted email.sent event on success
 *
 * Test architecture: we mock pg's pool.connect() to return a fake client
 * whose `query` method drives a per-test scenario (load returns a fixed
 * row, BEGIN/COMMIT/ROLLBACK no-op, UPDATE writes recorded). SES is
 * mocked via the SESClient.send override exposed by ses.ts for tests.
 * EventBridge is mocked via the EventBridgeClient seam in handler.ts.
 *
 * The withTimeoutAndRetry exponential backoff (1s, 2s) would slow tests
 * massively — we override it via fake timers + the `backoffMs` opt is
 * already set to identity through retry runs (we instead inject a
 * one-shot SES throttle then a success on the SAME mocked send fn).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub Sentry / tracing modules — they call AWS Secrets Manager at cold
// start. We don't need real Sentry / Langfuse for the unit suite; use the
// no-op shape from the real module.
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  Sentry: {},
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

// Stub @aws-sdk/client-eventbridge so PutEventsCommand instantiation is
// inert — we re-export an EventBridgeClient class with a captured
// `send` mock the handler injects via __setEventBridgeClientForTest.
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class MockEB {
    send = vi.fn(async () => ({}));
  },
  PutEventsCommand: class MockCmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// Capture every dead-letter pool.query write so failure tests can
// assert agent_dead_letter row content.
const sesSendMock = vi.fn();
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: class MockSES {
    send = sesSendMock;
  },
  SendRawEmailCommand: class MockCmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// withTimeoutAndRetry uses real timers — we shrink the backoff so the
// "throttle once then succeed" test runs in <50ms instead of waiting 1s
// for the real exponential backoff.
vi.mock('../../_shared/with-timeout-retry.js', async (importOriginal) => {
  const orig = await importOriginal<
    typeof import('../../_shared/with-timeout-retry.js')
  >();
  return {
    ...orig,
    withTimeoutAndRetry: (fn: () => Promise<unknown>, opts: Parameters<
      typeof orig.withTimeoutAndRetry
    >[1]) =>
      orig.withTimeoutAndRetry(fn, {
        ...opts,
        backoffMs: () => 1, // 1ms backoff in tests
      }),
  };
});

const ulidCaptureId = '01HK000000000000000000000A';
const draftId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const authorizationId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ownerId = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeApprovedEvent() {
  return {
    source: 'kos.output',
    'detail-type': 'email.approved',
    detail: {
      capture_id: ulidCaptureId,
      draft_id: draftId,
      authorization_id: authorizationId,
      approved_at: '2026-04-25T10:00:00.000Z',
    },
  };
}

function makeLoadedRow(overrides: Record<string, unknown> = {}) {
  return {
    authorization_id: authorizationId,
    owner_id: ownerId,
    consumed_at: null,
    draft_id: draftId,
    capture_id: ulidCaptureId,
    account_id: 'kevin-taleforge',
    reply_to: 'damien@example.com',
    to_email: ['kevin@tale-forge.app'],
    subject: 'Original',
    draft_subject: 'Re: Original',
    draft_body: 'Tack Damien — kör på fredag.',
    in_reply_to: '<orig.123@example.com>',
    draft_status: 'approved',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.KEVIN_OWNER_ID = ownerId;
  process.env.AWS_REGION = 'eu-north-1';
});

describe('email-sender handler — Approve gate enforcement', () => {
  it('Test 1: detail-type=email.approved → SES SendRawEmail invoked once', async () => {
    const queryMock = makeQueryMock([makeLoadedRow()]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);
    sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-1' });

    const { handler } = await import('../src/handler.js');
    const res = await handler(makeApprovedEvent() as never, {} as never, () => {}) as
      | { sent?: string }
      | undefined;
    expect(res).toBeDefined();
    expect(res!.sent).toBe('ses-msg-1');
    expect(sesSendMock).toHaveBeenCalledTimes(1);
  });

  it('Test 2: email_drafts.sent_at populated after successful SES send', async () => {
    const queryMock = makeQueryMock([makeLoadedRow()]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);
    sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-2' });

    const { handler } = await import('../src/handler.js');
    await handler(makeApprovedEvent() as never, {} as never, () => {});
    const sentUpdate = queryMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes("status='sent'"),
    );
    expect(sentUpdate).toBeDefined();
    expect(sentUpdate![1]).toEqual([draftId, 'ses-msg-2']);
  });

  it('Test 3: email_send_authorizations.consumed_at populated', async () => {
    const queryMock = makeQueryMock([makeLoadedRow()]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);
    sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-3' });

    const { handler } = await import('../src/handler.js');
    await handler(makeApprovedEvent() as never, {} as never, () => {});
    const consumedUpdate = queryMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes('consumed_at=now()'),
    );
    expect(consumedUpdate).toBeDefined();
    const params = (consumedUpdate as unknown[])[1] as unknown[];
    // params[0] is authorizationId; params[1] is JSON-stringified result.
    expect(params[0]).toBe(authorizationId);
    expect(params[1]).toMatch(/"messageId":"ses-msg-3"/);
  });

  it('Test 4: draft already consumed → skip + no duplicate SES send', async () => {
    const queryMock = makeQueryMock([
      makeLoadedRow({ consumed_at: new Date('2026-04-25T09:00:00Z') }),
    ]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);

    const { handler } = await import('../src/handler.js');
    const res = await handler(makeApprovedEvent() as never, {} as never, () => {}) as
      | { skipped?: string }
      | undefined;
    expect(res).toBeDefined();
    expect(res!.skipped).toBe('not_found_or_consumed');
    expect(sesSendMock).not.toHaveBeenCalled();
    // ROLLBACK was issued (lock released).
    const rollback = queryMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'ROLLBACK',
    );
    expect(rollback).toBeDefined();
  });

  it('Test 5: SES throttle → withTimeoutAndRetry retries and ultimately succeeds', async () => {
    const queryMock = makeQueryMock([makeLoadedRow()]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
    });
    sesSendMock
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce({ MessageId: 'ses-msg-5' });

    const { handler } = await import('../src/handler.js');
    const res = await handler(makeApprovedEvent() as never, {} as never, () => {}) as
      | { sent?: string }
      | undefined;
    expect(res).toBeDefined();
    expect(res!.sent).toBe('ses-msg-5');
    expect(sesSendMock).toHaveBeenCalledTimes(2);
  });

  it('Test 6: SES final failure → dead-letter + draft status=failed', async () => {
    const queryMock = makeQueryMock([makeLoadedRow()]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);
    const fatal = Object.assign(new Error('Internal server error'), {
      statusCode: 500,
      name: 'InternalFailure',
    });
    sesSendMock.mockRejectedValue(fatal);

    const { handler } = await import('../src/handler.js');
    await expect(
      handler(makeApprovedEvent() as never, {} as never, () => {}),
    ).rejects.toThrow();
    // 3 attempts total (initial + 2 retries).
    expect(sesSendMock).toHaveBeenCalledTimes(3);
    // markDraftFailed UPDATE issued — fires on the pool, not the txn client.
    // We assert via the pool-level query mock used by markDraftFailed.
    expect(poolLevelQueryMock.mock.calls.some(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes("status='failed'"),
    )).toBe(true);
    // dead-letter row written by withTimeoutAndRetry.
    expect(poolLevelQueryMock.mock.calls.some(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('agent_dead_letter'),
    )).toBe(true);
  });

  it('Test 7: authorization not found → skip, no SES call', async () => {
    const queryMock = makeQueryMock([]); // empty rows
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);

    const { handler } = await import('../src/handler.js');
    const res = await handler(makeApprovedEvent() as never, {} as never, () => {}) as
      | { skipped?: string }
      | undefined;
    expect(res).toBeDefined();
    expect(res!.skipped).toBe('not_found_or_consumed');
    expect(sesSendMock).not.toHaveBeenCalled();
  });

  it('Test 8: email.sent event emitted on success', async () => {
    const queryMock = makeQueryMock([makeLoadedRow()]);
    const client: MockClient = { query: queryMock, release: vi.fn() };
    installPoolMock(client);
    sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-8' });

    // Capture EventBridge.send calls — the mocked client class instances
    // we create are accessible via __setEventBridgeClientForTest.
    const ebSend = vi.fn(async () => ({}));
    const fakeEb = { send: ebSend } as unknown as import('@aws-sdk/client-eventbridge').EventBridgeClient;
    const handlerMod = await import('../src/handler.js');
    handlerMod.__setEventBridgeClientForTest(fakeEb);

    await handlerMod.handler(makeApprovedEvent() as never, {} as never, () => {});
    const sentEmit = ebSend.mock.calls.find((c: unknown[]) => {
      const cmd = c[0] as { input?: { Entries?: Array<{ DetailType?: string }> } };
      return cmd.input?.Entries?.[0]?.DetailType === 'email.sent';
    });
    expect(sentEmit).toBeDefined();
    handlerMod.__setEventBridgeClientForTest(null);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a `client.query` mock whose first SELECT (the FOR UPDATE join)
 * returns the supplied rows; every other query (BEGIN/COMMIT/ROLLBACK/
 * UPDATEs) is a no-op returning rowCount=1.
 */
function makeQueryMock(loadedRows: ReturnType<typeof makeLoadedRow>[] | unknown[]) {
  const fn = vi.fn(async (text: string, _params?: unknown[]) => {
    if (text.includes('email_send_authorizations a')) {
      return { rows: loadedRows, rowCount: loadedRows.length };
    }
    return { rows: [], rowCount: 1 };
  });
  return fn;
}

let poolLevelQueryMock: ReturnType<typeof vi.fn>;

/**
 * Replace the email-sender handler's getPool() with a stub that returns
 * a pool-shaped object. The pool exposes:
 *   .connect()   → returns a per-txn `client` with .query + .release
 *   .query       → fires for markDraftFailed (outside the txn) + dead-letter writes
 */
function installPoolMock(client: MockClient): void {
  poolLevelQueryMock = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const fakePool = {
    connect: async () => client,
    query: poolLevelQueryMock,
  };
  // We stub the persist module's getPool via vi.doMock at module load — but
  // because tests `await import('../src/handler.js')` after this call, we
  // re-stub the resolved persist module's exports.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__kosFakePool = fakePool;
}

vi.mock('../src/persist.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/persist.js')>();
  return {
    ...orig,
    getPool: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const f = (globalThis as any).__kosFakePool;
      if (!f) throw new Error('fake pool not installed by test');
      return f;
    },
  };
});
