/**
 * Plan 10-01 Wave-1 handler tests for the VPS classify_and_save adapter.
 *
 * Mocks: EventBridge, Secrets Manager, Sentry, tracing. Each test pins the
 * system clock to a fixture NOW so the HMAC drift check is deterministic.
 *
 * The 8 plan-mandated behaviours (Task 1) live below as one `it` per row.
 * `Test 5` of the plan ("old-shape payload { title, is_duplicate: true } maps
 * to capture.received with channel=vps-classify-migration") is encoded as a
 * detail-shape assertion: the adapter emits a passthrough `raw` body PLUS a
 * server-side `source` so the EB consumer can recognise migration-adapter
 * traffic. The `channel` literal is intentionally NOT serialised at the
 * adapter (the canonical CaptureReceivedTextSchema discriminator does not
 * accept `vps-classify-migration` as a channel — see emit.ts comment).
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- AWS SDK mocks --------------------------------------------------------

const ebSend = vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [{}] });
const ebPutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: ebPutCtor,
}));

const TEST_SECRET = 'test-classify-shared-secret-not-for-prod';
const smSend = vi.fn().mockResolvedValue({ SecretString: TEST_SECRET });
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: smSend })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => x),
}));

// Sentry passthrough — wrapHandler returns the inner fn unchanged so we can
// assert response shapes directly. captureException is a spy so Test 8
// (Sentry capture on emit failure) can assert the call.
const captureExceptionSpy = vi.fn();
const initSentrySpy = vi.fn(async () => {});
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: initSentrySpy,
  wrapHandler: <T>(h: T): T => h,
  Sentry: {
    captureException: captureExceptionSpy,
    captureMessage: vi.fn(),
  },
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

// --- Fixture data ---------------------------------------------------------

const NOW = 1714028400; // 2026-04-25T07:00:00Z
const VALID_PAYLOAD = {
  title: 'Möte med Damien — sprint planning Q2',
  subject: 'Sprint Q2 — Tale Forge backend',
  is_duplicate: false,
  already_processed: false,
};
const VALID_BODY = JSON.stringify(VALID_PAYLOAD);

function sign(secret: string, t: number, body: string): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

interface FnUrlEventOpts {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  isBase64Encoded?: boolean;
}

function fnUrlEvent(opts: FnUrlEventOpts): unknown {
  return {
    rawPath: '/',
    requestContext: {
      http: { method: opts.method ?? 'POST', sourceIp: '203.0.113.7' },
    },
    headers: opts.headers ?? {},
    body: opts.body,
    isBase64Encoded: opts.isBase64Encoded ?? false,
  };
}

function signedHeaders(
  body: string,
  t: number = NOW,
  secret: string = TEST_SECRET,
): Record<string, string> {
  return {
    authorization: `Bearer ${secret}`,
    'x-kos-signature': `t=${t},v1=${sign(secret, t, body)}`,
  };
}

interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;

describe('vps-classify-migration / handler', () => {
  beforeEach(async () => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.HMAC_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/vps-classify-hmac-secret';
    process.env.KOS_CAPTURE_BUS_NAME = 'kos.capture';
    ebSend.mockClear();
    ebSend.mockResolvedValue({ FailedEntryCount: 0, Entries: [{}] });
    ebPutCtor.mockClear();
    smSend.mockClear();
    smSend.mockResolvedValue({ SecretString: TEST_SECRET });
    initSentrySpy.mockClear();
    captureExceptionSpy.mockClear();
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

  // -------------------------------------------------------------------------
  // Plan 10-01 Task 1 mandatory behaviours (Tests 1–8)
  // -------------------------------------------------------------------------

  it('Test 1 (hmac): valid signature passes — adapter returns 202 + capture_id', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) }),
    )) as Resp;
    expect(res.statusCode).toBe(202);
    const respBody = JSON.parse(res.body) as {
      capture_id: string;
      emitted_at: string;
      source: string;
      adapter_version: string;
    };
    expect(respBody.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(respBody.source).toBe('vps-classify-migration-adapter');
    expect(respBody.adapter_version).toBe('10-01-v1');
    expect(typeof respBody.emitted_at).toBe('string');
    expect(new Date(respBody.emitted_at).toString()).not.toBe('Invalid Date');
  });

  it('Test 2 (hmac): invalid signature → 401, no EB emit', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_SECRET}`,
          'x-kos-signature': `t=${NOW},v1=${'0'.repeat(64)}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('Test 3 (hmac): timestamp skew > 300s → 401, no EB emit', async () => {
    const past = NOW - 3600;
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_SECRET}`,
          'x-kos-signature': `t=${past},v1=${sign(TEST_SECRET, past, VALID_BODY)}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('Test 4 (hmac): replay within 300s passes (dedup is upstream)', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const headers = signedHeaders(VALID_BODY);
    const res1 = (await handler(
      fnUrlEvent({ body: VALID_BODY, headers }),
    )) as Resp;
    const res2 = (await handler(
      fnUrlEvent({ body: VALID_BODY, headers }),
    )) as Resp;
    expect(res1.statusCode).toBe(202);
    expect(res2.statusCode).toBe(202);
    // Both fired EB events; idempotency happens at the consumer via capture_id ULID.
    expect(ebSend).toHaveBeenCalledTimes(2);
    const r1 = JSON.parse(res1.body) as { capture_id: string };
    const r2 = JSON.parse(res2.body) as { capture_id: string };
    expect(r1.capture_id).not.toBe(r2.capture_id); // server-minted, distinct
  });

  it('Test 5 (handler): old-shape { title, is_duplicate: true } passthrough-emits with adapter source', async () => {
    const oldShape = JSON.stringify({ title: '[MIGRERAD] foo', is_duplicate: true });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: oldShape, headers: signedHeaders(oldShape) }),
    )) as Resp;
    expect(res.statusCode).toBe(202);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]![0] as {
      input: {
        Entries: {
          EventBusName: string;
          Source: string;
          DetailType: string;
          Detail: string;
        }[];
      };
    };
    const entry = putEvents.input.Entries[0]!;
    expect(entry.EventBusName).toBe('kos.capture');
    expect(entry.Source).toBe('kos.capture-migration-adapter');
    expect(entry.DetailType).toBe('capture.received');
    const detail = JSON.parse(entry.Detail) as {
      capture_id: string;
      source: string;
      emitted_at: string;
      raw: { title: string; is_duplicate: boolean };
    };
    expect(detail.source).toBe('vps-classify-migration-adapter');
    expect(detail.raw.title).toBe('[MIGRERAD] foo');
    expect(detail.raw.is_duplicate).toBe(true);
    expect(detail.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('Test 6 (handler): emits to kos.capture bus with PutEvents (env-var driven)', async () => {
    process.env.KOS_CAPTURE_BUS_NAME = 'custom-capture-bus-name';
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(fnUrlEvent({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) }));
    expect(ebSend).toHaveBeenCalledTimes(1);
    const putEvents = ebSend.mock.calls[0]![0] as {
      input: { Entries: { EventBusName: string }[] };
    };
    expect(putEvents.input.Entries[0]!.EventBusName).toBe('custom-capture-bus-name');
  });

  it('Test 7 (handler): JSON parse failure → 400, no EB emit', async () => {
    const garbage = 'not-json-at-all{';
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: garbage, headers: signedHeaders(garbage) }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('Test 7b (handler): non-object JSON (Zod failure) → 400 invalid_payload', async () => {
    // ClassifyPayloadSchema is z.object(...).passthrough(); a top-level array
    // or string fails Zod even with passthrough.
    const arrBody = JSON.stringify(['not', 'an', 'object']);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: arrBody, headers: signedHeaders(arrBody) }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    const respBody = JSON.parse(res.body) as { error: string };
    expect(respBody.error).toBe('invalid_payload');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('Test 8 (handler): EB emit failure → Sentry captureException + 500', async () => {
    ebSend.mockRejectedValueOnce(new Error('throttled'));
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) }),
    )) as Resp;
    expect(res.statusCode).toBe(500);
    // Sentry was called twice: once at the eventbridge_emit_failed site,
    // once at the outer-catch fallthrough. We assert at-least-once + the
    // tag the inner site sets.
    expect(captureExceptionSpy).toHaveBeenCalled();
    const tagged = captureExceptionSpy.mock.calls.find((call) => {
      const opts = (call as unknown[])[1] as
        | { tags?: Record<string, string> }
        | undefined;
      return opts?.tags?.['mig01.fatal'] === 'eventbridge_emit_failed';
    });
    expect(tagged).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Belt-and-braces: status-code policy + envelope edge cases
  // -------------------------------------------------------------------------

  it('non-POST method → 405', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, method: 'GET' }),
    )) as Resp;
    expect(res.statusCode).toBe(405);
  });

  it('missing body → 400 empty_body', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ headers: signedHeaders('') }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('empty_body');
  });

  it('missing Authorization Bearer → 401', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          'x-kos-signature': `t=${NOW},v1=${sign(TEST_SECRET, NOW, VALID_BODY)}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
  });

  it('Bearer mismatch (wrong shared secret) → 401, no EB emit', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: 'Bearer wrong-token',
          'x-kos-signature': `t=${NOW},v1=${sign(TEST_SECRET, NOW, VALID_BODY)}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('missing X-KOS-Signature header → 400 missing', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { authorization: `Bearer ${TEST_SECRET}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing');
  });

  it('Secrets Manager PLACEHOLDER value → 500 server_misconfigured', async () => {
    smSend.mockResolvedValueOnce({ SecretString: 'PLACEHOLDER' });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) }),
    )) as Resp;
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('server_misconfigured');
    expect(ebSend).not.toHaveBeenCalled();
    expect(captureExceptionSpy).toHaveBeenCalled();
  });

  it('initSentry is called once per invocation (cold-start posture)', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(fnUrlEvent({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) }));
    expect(initSentrySpy).toHaveBeenCalled();
  });

  it('PutEvents with FailedEntryCount > 0 → 500 (handler treats it as emit failure)', async () => {
    ebSend.mockResolvedValueOnce({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'rate exceeded' }],
    });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) }),
    )) as Resp;
    expect(res.statusCode).toBe(500);
  });
});
