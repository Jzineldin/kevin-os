import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTelegramTextUpdate } from '@kos/test-fixtures';

// EventBridge mock — we assert against mockSend calls to confirm PutEvents.
const mockSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

// S3 mock — no-op.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
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
