/**
 * Phase 5 / Plan 05-01 — chrome-webhook handler tests.
 *
 * Mocks: EventBridge, Secrets Manager. Sentry + tracing helpers stub to
 * no-ops so the tests never reach Sentry/Langfuse.
 *
 * Each test pins `Date.now()` to a fixed NOW so the HMAC drift check is
 * deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// --- AWS SDK mocks ----------------------------------------------------------

const ebSend = vi.fn().mockResolvedValue({});
const ebPutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: ebPutCtor,
}));

const TEST_BEARER = 'test-bearer-not-for-production-use';
const TEST_HMAC_SECRET = 'test-hmac-not-for-production-use';

// Secrets Manager — return both secrets based on which arn is requested.
const smSend = vi.fn(async (cmd: { input: { SecretId: string } } | { SecretId: string }) => {
  const id =
    'input' in cmd ? cmd.input.SecretId : (cmd as { SecretId: string }).SecretId;
  if (id.includes('bearer')) return { SecretString: TEST_BEARER };
  if (id.includes('hmac')) return { SecretString: TEST_HMAC_SECRET };
  return { SecretString: 'PLACEHOLDER' };
});
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: smSend })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => x),
}));

// Sentry + tracing pass-throughs (avoid network).
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

// --- Helpers ---------------------------------------------------------------

const NOW = 1714028400; // 2026-04-25T07:00:00Z

/**
 * Sign an arbitrary body with our test HMAC secret. Mirrors the canonical
 * shape the Chrome extension's `apps/chrome-extension/src/lib/hmac.ts`
 * produces:  hex(hmac_sha256(secret, `${secret}.${t}.${body}`)).
 */
function sign(body: string, t: number, secret = TEST_HMAC_SECRET): string {
  return createHmac('sha256', secret).update(`${secret}.${t}.${body}`).digest('hex');
}

interface FnUrlOpts {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
}

function fnUrlEvent(opts: FnUrlOpts) {
  return {
    rawPath: '/highlight',
    requestContext: {
      http: { method: opts.method ?? 'POST', sourceIp: '203.0.113.7' },
    },
    headers: opts.headers ?? {},
    body: opts.body,
    isBase64Encoded: false,
  };
}

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;
interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

const VALID_PAYLOAD = {
  channel: 'chrome',
  kind: 'chrome_highlight',
  text: 'Damien Hateley said the deal closes Friday',
  source_url: 'https://news.ycombinator.com/item?id=42',
  source_title: 'HN — Story',
  selected_at: '2026-04-25T07:00:00.000Z',
  // capture_id intentionally absent — server mints + replaces.
};

describe('chrome-webhook handler', () => {
  beforeEach(async () => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.CHROME_BEARER_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/chrome-extension-bearer';
    process.env.CHROME_HMAC_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/chrome-extension-hmac-secret';
    ebSend.mockClear();
    ebPutCtor.mockClear();
    smSend.mockClear();
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

  it('valid request → 200 + EventBridge emit on kos.capture with chrome_highlight detail', async () => {
    const body = JSON.stringify(VALID_PAYLOAD);
    const sig = sign(body, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const respBody = JSON.parse(res.body) as { capture_id: string; status: string };
    expect(respBody.status).toBe('accepted');
    expect(respBody.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

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
    expect(entry.Source).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');
    const detail = JSON.parse(entry.Detail) as Record<string, unknown>;
    expect(detail.kind).toBe('chrome_highlight');
    expect(detail.channel).toBe('chrome');
    expect(detail.text).toBe(VALID_PAYLOAD.text);
    expect(detail.source_url).toBe(VALID_PAYLOAD.source_url);
    expect(detail.source_title).toBe(VALID_PAYLOAD.source_title);
    expect(detail.capture_id).toBe(respBody.capture_id);
    expect(typeof detail.received_at).toBe('string');
    expect(tagSpy).toHaveBeenCalledWith(respBody.capture_id);
  });

  it('missing Bearer → 401, no EventBridge emit', async () => {
    const body = JSON.stringify(VALID_PAYLOAD);
    const sig = sign(body, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-kos-signature': `t=${NOW},v1=${sig}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('wrong Bearer → 401', async () => {
    const body = JSON.stringify(VALID_PAYLOAD);
    const sig = sign(body, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: 'Bearer wrong-token',
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('missing X-KOS-Signature → 400 reason=missing', async () => {
    const body = JSON.stringify(VALID_PAYLOAD);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { authorization: `Bearer ${TEST_BEARER}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing');
  });

  it('bad signature → 401', async () => {
    const body = JSON.stringify(VALID_PAYLOAD);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${'0'.repeat(64)}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('timestamp drift > 300s → 401', async () => {
    const past = NOW - 3600;
    const body = JSON.stringify(VALID_PAYLOAD);
    const sig = sign(body, past);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${past},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('non-POST → 405', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        method: 'GET',
        headers: { authorization: `Bearer ${TEST_BEARER}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(405);
  });

  it('empty body → 400 empty_body', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        headers: { authorization: `Bearer ${TEST_BEARER}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('empty_body');
  });

  it('invalid JSON → 400 invalid_json', async () => {
    const body = 'not-json';
    const sig = sign(body, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
  });

  it('body fails Zod schema → 400 invalid_body', async () => {
    const body = JSON.stringify({ text: '', source_url: 'not-a-url' });
    const sig = sign(body, NOW);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_body');
    expect(ebSend).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('text > 50K bytes → 413 text_too_large', async () => {
    const big = 'x'.repeat(50_001);
    const payload = { ...VALID_PAYLOAD, text: big };
    const body = JSON.stringify(payload);
    const sig = sign(body, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error).toBe('text_too_large');
  });

  it('client-supplied capture_id is OVERRIDDEN by server-minted ULID', async () => {
    const payload = { ...VALID_PAYLOAD, capture_id: 'CLIENT-CHOSEN-FAKE-ID-XX-YYYY' };
    const body = JSON.stringify(payload);
    const sig = sign(body, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const respBody = JSON.parse(res.body) as { capture_id: string };
    // Server-minted ULID must be the canonical 26-char Crockford form.
    expect(respBody.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(respBody.capture_id).not.toBe('CLIENT-CHOSEN-FAKE-ID-XX-YYYY');
  });
});
