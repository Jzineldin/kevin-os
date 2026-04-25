/**
 * Handler tests for the iOS webhook (CAP-02).
 *
 * Mocks: S3, EventBridge, Secrets Manager (via secrets.ts), DynamoDB
 * (via replay.ts). Sentry + tracing helpers are stubbed to no-ops so the
 * tests don't talk to Sentry/Langfuse over the network.
 *
 * Each test pins `Date.now()` to the fixture's NOW so the HMAC drift check
 * passes deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signIosShortcutBody } from '@kos/test-fixtures';

// --- AWS SDK mocks --------------------------------------------------------

const s3Send = vi.fn().mockResolvedValue({});
const s3PutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  PutObjectCommand: s3PutCtor,
}));

const ebSend = vi.fn().mockResolvedValue({});
const ebPutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: ebPutCtor,
}));

const ddbSend = vi.fn();
class ConditionalCheckFailedException extends Error {
  $fault = 'client' as const;
  $metadata = {};
  constructor(message = 'conditional check failed') {
    super(message);
    this.name = 'ConditionalCheckFailedException';
  }
}
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  PutItemCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
  ConditionalCheckFailedException,
}));

// Secrets Manager — return our test secret directly. The handler calls
// getWebhookSecret() once per cold start and caches; we reset module state
// between tests via `__resetSecretsForTests`.
const TEST_SECRET = 'test-secret-not-for-production-use';
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

// --- Fixture data ---------------------------------------------------------

const NOW = 1714028400; // 2026-04-25T07:00:00Z
const VALID_BODY = JSON.stringify({
  timestamp: NOW,
  audio_base64: Buffer.from('fake-m4a-payload').toString('base64'),
  mime_type: 'audio/m4a',
});

function fnUrlEvent(opts: {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  isBase64Encoded?: boolean;
}) {
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

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;

interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

describe('ios-webhook handler', () => {
  beforeEach(async () => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.WEBHOOK_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/ios-shortcut-webhook-secret';
    process.env.REPLAY_TABLE_NAME = 'kos-ios-webhook-replay';
    process.env.BLOBS_BUCKET = 'kos-blobs-test';
    s3Send.mockClear();
    s3PutCtor.mockClear();
    ebSend.mockClear();
    ebPutCtor.mockClear();
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    smSend.mockClear();
    initSentrySpy.mockClear();
    tagSpy.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.resetModules();
    // reset secrets cache between tests so each cold-start state is clean.
    const sec = await import('../src/secrets.js');
    sec.__resetSecretsForTests();
    const rep = await import('../src/replay.js');
    rep.__resetReplayForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('valid signed request → 200 + S3 PutObject(audio/<ulid>.m4a) + EventBridge emit', async () => {
    const sig = signIosShortcutBody(TEST_SECRET, VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${NOW},v1=${sig}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const respBody = JSON.parse(res.body) as {
      capture_id: string;
      status: string;
    };
    expect(respBody.status).toBe('accepted');
    expect(respBody.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // S3 put
    expect(s3Send).toHaveBeenCalledTimes(1);
    const putArg = s3Send.mock.calls[0]![0] as {
      input: {
        Bucket: string;
        Key: string;
        Body: Buffer;
        ContentType: string;
        Metadata: Record<string, string>;
      };
    };
    expect(putArg.input.Bucket).toBe('kos-blobs-test');
    expect(putArg.input.Key).toBe(`audio/${respBody.capture_id}.m4a`);
    expect(putArg.input.ContentType).toBe('audio/m4a');
    expect(putArg.input.Metadata.capture_id).toBe(respBody.capture_id);
    expect(putArg.input.Metadata.channel).toBe('ios-shortcut');
  });

  it('valid request → PutEvents on kos.capture with detail matching CaptureReceivedIosSchema', async () => {
    const sig = signIosShortcutBody(TEST_SECRET, VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${NOW},v1=${sig}` },
      }),
    );
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
    const detail = JSON.parse(entry.Detail) as {
      kind: string;
      channel: string;
      capture_id: string;
      raw_ref: { s3_bucket: string; s3_key: string; mime_type: string };
      ios: { signature_timestamp: string };
    };
    expect(detail.kind).toBe('voice');
    expect(detail.channel).toBe('ios-shortcut');
    expect(detail.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(detail.raw_ref.mime_type).toBe('audio/m4a');
    expect(detail.ios.signature_timestamp).toBe(String(NOW));
  });

  it('invalid signature → 401, no S3 put, no EventBridge emit', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${NOW},v1=${'0'.repeat(64)}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(s3Send).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
    // Replay cache untouched on invalid signature.
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it('replay (DDB conditional fail) → 409, no S3 put, no EB emit', async () => {
    ddbSend.mockRejectedValueOnce(new ConditionalCheckFailedException());
    const sig = signIosShortcutBody(TEST_SECRET, VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${NOW},v1=${sig}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(409);
    expect(s3Send).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('timestamp drift > 300s → 401, replay cache untouched', async () => {
    const past = NOW - 3600;
    const sig = signIosShortcutBody(TEST_SECRET, VALID_BODY, past);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${past},v1=${sig}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('missing body → 400', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        headers: { 'x-kos-signature': `t=${NOW},v1=${'a'.repeat(64)}` },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('empty_body');
  });

  it('missing signature header → 400 reason=missing', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing');
  });

  it('non-POST method → 405', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body: VALID_BODY, method: 'GET' }),
    )) as Resp;
    expect(res.statusCode).toBe(405);
  });

  it('capture_id is a ULID and tagTraceWithCaptureId is invoked with it', async () => {
    const sig = signIosShortcutBody(TEST_SECRET, VALID_BODY, NOW);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: VALID_BODY,
        headers: { 'x-kos-signature': `t=${NOW},v1=${sig}` },
      }),
    )) as Resp;
    const { capture_id } = JSON.parse(res.body) as { capture_id: string };
    expect(capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(tagSpy).toHaveBeenCalledWith(capture_id);
    expect(initSentrySpy).toHaveBeenCalled();
  });
});
