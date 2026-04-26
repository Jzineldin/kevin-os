/**
 * Handler tests for emailengine-admin (CAP-07 / Plan 04-03).
 *
 * Mocks: Secrets Manager + global fetch. Sentry stubbed to no-op.
 *
 * Tests:
 *   1. register-account → fetch POST /v1/account; IMAP creds pulled from
 *      Secrets Manager (NOT from caller payload); EE response surfaced.
 *   2. unregister-account → fetch DELETE /v1/account/{id}; status surfaced.
 *   3. list-accounts → fetch GET /v1/accounts; status surfaced.
 *   4. Unknown command → 400 with reason.
 *   5. EmailEngine returns 4xx → status + body surfaced verbatim.
 *   6. register-account with PLACEHOLDER secret → 500 fail-closed.
 *   7. Caller-supplied IMAP creds in payload are IGNORED (zod schema rejects
 *      unknown fields via strict shape inference; secret is the only source).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TEST_API_KEY = 'ee-api-key-test';
const IMAP_SECRET = JSON.stringify({
  email: 'kevin.elzarka@gmail.com',
  app_password: 'aaaa-bbbb-cccc-dddd',
});

const smSend = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: smSend })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => x),
}));

const initSentrySpy = vi.fn(async () => {});
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: initSentrySpy,
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;
interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function fnUrlEvent(body: unknown) {
  return {
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe('emailengine-admin handler', () => {
  beforeEach(() => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.EE_REST_URL = 'http://emailengine.kos-internal.local:3000';
    process.env.EE_API_KEY_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/emailengine-api-key';
    smSend.mockReset();
    smSend.mockImplementation(async (cmd: { SecretId?: string }) => {
      if (cmd.SecretId === process.env.EE_API_KEY_SECRET_ARN) {
        return { SecretString: TEST_API_KEY };
      }
      // imap-* secrets default to a valid payload
      return { SecretString: IMAP_SECRET };
    });
    initSentrySpy.mockClear();
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('register-account → POST /v1/account with IMAP creds from Secrets Manager', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ account: 'kevin-elzarka', state: 'connecting' }),
    });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        command: 'register-account',
        account: 'kevin-elzarka',
        accountSecretArn:
          'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/emailengine-imap-kevin-elzarka',
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://emailengine.kos-internal.local:3000/v1/account');
    expect((init as { method: string }).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.account).toBe('kevin-elzarka');
    expect(body.imap.host).toBe('imap.gmail.com');
    expect(body.imap.port).toBe(993);
    expect(body.imap.secure).toBe(true);
    expect(body.imap.auth.user).toBe('kevin.elzarka@gmail.com');
    expect(body.imap.auth.pass).toBe('aaaa-bbbb-cccc-dddd');
    expect(body.smtp).toBe(false);
    expect(body.webhooks).toBe(true);
    // Authorization header carries the EE_API_KEY from Secrets Manager
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it('unregister-account → DELETE /v1/account/{id}', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ deleted: true }),
    });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ command: 'unregister-account', account: 'kevin-elzarka' }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://emailengine.kos-internal.local:3000/v1/account/kevin-elzarka');
    expect((init as { method: string }).method).toBe('DELETE');
  });

  it('list-accounts → GET /v1/accounts', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ accounts: [] }),
    });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(fnUrlEvent({ command: 'list-accounts' }))) as Resp;
    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://emailengine.kos-internal.local:3000/v1/accounts');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('unknown command → 400 with reason', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ command: 'reboot-imap-server' }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_command');
    expect(typeof body.reason).toBe('string');
  });

  it('EmailEngine 4xx → status + body surfaced verbatim', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      status: 422,
      text: async () => JSON.stringify({ error: 'IMAP authentication failed' }),
    });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        command: 'register-account',
        account: 'kevin-elzarka',
        accountSecretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:kos/emailengine-imap-x',
      }),
    )) as Resp;
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('IMAP authentication failed');
  });

  it('register-account with PLACEHOLDER imap secret → 500 fail-closed', async () => {
    smSend.mockReset();
    smSend.mockImplementation(async (cmd: { SecretId?: string }) => {
      if (cmd.SecretId === process.env.EE_API_KEY_SECRET_ARN) {
        return { SecretString: TEST_API_KEY };
      }
      return { SecretString: 'PLACEHOLDER' };
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ status: 200, text: async () => '{}' });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        command: 'register-account',
        account: 'kevin-elzarka',
        accountSecretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:kos/emailengine-imap-x',
      }),
    )) as Resp;
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('imap_secret_unset_or_placeholder');
    // No call to EmailEngine because we fail closed before fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caller-supplied IMAP creds in payload are ignored (only secret is consulted)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    // Caller tries to inject malicious IMAP creds via payload — they are
    // stripped by the discriminated union schema (extra fields ignored).
    await handler(
      fnUrlEvent({
        command: 'register-account',
        account: 'kevin-elzarka',
        accountSecretArn:
          'arn:aws:secretsmanager:eu-north-1:123:secret:kos/emailengine-imap-kevin-elzarka',
        imap: { host: 'evil.example.com', auth: { user: 'attacker', pass: 'pwn' } },
      }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.imap.host).toBe('imap.gmail.com');
    expect(body.imap.auth.user).toBe('kevin.elzarka@gmail.com');
  });
});
