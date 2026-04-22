/**
 * push-telegram handler tests — Plan 02-06 extension.
 *
 * Phase 1 contract was: `{ body }` only, console.log stub sender, cap +
 * quiet-hours inline. Plan 02-06 extends the handler with:
 *
 *  1. `is_reply` bypass for Kevin-initiated synchronous replies — these
 *     skip BOTH the cap and the quiet-hours gate and go straight to the
 *     Telegram Bot API sender. This realizes the §13 / Pitfall 6 contract
 *     (voice-capture's `✅ Saved to Command Center · …` ack MUST get through
 *     at 22:30).
 *
 *  2. Real Telegram Bot API sender — the Phase 1 console.log stub is
 *     replaced by a `POST https://api.telegram.org/bot{token}/sendMessage`
 *     call. Token fetched via Secrets Manager (module-cache per Pitfall 11).
 *
 *  3. EventBridge unwrap — this Lambda is now an EB target on the
 *     `kos.output` bus; the handler accepts both the direct-invoke shape
 *     (`{body, ...}`) and the EB-wrapped shape (`{source, detail-type, detail}`)
 *     so it stays testable without EB event mocks AND works as an EB target.
 *
 *  4. Send-failed queue path — on Bot API 4xx/5xx the body is queued to
 *     `telegram_inbox_queue` with `reason='send-failed'` + re-throw so the
 *     EB rule retries (bounded by DLQ).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch for Telegram Bot API calls.
const fetchMock = vi.fn();
(globalThis as { fetch?: unknown }).fetch = fetchMock;

// Secrets Manager — both the RDS pool path AND the telegram bot-token path
// use it. The RDS path parses SecretString as JSON (`{username, password}`);
// the bot-token path uses SecretString verbatim. We return the RDS JSON by
// default; the bot-token module caches on first successful fetch.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async (cmd: { input: { SecretId: string } }) => {
      const id = cmd.input.SecretId ?? '';
      if (id.includes('token')) {
        return { SecretString: '123456:fake-bot-token' };
      }
      return { SecretString: JSON.stringify({ username: 'u', password: 'p' }) };
    }),
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// @kos/db table reference (the drizzle side is fully mocked below).
vi.mock('@kos/db', () => ({ telegramInboxQueue: 'telegram_inbox_queue' }));

// drizzle insert chain — record the invocation so we can assert the reason
// column on queue writes.
const drizzleInsertValues = vi.fn().mockResolvedValue({});
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({
    insert: () => ({ values: drizzleInsertValues }),
  }),
}));
vi.mock('pg', () => ({ default: { Pool: vi.fn().mockImplementation(() => ({})) } }));

// Sentry wrapHandler is identity for tests; init is a no-op.
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: (h: unknown) => h,
}));

// Cap module — we control `allowed` per test and observe `isReply` so we can
// prove the handler forwards the flag to the cap gate.
const capState = {
  allowed: true as boolean,
  reason: undefined as 'quiet-hours' | 'cap-exceeded' | undefined,
  observedIsReply: undefined as boolean | undefined,
};
vi.mock('../src/cap.js', () => ({
  enforceAndIncrement: vi.fn(async (deps: { isReply?: boolean }) => {
    capState.observedIsReply = deps.isReply;
    // The production cap.ts short-circuits is_reply BEFORE touching DDB, but
    // for handler-level tests we only care that the handler doesn't queue
    // when `allowed=true` comes back.
    if (deps.isReply) return { allowed: true };
    return capState.allowed
      ? { allowed: true, count: 1 }
      : { allowed: false, reason: capState.reason };
  }),
}));

// Sentry's wrapHandler types its return as Lambda's full (event, context, callback)
// signature, but we only invoke the single-event path in tests (Sentry's mock
// is identity). Cast the imported handler to a single-arg async function so
// tsc accepts our direct calls without forcing `never` at every site.
type TestHandler = (event: unknown) => Promise<{
  sent: boolean;
  queued: boolean;
  reason?: string;
}>;

async function loadHandler(): Promise<TestHandler> {
  const mod = (await import('../src/handler.js')) as { handler: unknown };
  return mod.handler as TestHandler;
}

describe('push-telegram handler (Plan 02-06)', () => {
  beforeEach(() => {
    vi.resetModules(); // module-scope bot-token cache must reset per test
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    drizzleInsertValues.mockClear();
    process.env.CAP_TABLE_NAME = 'kos-telegram-cap';
    process.env.RDS_SECRET_ARN = 'arn:aws:secretsmanager:eu-north-1:111:secret:rds';
    process.env.RDS_ENDPOINT = 'proxy.rds.local';
    process.env.TELEGRAM_BOT_TOKEN_SECRET_ARN =
      'arn:aws:secretsmanager:eu-north-1:111:secret:token';
    capState.allowed = true;
    capState.reason = undefined;
    capState.observedIsReply = undefined;
  });

  it('is_reply=true at quiet hours → bypasses cap + sends via Bot API (sendMessage + reply_parameters)', async () => {
    // Cap WOULD deny without the is_reply bypass. The handler must forward
    // isReply=true to the cap so the cap short-circuits allowed=true.
    capState.allowed = false;
    capState.reason = 'quiet-hours';
    const handler = await loadHandler();
    const res = await handler({
      body: '✅ Saved to Command Center · Ping Damien',
      is_reply: true,
      telegram: { chat_id: 111, reply_to_message_id: 5 },
      capture_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
    });
    expect(res).toEqual({ sent: true, queued: false });
    expect(capState.observedIsReply).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call![0])).toContain('api.telegram.org/bot');
    expect(String(call![0])).toContain('/sendMessage');
    const init = call![1] as { method: string; body: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toContain('application/json');
    const body = JSON.parse(init.body) as {
      chat_id: number;
      text: string;
      reply_parameters?: { message_id: number };
    };
    expect(body.chat_id).toBe(111);
    expect(body.text).toContain('✅ Saved to Command Center');
    expect(body.reply_parameters?.message_id).toBe(5);
    // Crucially: no queue write on the bypass path.
    expect(drizzleInsertValues).not.toHaveBeenCalled();
  });

  it('is_reply=false + quiet hours → queued with reason=quiet-hours, NOT sent', async () => {
    capState.allowed = false;
    capState.reason = 'quiet-hours';
    const handler = await loadHandler();
    const res = await handler({
      body: 'morning brief',
      telegram: { chat_id: 111 },
    });
    expect(res).toEqual({ sent: false, queued: true, reason: 'quiet-hours' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(drizzleInsertValues).toHaveBeenCalledTimes(1);
    expect(drizzleInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'quiet-hours' }),
    );
  });

  it('is_reply=false + cap-exceeded → queued with reason=cap-exceeded, NOT sent', async () => {
    capState.allowed = false;
    capState.reason = 'cap-exceeded';
    const handler = await loadHandler();
    const res = await handler({
      body: 'extra brief',
      telegram: { chat_id: 111 },
    });
    expect(res).toEqual({ sent: false, queued: true, reason: 'cap-exceeded' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(drizzleInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'cap-exceeded' }),
    );
  });

  it('is_reply=true without telegram.chat_id → throws (programming error)', async () => {
    const handler = await loadHandler();
    await expect(
      handler({ body: 'x', is_reply: true }),
    ).rejects.toThrow(/chat_id/);
    // Sender never invoked; nothing queued.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(drizzleInsertValues).not.toHaveBeenCalled();
  });

  it('unwraps EventBridge detail wrapper ({source, detail-type, detail})', async () => {
    const handler = await loadHandler();
    const res = await handler({
      source: 'kos.output',
      'detail-type': 'output.push',
      detail: {
        body: '✅ test',
        is_reply: true,
        telegram: { chat_id: 222, reply_to_message_id: 9 },
      },
    });
    expect(res.sent).toBe(true);
    expect(res.queued).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as { body: string };
    const parsed = JSON.parse(init.body) as { chat_id: number };
    expect(parsed.chat_id).toBe(222);
  });

  it('allowed=true normal path → Bot API sends without reply_parameters', async () => {
    const handler = await loadHandler();
    const res = await handler({
      body: 'ok',
      telegram: { chat_id: 111 },
    });
    expect(res).toEqual({ sent: true, queued: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as { body: string };
    const parsed = JSON.parse(init.body) as {
      chat_id: number;
      text: string;
      reply_parameters?: unknown;
    };
    expect(parsed.chat_id).toBe(111);
    expect(parsed.text).toBe('ok');
    expect(parsed.reply_parameters).toBeUndefined();
  });

  it('Bot API 5xx → queues with reason=send-failed and re-throws', async () => {
    fetchMock.mockReset().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, description: 'bad gateway' }),
    });
    const handler = await loadHandler();
    await expect(
      handler({ body: 'retry-me', telegram: { chat_id: 111 } }),
    ).rejects.toThrow(/telegram/i);
    expect(drizzleInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'send-failed' }),
    );
  });
});
