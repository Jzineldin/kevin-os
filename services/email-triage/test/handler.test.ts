/**
 * Email-triage handler tests (Plan 04-04 Task 3).
 *
 * 6 tests covering:
 *   - capture.received / email_inbox → classify + draft for urgent + emit draft_ready
 *   - capture.received / email_forward → mapped to forward path; account_id='forward'
 *   - scan_emails_now → processes pending rows
 *   - duplicate fixture → single draft id (idempotent insert)
 *   - urgent classification non-emit when status != draft (informational path)
 *   - adversarial-injection fixture → classify returns junk; no draft generated;
 *     no draft_ready emit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ADVERSARIAL_INJECTION_EMAIL,
  DUPLICATE_EMAIL_FIXTURES,
} from '@kos/test-fixtures';

// --- Mocks (declared BEFORE handler import) ---

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));
vi.mock('../../_shared/with-timeout-retry.js', () => ({
  withTimeoutAndRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// draft_id must be a real UUID — DraftReadySchema validates it.
const FRESH_DRAFT_UUID = '00000000-0000-4000-8000-000000000001';
const persistState = {
  insertCount: 0,
  draftId: FRESH_DRAFT_UUID,
  pending: [] as unknown[],
};
vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  insertEmailDraftPending: vi.fn(async () => {
    persistState.insertCount += 1;
    return persistState.draftId;
  }),
  findExistingDraftByMessage: vi.fn(async () => persistState.draftId),
  updateEmailDraftClassified: vi.fn(async () => undefined),
  loadPendingDrafts: vi.fn(async () => persistState.pending),
}));

vi.mock('../src/resolveEntities.js', () => ({
  resolveEntitiesByEmail: vi.fn(async () => []),
}));

vi.mock('../src/context.js', () => ({
  loadTriageContext: vi.fn(async () => ({
    kevinContext: '## Current priorities\nx',
    additionalContextBlock: '',
    cacheHit: false,
    elapsedMs: 1,
    degraded: false,
  })),
}));

const classifyMock = vi.fn();
const draftMock = vi.fn();
vi.mock('../src/classify.js', () => ({
  runClassifyAgent: classifyMock,
}));
vi.mock('../src/draft.js', () => ({
  runDraftAgent: draftMock,
}));

const VALID_ULID = '01HZ0000000000000000000ABC';
const VALID_ULID_2 = '01HZ0000000000000000000DEF';

function makeInboxEvent(captureId: string, accountId: string, messageId: string) {
  return {
    source: 'kos.capture',
    'detail-type': 'capture.received',
    detail: {
      capture_id: captureId,
      channel: 'email-inbox',
      kind: 'email_inbox',
      email: {
        account_id: accountId,
        message_id: messageId,
        from: 'sender@example.com',
        to: ['kevin@tale-forge.app'],
        subject: 'Test',
        body_text: 'hello',
        received_at: '2026-04-25T07:00:00.000Z',
      },
      received_at: '2026-04-25T07:00:00.000Z',
    },
  };
}

describe('email-triage handler', () => {
  beforeEach(() => {
    ebSend.mockClear();
    classifyMock.mockReset();
    draftMock.mockReset();
    persistState.insertCount = 0;
    persistState.draftId = FRESH_DRAFT_UUID;
    persistState.pending = [];
    process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.OUTPUT_BUS_NAME = 'kos.output';
  });

  it('email_inbox + urgent classification → classify + draft + emit draft_ready', async () => {
    classifyMock.mockResolvedValueOnce({
      output: { classification: 'urgent', reason: 'investor', detected_entities: [] },
      usage: { inputTokens: 100, outputTokens: 20 },
      rawText: '{}',
    });
    draftMock.mockResolvedValueOnce({
      output: {
        subject: 'Re: Test',
        body: 'thanks — looking now',
        reply_to: 'sender@example.com',
        tone_notes: 'short',
      },
      usage: { inputTokens: 200, outputTokens: 50 },
      rawText: '{}',
    });
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeInboxEvent(VALID_ULID, 'kevin-taleforge', '<msg-1@example.com>'),
    )) as { draft_id: string; classification: string };
    expect(r.classification).toBe('urgent');
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(draftMock).toHaveBeenCalledTimes(1);
    const sendCall = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('draft_ready'),
    );
    expect(sendCall).toBeDefined();
  });

  it('email_forward maps to per-email path with account_id=forward', async () => {
    classifyMock.mockResolvedValueOnce({
      output: { classification: 'informational', reason: 'fyi', detected_entities: [] },
      usage: {},
      rawText: '{}',
    });
    const { handler } = await import('../src/handler.js');
    const event = {
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: {
        capture_id: VALID_ULID_2,
        channel: 'email-forward',
        kind: 'email_forward',
        email: {
          message_id: '<fwd-1@example.com>',
          from: 'sender@example.com',
          to: ['kevin@tale-forge.app'],
          subject: 'Fwd: x',
          body_text: 'forwarded body',
          s3_ref: { bucket: 'b', key: 'k', region: 'eu-west-1' },
          received_at: '2026-04-25T07:00:00.000Z',
        },
        received_at: '2026-04-25T07:00:00.000Z',
      },
    };
    await (handler as unknown as (e: unknown) => Promise<unknown>)(event);
    // Verify persist.insertEmailDraftPending was called with accountId='forward'
    const persist = await import('../src/persist.js');
    const insertCall = (persist.insertEmailDraftPending as unknown as { mock: { calls: Array<unknown[]> } }).mock.calls.at(-1);
    expect((insertCall?.[1] as { accountId: string }).accountId).toBe('forward');
  });

  it('scan_emails_now iterates pending rows', async () => {
    persistState.pending = [
      {
        id: 'd1',
        capture_id: VALID_ULID,
        account_id: 'a',
        message_id: 'm1',
        from_email: 'x@y.example',
        to_email: ['kevin@tale-forge.app'],
        subject: 'pending',
        received_at: '2026-04-25T07:00:00.000Z',
      },
    ];
    classifyMock.mockResolvedValue({
      output: { classification: 'informational', reason: 'rescan', detected_entities: [] },
      usage: {},
      rawText: '{}',
    });
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.system',
      'detail-type': 'scan_emails_now',
      detail: {},
    })) as { scanned: number };
    expect(r.scanned).toBe(1);
    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it('idempotency: same Message-ID twice → both return the same draft id', async () => {
    classifyMock.mockResolvedValue({
      output: { classification: 'informational', reason: 'fyi', detected_entities: [] },
      usage: {},
      rawText: '{}',
    });
    const { handler } = await import('../src/handler.js');
    // The shipped DUPLICATE_EMAIL_FIXTURES use capture_ids that contain 'U'
    // which is excluded from the ULID Crockford alphabet — so we rebuild
    // the same shape with valid ULIDs but identical (account_id, message_id)
    // to exercise the same idempotency path the fixtures encode.
    const [a, b] = DUPLICATE_EMAIL_FIXTURES;
    const dup1 = { ...a, capture_id: VALID_ULID };
    const dup2 = { ...b, capture_id: VALID_ULID_2 };
    const r1 = (await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: dup1,
    })) as { draft_id: string };
    const r2 = (await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: dup2,
    })) as { draft_id: string };
    expect(r1.draft_id).toBe(FRESH_DRAFT_UUID);
    expect(r2.draft_id).toBe(FRESH_DRAFT_UUID);
  });

  it('non-urgent classification → no draft, no emit', async () => {
    classifyMock.mockResolvedValueOnce({
      output: { classification: 'informational', reason: 'fyi', detected_entities: [] },
      usage: {},
      rawText: '{}',
    });
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeInboxEvent(VALID_ULID, 'kevin-taleforge', '<msg-x@example.com>'),
    );
    expect(draftMock).not.toHaveBeenCalled();
    const draftReady = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('draft_ready'),
    );
    expect(draftReady).toBeUndefined();
  });

  it('adversarial fixture → classify returns junk; no draft generated; no draft_ready emit', async () => {
    classifyMock.mockResolvedValueOnce({
      output: {
        classification: 'junk',
        reason: 'prompt_injection_detected',
        detected_entities: [],
      },
      usage: {},
      rawText: '{}',
    });
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: ADVERSARIAL_INJECTION_EMAIL,
    })) as { classification: string };
    expect(r.classification).toBe('junk');
    expect(draftMock).not.toHaveBeenCalled();
    const draftReady = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('draft_ready'),
    );
    expect(draftReady).toBeUndefined();
  });
});
