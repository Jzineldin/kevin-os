/**
 * Handler tests for emailengine-webhook (CAP-07 / Plan 04-03).
 *
 * Mocks: EventBridge, Secrets Manager (via secrets.ts). Sentry + tracing
 * helpers stubbed to no-ops so tests don't talk to external services.
 *
 * Tests:
 *   1. valid X-EE-Secret + messageNew → 200 + capture.received emitted
 *      (channel=email-inbox, kind=email_inbox).
 *   2. X-EE-Secret missing → 401.
 *   3. X-EE-Secret wrong → 401 (timingSafeEqual proof: equal-length wrong
 *      and unequal-length wrong both reject).
 *   4. payload event !== 'messageNew' → 200 + skipped (no emit).
 *   5. messageNew but messageId missing → 400.
 *   6. capture_id deterministic from (account, messageId) — same input
 *      across two invocations yields same capture_id.
 *   7. emitted detail passes CaptureReceivedEmailInboxSchema.
 *   8. withTimeoutAndRetry retries a transient EventBridge failure once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- AWS SDK mocks ---------------------------------------------------------
const ebSend = vi.fn().mockResolvedValue({});
const ebPutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: ebPutCtor,
}));

const TEST_SECRET = 'test-ee-secret-not-for-production-use';
const smSend = vi.fn().mockResolvedValue({ SecretString: TEST_SECRET });
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: smSend })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => x),
}));

// Sentry + tracing pass-throughs.
const initSentrySpy = vi.fn(async () => {});
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: initSentrySpy,
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
const tagSpy = vi.fn();
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagSpy,
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

// --- Fixtures --------------------------------------------------------------
const NOW = 1714028400; // 2026-04-25T07:00:00Z

function messageNewPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    account: 'kevin-elzarka',
    date: '2026-04-25T07:00:00Z',
    path: 'INBOX',
    event: 'messageNew',
    data: {
      id: 'AAAAAQAACnA',
      uid: 12345,
      messageId: '<CADxYz123@mail.gmail.com>',
      from: { name: 'Damien', address: 'damien@example.com' },
      to: [{ address: 'kevin.elzarka@gmail.com' }],
      subject: 'Re: investment terms',
      text: { plain: 'looks good — proceeding', html: '<p>looks good</p>' },
      date: '2026-04-25T06:59:30Z',
    },
    ...overrides,
  });
}

function fnUrlEvent(opts: {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  isBase64Encoded?: boolean;
}) {
  return {
    rawPath: '/',
    requestContext: { http: { method: opts.method ?? 'POST', sourceIp: '203.0.113.7' } },
    headers: opts.headers ?? {},
    body: opts.body,
    isBase64Encoded: opts.isBase64Encoded ?? false,
  };
}

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;
interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

describe('emailengine-webhook handler', () => {
  beforeEach(async () => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.EE_WEBHOOK_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/emailengine-webhook-secret';
    process.env.KEVIN_OWNER_ID = '11111111-1111-1111-1111-111111111111';
    ebSend.mockClear();
    ebSend.mockResolvedValue({});
    ebPutCtor.mockClear();
    smSend.mockClear();
    smSend.mockResolvedValue({ SecretString: TEST_SECRET });
    initSentrySpy.mockClear();
    tagSpy.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.resetModules();
    const sec = await import('../src/secrets.js');
    sec.__resetSecretsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('valid X-EE-Secret + messageNew → 200 + capture.received on kos.capture', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: messageNewPayload(),
        headers: { 'x-ee-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const respBody = JSON.parse(res.body) as { capture_id: string; status: string };
    expect(respBody.status).toBe('accepted');
    expect(respBody.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]![0] as {
      input: {
        Entries: { EventBusName: string; Source: string; DetailType: string; Detail: string }[];
      };
    };
    const entry = putEvents.input.Entries[0]!;
    expect(entry.EventBusName).toBe('kos.capture');
    expect(entry.Source).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');
    const detail = JSON.parse(entry.Detail) as {
      kind: string;
      channel: string;
      capture_id: string;
      email: { account_id: string; message_id: string; from: string; subject: string };
    };
    expect(detail.kind).toBe('email_inbox');
    expect(detail.channel).toBe('email-inbox');
    expect(detail.email.account_id).toBe('kevin-elzarka');
    expect(detail.email.message_id).toBe('<CADxYz123@mail.gmail.com>');
    expect(detail.email.from).toBe('damien@example.com');
    expect(detail.email.subject).toBe('Re: investment terms');
  });

  it('X-EE-Secret missing → 401, no EventBridge emit', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: messageNewPayload(), headers: {} }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('missing_secret');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('X-EE-Secret wrong (equal length) → 401 via timingSafeEqual', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    // Same length as TEST_SECRET, different bytes — exercises timingSafeEqual
    // rather than the length-mismatch short-circuit.
    const wrong = 'X'.repeat(TEST_SECRET.length);
    expect(wrong.length).toBe(TEST_SECRET.length);
    const res = (await handler(
      fnUrlEvent({
        body: messageNewPayload(),
        headers: { 'x-ee-secret': wrong },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('bad_secret');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('X-EE-Secret wrong (unequal length) → 401 (length-mismatch short-circuit)', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: messageNewPayload(),
        headers: { 'x-ee-secret': 'too-short' },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('bad_secret');
  });

  it('event !== messageNew (e.g. messageDeleted) → 200 + skipped, no emit', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: messageNewPayload({ event: 'messageDeleted' }),
        headers: { 'x-ee-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).skipped).toBe('messageDeleted');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('messageNew but messageId missing → 400, no emit', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const noMessageId = JSON.stringify({
      account: 'kevin-elzarka',
      date: '2026-04-25T07:00:00Z',
      path: 'INBOX',
      event: 'messageNew',
      data: { id: 'X', uid: 1 }, // no messageId
    });
    const res = (await handler(
      fnUrlEvent({ body: noMessageId, headers: { 'x-ee-secret': TEST_SECRET } }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_message_id_or_account');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('capture_id is deterministic from (account, messageId) — same input, same id', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const body = messageNewPayload();
    const res1 = (await handler(
      fnUrlEvent({ body, headers: { 'x-ee-secret': TEST_SECRET } }),
    )) as Resp;
    const res2 = (await handler(
      fnUrlEvent({ body, headers: { 'x-ee-secret': TEST_SECRET } }),
    )) as Resp;
    const id1 = JSON.parse(res1.body).capture_id as string;
    const id2 = JSON.parse(res2.body).capture_id as string;
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('emitted detail passes Zod CaptureReceivedEmailInboxSchema', async () => {
    const { CaptureReceivedEmailInboxSchema } = await import('@kos/contracts');
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(
      fnUrlEvent({
        body: messageNewPayload(),
        headers: { 'x-ee-secret': TEST_SECRET },
      }),
    );
    const putEvents = ebSend.mock.calls[0]![0] as {
      input: { Entries: { Detail: string }[] };
    };
    const detail = JSON.parse(putEvents.input.Entries[0]!.Detail);
    // Throws if invalid; keep the parsed result so the test reads naturally.
    const parsed = CaptureReceivedEmailInboxSchema.parse(detail);
    expect(parsed.channel).toBe('email-inbox');
    expect(parsed.kind).toBe('email_inbox');
    expect(parsed.email.imap_uid).toBe(12345);
  });

  it('withTimeoutAndRetry retries a transient EventBridge failure once', async () => {
    // Reject once with a 5xx-shape error (defaultShouldRetry returns true);
    // succeed on retry.
    const transient = Object.assign(new Error('upstream 503'), {
      name: 'ServiceUnavailable',
      statusCode: 503,
    });
    ebSend.mockRejectedValueOnce(transient).mockResolvedValueOnce({});
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    // withTimeoutAndRetry default backoff is 2^attempt * 1000ms; advance fake
    // timers so the 1s sleep resolves immediately.
    const promise = handler(
      fnUrlEvent({
        body: messageNewPayload(),
        headers: { 'x-ee-secret': TEST_SECRET },
      }),
    );
    // Pump the timer so the retry's sleep(1000) resolves under fake timers.
    await vi.advanceTimersByTimeAsync(1500);
    const res = (await promise) as Resp;
    expect(res.statusCode).toBe(200);
    expect(ebSend).toHaveBeenCalledTimes(2);
  });
});
