/**
 * handler.ts unit tests — Phase 4 Plan 04-02 Task 2.
 *
 * Coverage:
 *   1. SES event with S3 objectKey → S3Client constructed for eu-west-1 + GetObject invoked.
 *   2. Valid MIME → capture.received emitted with channel=email-forward kind=email_forward.
 *   3. capture_id derived from sha256(messageId) — deterministic across two invocations.
 *   4. Empty / missing Records → throws (no emit).
 *   5. S3 error surfaces (Lambda fails so SES retry triggers — unchanged after retries).
 *   6. Emitted detail passes CaptureReceivedEmailForwardSchema.
 *   7. tagTraceWithCaptureId called once per record with the deterministic ULID.
 *
 * Mocking strategy mirrors services/telegram-bot/test/handler.test.ts:
 *   - Sentry / Langfuse wrappers stubbed to passthroughs (no DSN required).
 *   - AWS SDK clients (S3, EventBridge) replaced with vi.fn() send mocks.
 *   - The mailparser fixture is fed directly via the S3 GetObject body stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { FORWARDED_EMAIL_MIME } from '@kos/test-fixtures';

// --- Mocks -----------------------------------------------------------------

// EventBridge: spy on .send so tests can inspect Detail content.
const ebSend = vi.fn().mockResolvedValue({});
const ebClientCtor = vi.fn().mockImplementation(() => ({ send: ebSend }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: ebClientCtor,
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

// S3: spy on .send AND on the constructor (so we can assert region='eu-west-1').
const s3Send = vi.fn();
const s3ClientCtor = vi.fn().mockImplementation(() => ({ send: s3Send }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: s3ClientCtor,
  GetObjectCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

// Sentry / Langfuse: passthrough so we don't need real DSNs in test.
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

const tagTraceSpy = vi.fn();
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagTraceSpy,
}));

vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

// withTimeoutAndRetry: keep real semantics (it's pure logic with stubbed
// AWS SDK clients downstream), but the dead-letter EventBridge emit ALSO
// goes through ebSend, so successful tests stay clean.
//
// The shared module imports @aws-sdk/client-eventbridge for PutEventsCommand
// at the top of the file — our mock above replaces that, so writes succeed.

// --- Helpers ---------------------------------------------------------------

/** Build a minimal SES Lambda event with an S3 receipt action. */
function makeSesEvent(opts: {
  bucketName?: string;
  objectKey?: string;
  messageId?: string;
  type?: string;
} = {}) {
  const {
    bucketName = 'kos-ses-inbound-euw1-123456789012',
    objectKey = 'incoming/test-message.eml',
    messageId = '<forward-almi-v2@elzarka.se>',
    type = 'S3',
  } = opts;
  return {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: {
          mail: {
            timestamp: '2026-04-25T07:14:22.000Z',
            source: 'kevin@elzarka.se',
            messageId: 'ses-internal-id-abc',
            destination: ['forward@kos.tale-forge.app'],
            headersTruncated: false,
            commonHeaders: {
              from: ['Kevin El-zarka <kevin@elzarka.se>'],
              to: ['forward@kos.tale-forge.app'],
              subject: 'Fwd: Almi Invest avtal v2',
              date: 'Fri, 25 Apr 2026 09:14:22 +0200',
              messageId,
            },
          },
          receipt: {
            recipients: ['forward@kos.tale-forge.app'],
            action: { type, bucketName, objectKey },
          },
        },
      },
    ],
  };
}

