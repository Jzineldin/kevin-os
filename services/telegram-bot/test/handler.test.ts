import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTelegramTextUpdate } from '@kos/test-fixtures';

// EventBridge mock — we assert against mockSend calls to confirm PutEvents.
const mockSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

// S3 mock — shared send so tests can inspect Put calls (audio + meta sidecar).
const s3Send = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  PutObjectCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

// Secrets Manager mock.
const TEST_SECRET = 'secret_token_test_value_longer_than_placeholder';
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: TEST_SECRET }),
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => x),
}));

// Sentry wrap is a pass-through in tests so we don't need a real DSN.
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

// grammY uses node-fetch internally for api.telegram.org calls (getMe,
// sendMessage, etc.). Mock it to return a canonical getMe response so
// Bot.init() succeeds without a real network call. sendMessage returns
// generic ok:true.
vi.mock('node-fetch', () => {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/getMe')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          ok: true,
          result: {
            id: 42,
            is_bot: true,
            first_name: 'kos-test-bot',
            username: 'kos_test_bot',
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          },
        }),
        text: async () =>
          '{"ok":true,"result":{"id":42,"is_bot":true,"first_name":"kos-test-bot","username":"kos_test_bot","can_join_groups":false,"can_read_all_group_messages":false,"supports_inline_queries":false}}',
        arrayBuffer: async () => new ArrayBuffer(16),
      };
    }
    if (u.includes('/getFile')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          ok: true,
          result: {
            file_id: 'voice-abc',
            file_unique_id: 'u1',
            file_size: 16,
            file_path: 'voice/file_1.oga',
          },
        }),
        text: async () =>
          '{"ok":true,"result":{"file_id":"voice-abc","file_unique_id":"u1","file_size":16,"file_path":"voice/file_1.oga"}}',
        arrayBuffer: async () => new ArrayBuffer(16),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ ok: true, result: { message_id: 1 } }),
      text: async () => '{"ok":true,"result":{"message_id":1}}',
      arrayBuffer: async () => new ArrayBuffer(16),
    };
  });
  return { default: fetchMock };
});

// Global fetch is also used by the handler for the file-download URL
// (https://api.telegram.org/file/bot{token}/{path}) — must return bytes.
vi.stubGlobal(
  'fetch',
  vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(64),
  })),
);

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;

describe('telegram-bot handler', () => {
  beforeEach(() => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.TELEGRAM_BOT_TOKEN_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/telegram-bot-token';
    process.env.TELEGRAM_WEBHOOK_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/telegram-webhook-secret';
    process.env.BLOBS_BUCKET = 'kos-blobs-test';
    process.env.KEVIN_TELEGRAM_USER_ID = '111222333';
    process.env.TELEGRAM_BOT_INFO_JSON = JSON.stringify({
      id: 42, is_bot: true, first_name: 'kos-test-bot',
      username: 'kos_test_bot', can_join_groups: false,
      can_read_all_group_messages: false, supports_inline_queries: false,
    });
    mockSend.mockClear();
    s3Send.mockClear();
    s3Send.mockResolvedValue({});
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid secret_token with 401', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler({
      headers: { 'x-telegram-bot-api-secret-token': 'WRONG' },
      body: '{}',
    })) as { statusCode: number };
    expect(res.statusCode).toBe(401);
  });

  it('drops non-Kevin user silently (no PutEvents)', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const upd = makeTelegramTextUpdate('hej', 999);
    await handler({
      headers: { 'x-telegram-bot-api-secret-token': TEST_SECRET },
      body: JSON.stringify(upd),
    });
    const putEventsCalls = mockSend.mock.calls.filter((c) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(putEventsCalls.length).toBe(0);
  });

  it('putVoiceMeta writes meta sidecar at audio/meta/<id>.json (Plan 02-02 bridge)', async () => {
    const mod = await import('../src/s3.js');
    await mod.putVoiceMeta('01HABCDEFGHJKMNPQRSTVWXYZ0', {
      raw_ref: {
        s3_bucket: 'kos-blobs-test',
        s3_key: 'audio/2026/04/01HABCDEFGHJKMNPQRSTVWXYZ0.oga',
        duration_sec: 8,
        mime_type: 'audio/ogg',
      },
      sender: { id: 111, display: 'Kevin' },
      received_at: new Date().toISOString(),
      telegram: { chat_id: 111, message_id: 1 },
    });
    const metaPut = s3Send.mock.calls.find((c) => {
      const k = (c[0] as { input?: { Key?: string } }).input?.Key;
      return typeof k === 'string' && k.startsWith('audio/meta/');
    });
    expect(metaPut).toBeDefined();
    const put = metaPut![0] as { input: { Key: string; Bucket: string; Body: string; ContentType: string } };
    expect(put.input.Key).toBe(
      'audio/meta/01HABCDEFGHJKMNPQRSTVWXYZ0.json',
    );
    expect(put.input.Bucket).toBe('kos-blobs-test');
    expect(put.input.ContentType).toBe('application/json');
    const body = JSON.parse(put.input.Body) as { telegram: { chat_id: number } };
    expect(body.telegram.chat_id).toBe(111);
  });

  it('handler module imports putVoiceMeta (Plan 02-02 wiring)', async () => {
    const handlerSrc = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../src/handler.ts', import.meta.url),
        'utf8',
      ),
    );
    expect(handlerSrc).toMatch(/putVoiceMeta/);
  });

  it('text message -> PutEvents with kind=text and ULID capture_id', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const upd = makeTelegramTextUpdate('Ping Damien', 111222333);
    await handler({
      headers: { 'x-telegram-bot-api-secret-token': TEST_SECRET },
      body: JSON.stringify(upd),
    });
    const putEventsCalls = mockSend.mock.calls.filter((c) =>
      JSON.stringify(c[0]).includes('capture.received'),
    );
    expect(putEventsCalls.length).toBeGreaterThanOrEqual(1);
    const firstCall = putEventsCalls[0];
    if (!firstCall) throw new Error('no PutEvents call recorded');
    const input = (firstCall[0] as { input: { Entries: { Detail: string; Source: string; DetailType: string; EventBusName: string }[] } }).input;
    const entry = input.Entries[0];
    if (!entry) throw new Error('no PutEvents entry');
    expect(entry.EventBusName).toBe('kos.capture');
    expect(entry.Source).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');
    const detail = JSON.parse(entry.Detail) as {
      kind: string;
      text: string;
      capture_id: string;
      channel: string;
    };
    expect(detail.kind).toBe('text');
    expect(detail.text).toBe('Ping Damien');
    expect(detail.channel).toBe('telegram');
    expect(detail.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
