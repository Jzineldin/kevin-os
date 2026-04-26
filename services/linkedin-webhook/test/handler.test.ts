/**
 * Plan 05-02 — linkedin-webhook handler tests.
 *
 * Mocks: EventBridge + Secrets Manager + Sentry/tracing helpers. Date.now()
 * pinned per test so HMAC drift checks pass deterministically.
 *
 * Coverage:
 *   - happy path → 200 + PutEvents on kos.capture w/ matching detail shape
 *   - missing/wrong Bearer → 401 (no PutEvents)
 *   - missing X-KOS-Signature → 400 'missing'
 *   - drift > 300s → 401
 *   - tampered v1 → 401
 *   - invalid JSON body → 400
 *   - body fails Zod parse (missing message_urn) → 400
 *   - capture_id not ULID → 400
 *   - non-POST method → 405
 *   - non-/linkedin path → 404
 *   - empty body → 400
 *   - PutEvents call shape (Bus + DetailType + Source)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const ebSend = vi.fn().mockResolvedValue({});
const ebPutCtor = vi
  .fn()
  .mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: ebPutCtor,
}));

const TEST_BEARER = 'test-bearer-token-value';
const TEST_HMAC = 'test-hmac-secret-value';
const smSend = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: smSend })),
  GetSecretValueCommand: vi
    .fn()
    .mockImplementation((x: unknown) => ({ input: x })),
}));

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

const NOW = 1714028400; // 2026-04-25T07:00:00Z

const VALID_DETAIL = {
  capture_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', // 26-char ULID
  channel: 'linkedin' as const,
  kind: 'linkedin_dm' as const,
  conversation_urn: 'urn:li:fs_conversation:2-AAAAAAAA',
  message_urn: 'urn:li:fs_event:(2-AAAAAAAA,5-BBBBBBBB)',
  from: { name: 'Damien Hateley', li_public_id: 'damien-hateley' },
  body: 'Yo Kevin, saw your deck — can we jump on a call?',
  sent_at: '2026-04-22T17:52:25.678Z',
  received_at: '2026-04-25T07:00:00.000Z',
};
const VALID_BODY = JSON.stringify(VALID_DETAIL);

function sign(body: string, ts: number, secret = TEST_HMAC): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function fnUrlEvent(opts: {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
}) {
  return {
    rawPath: opts.path ?? '/linkedin',
    requestContext: {
      http: {
        method: opts.method ?? 'POST',
        path: opts.path ?? '/linkedin',
        sourceIp: '203.0.113.7',
      },
    },
    headers: opts.headers ?? {},
    body: opts.body,
    isBase64Encoded: false,
  };
}

type AnyHandler = (e: unknown) => Promise<unknown>;
interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

beforeEach(async () => {
  process.env.AWS_REGION = 'eu-north-1';
  process.env.BEARER_SECRET_ARN =
    'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/linkedin-webhook-bearer';
  process.env.HMAC_SECRET_ARN =
    'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/linkedin-webhook-hmac';

  ebSend.mockClear();
  ebPutCtor.mockClear();
  smSend.mockReset();
  // Two GetSecretValue calls: bearer first, then hmac (the handler issues both
  // in a Promise.all — cache only the first set of return values).
  smSend.mockImplementation(async (cmd: { input: { SecretId: string } }) => {
    const id = cmd.input.SecretId;
    if (id.endsWith('linkedin-webhook-bearer')) {
      return { SecretString: TEST_BEARER };
    }
    if (id.endsWith('linkedin-webhook-hmac')) {
      return { SecretString: TEST_HMAC };
    }
    throw new Error(`unexpected secret id: ${id}`);
  });
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

describe('linkedin-webhook handler', () => {
  it('valid signed request → 200 + PutEvents on kos.capture', async () => {
    const sig = sign(VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const respBody = JSON.parse(res.body) as {
      capture_id: string;
      status: string;
    };
    expect(respBody.status).toBe('accepted');
    expect(respBody.capture_id).toBe(VALID_DETAIL.capture_id);

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
    expect(detail.kind).toBe('linkedin_dm');
    expect(detail.channel).toBe('linkedin');
    expect(detail.capture_id).toBe(VALID_DETAIL.capture_id);
    expect(detail.message_urn).toBe(VALID_DETAIL.message_urn);
  });

  it('tagTraceWithCaptureId is invoked with capture_id', async () => {
    const sig = sign(VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    );
    expect(tagSpy).toHaveBeenCalledWith(VALID_DETAIL.capture_id);
    expect(initSentrySpy).toHaveBeenCalled();
  });

  it('missing Authorization header → 401, no PutEvents', async () => {
    const sig = sign(VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${NOW},v1=${sig}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401, no PutEvents', async () => {
    const sig = sign(VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: 'Bearer not-the-real-token',
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('missing X-KOS-Signature → 400 missing', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { authorization: `Bearer ${TEST_BEARER}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('drift > 300s → 401, no PutEvents', async () => {
    const past = NOW - 600;
    const sig = sign(VALID_BODY, past);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${past},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('tampered v1 (signature mismatch) → 401, no PutEvents', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${'0'.repeat(64)}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('invalid JSON body → 400 invalid_json', async () => {
    const garbage = 'this-is-not-json';
    const sig = sign(garbage, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: garbage,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('body fails Zod parse (no message_urn) → 400 schema', async () => {
    const broken = JSON.stringify({ ...VALID_DETAIL, message_urn: undefined });
    const sig = sign(broken, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: broken,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('schema');
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('capture_id not a ULID → 400 schema', async () => {
    const broken = JSON.stringify({
      ...VALID_DETAIL,
      capture_id: 'not-a-ulid',
    });
    const sig = sign(broken, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: broken,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('schema');
  });

  it('non-POST method → 405', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, method: 'GET' }),
    )) as Resp;
    expect(res.statusCode).toBe(405);
  });

  it('unknown path → 404', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, path: '/something-else' }),
    )) as Resp;
    expect(res.statusCode).toBe(404);
  });

  it('empty body → 400 empty_body', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ headers: { authorization: `Bearer ${TEST_BEARER}` } }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('empty_body');
  });

  it('handler overwrites received_at with the server clock', async () => {
    const sig = sign(VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: {
          authorization: `Bearer ${TEST_BEARER}`,
          'x-kos-signature': `t=${NOW},v1=${sig}`,
        },
      }),
    );
    const detailJson = (
      ebSend.mock.calls[0]![0] as {
        input: { Entries: { Detail: string }[] };
      }
    ).input.Entries[0]!.Detail;
    const detail = JSON.parse(detailJson) as { received_at: string };
    expect(detail.received_at).toBe(new Date(NOW * 1000).toISOString());
  });
});