/** Stub an S3 GetObject Body that mailparser can consume. */
function s3BodyOf(content: string) {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;

describe('ses-inbound handler', () => {
  beforeEach(() => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.KEVIN_OWNER_ID = '9e4be978-cc7d-571b-98ec-a1e92373682c';
    ebSend.mockClear();
    ebSend.mockResolvedValue({});
    s3Send.mockClear();
    s3ClientCtor.mockClear();
    ebClientCtor.mockClear();
    tagTraceSpy.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('constructs S3Client with region=eu-west-1 (cross-region GetObject)', async () => {
    s3Send.mockResolvedValue({ Body: s3BodyOf(FORWARDED_EMAIL_MIME) });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(makeSesEvent());
    // S3Client constructor was called with the eu-west-1 region.
    const calls = s3ClientCtor.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const regions = calls.map((c: unknown[]) => (c[0] as { region?: string })?.region);
    expect(regions).toContain('eu-west-1');
  });

  it('emits capture.received on kos.capture with channel=email-forward / kind=email_forward', async () => {
    s3Send.mockResolvedValue({ Body: s3BodyOf(FORWARDED_EMAIL_MIME) });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(makeSesEvent());

    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(captureCalls.length).toBe(1);
    const firstCall = captureCalls[0]!;
    const input = (firstCall[0] as { input: { Entries: Array<{ Detail: string; Source: string; DetailType: string; EventBusName: string }> } }).input;
    const entry = input.Entries[0]!;
    expect(entry.EventBusName).toBe('kos.capture');
    expect(entry.Source).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');
    const detail = JSON.parse(entry.Detail) as { channel: string; kind: string };
    expect(detail.channel).toBe('email-forward');
    expect(detail.kind).toBe('email_forward');
  });

  it('emitted detail passes CaptureReceivedEmailForwardSchema', async () => {
    s3Send.mockResolvedValue({ Body: s3BodyOf(FORWARDED_EMAIL_MIME) });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(makeSesEvent());

    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    const entry = (captureCalls[0]![0] as { input: { Entries: Array<{ Detail: string }> } }).input.Entries[0]!;
    const detail = JSON.parse(entry.Detail);

    const { CaptureReceivedEmailForwardSchema } = await import('@kos/contracts');
    const result = CaptureReceivedEmailForwardSchema.safeParse(detail);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email.s3_ref.region).toBe('eu-west-1');
      expect(result.data.email.message_id).toBe('forward-almi-v2@elzarka.se');
      expect(result.data.email.from).toBe('kevin@elzarka.se');
    }
  });

  it('capture_id is deterministic across SES retries (same messageId → same id)', async () => {
    s3Send.mockResolvedValue({ Body: s3BodyOf(FORWARDED_EMAIL_MIME) });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;

    await handler(makeSesEvent());
    // Re-stub the body for the second invocation (Readable streams are
    // single-shot — once consumed they're empty).
    s3Send.mockResolvedValue({ Body: s3BodyOf(FORWARDED_EMAIL_MIME) });
    await handler(makeSesEvent());

    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(captureCalls.length).toBe(2);
    const ids = captureCalls.map((c: unknown[]) => {
      const entry = (c[0] as { input: { Entries: Array<{ Detail: string }> } }).input.Entries[0]!;
      return JSON.parse(entry.Detail).capture_id as string;
    });
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('throws when event has no Records (malformed SES invocation)', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await expect(handler({} as unknown)).rejects.toThrow(/no Records/);
    // No EventBridge emit should have happened.
    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(captureCalls.length).toBe(0);
  });

  it('S3 GetObject failure surfaces (Lambda errors → SES retries)', async () => {
    s3Send.mockRejectedValue(new Error('NoSuchKey'));
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await expect(handler(makeSesEvent())).rejects.toThrow(/NoSuchKey/);
    // No PutEvents on a failed read — SES will retry.
    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(captureCalls.length).toBe(0);
  });

  it('tagTraceWithCaptureId called exactly once per record with the deterministic ULID', async () => {
    s3Send.mockResolvedValue({ Body: s3BodyOf(FORWARDED_EMAIL_MIME) });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(makeSesEvent());

    expect(tagTraceSpy).toHaveBeenCalledTimes(1);
    const callArg = tagTraceSpy.mock.calls[0]![0] as string;
    expect(callArg).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    const detail = JSON.parse((captureCalls[0]![0] as { input: { Entries: Array<{ Detail: string }> } }).input.Entries[0]!.Detail);
    expect(detail.capture_id).toBe(callArg);
  });

  it('skips non-S3 receipt actions without throwing or emitting', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const evt = makeSesEvent({ type: 'Lambda' });
    const res = await handler(evt) as { processed: number };
    expect(res.processed).toBe(0);
    const captureCalls = ebSend.mock.calls.filter((c: unknown[]) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(captureCalls.length).toBe(0);
  });
});

describe('deterministicCaptureIdFromMessageId', () => {
  it('produces a 26-char Crockford ULID-shaped string', async () => {
    const mod = await import('../src/handler.js');
    const id = mod.__test.deterministicCaptureIdFromMessageId('test-msg-id@example.com');
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is deterministic across calls', async () => {
    const mod = await import('../src/handler.js');
    const a = mod.__test.deterministicCaptureIdFromMessageId('foo@bar');
    const b = mod.__test.deterministicCaptureIdFromMessageId('foo@bar');
    expect(a).toBe(b);
  });

  it('produces different output for different message-ids', async () => {
    const mod = await import('../src/handler.js');
    const a = mod.__test.deterministicCaptureIdFromMessageId('msg-a@h');
    const b = mod.__test.deterministicCaptureIdFromMessageId('msg-b@h');
    expect(a).not.toBe(b);
  });
});
