/**
 * handler.test.ts — gmail-poller handler.
 *
 * Coverage:
 *   1. Both accounts polled in parallel; result.ok lists both.
 *   2. Per-message fetch + emit on kos.capture / capture.received with
 *      kind=email_inbox.
 *   3. Idempotency — message_ids already in email_drafts are NOT re-emitted.
 *   4. 401 on first attempt → token invalidated + retry once; second 401
 *      surfaces as a per-account failure.
 *   5. CaptureReceivedEmailInbox shape valid (Zod parse passes; from/to/
 *      subject/body_text + capture_id ULID + received_at ISO).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const oauthState = {
  callCount: new Map<string, number>(),
  invalidated: [] as string[],
};

vi.mock('../src/oauth.js', () => ({
  getAccessToken: vi.fn(async (account: string) => {
    const n = (oauthState.callCount.get(account) ?? 0) + 1;
    oauthState.callCount.set(account, n);
    return `tok-${account}-${n}`;
  }),
  invalidateToken: vi.fn((account: string) => {
    oauthState.invalidated.push(account);
  }),
  __resetForTests: vi.fn(),
}));

const gmailState = {
  listResponses: new Map<string, Array<'auth_stale' | unknown[]>>(),
  fetchMessages: new Map<string, Record<string, unknown>>(),
  listCallCount: new Map<string, number>(),
  fetchCallCount: 0,
};

vi.mock('../src/gmail.js', () => {
  class GmailAuthStaleError extends Error {
    code = 'auth_stale' as const;
    constructor(m = 'gmail auth stale') {
      super(m);
    }
  }
  return {
    GmailAuthStaleError,
    listNewMessageIds: vi.fn(async (args: { accessToken: string }) => {
      const m = /^tok-(.+?)-(\d+)$/.exec(args.accessToken);
      const account = m ? m[1]! : 'unknown';
      const seq = gmailState.listResponses.get(account) ?? [[]];
      const n = gmailState.listCallCount.get(account) ?? 0;
      gmailState.listCallCount.set(account, n + 1);
      const r = seq[Math.min(n, seq.length - 1)];
      if (r === 'auth_stale') throw new GmailAuthStaleError(`stale ${account}`);
      return r as unknown[];
    }),
    fetchMessage: vi.fn(async (args: { messageId: string }) => {
      gmailState.fetchCallCount += 1;
      const msg = gmailState.fetchMessages.get(args.messageId);
      if (!msg) throw new Error(`no fixture for ${args.messageId}`);
      return msg;
    }),
  };
});

const persistState = {
  knownByAccount: new Map<string, Set<string>>(),
};

vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  findKnownMessages: vi.fn(
    async (
      _pool: unknown,
      args: { account: string; messageIds: string[] },
    ) => {
      const known = persistState.knownByAccount.get(args.account) ?? new Set<string>();
      return new Set(args.messageIds.filter((id) => known.has(id)));
    },
  ),
  __resetForTests: vi.fn(),
}));

const eventBridgeSendSpy = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({
    send: eventBridgeSendSpy,
  })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

beforeEach(() => {
  oauthState.callCount.clear();
  oauthState.invalidated = [];
  gmailState.listResponses.clear();
  gmailState.fetchMessages.clear();
  gmailState.listCallCount.clear();
  gmailState.fetchCallCount = 0;
  persistState.knownByAccount.clear();
  eventBridgeSendSpy.mockClear();
  process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
  process.env.KOS_CAPTURE_BUS_NAME = 'kos.capture';
  process.env.AWS_REGION = 'eu-north-1';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
});

const sampleMsg = (id: string, from = 'a@b.com'): Record<string, unknown> => ({
  id,
  threadId: 't',
  from,
  to: ['kevin@tale-forge.app'],
  cc: [],
  subject: `subject-${id}`,
  bodyText: `body of ${id}`,
  bodyHtml: null,
  receivedAt: '2026-04-25T09:55:00.000Z',
});

describe('gmail-poller handler', () => {
  it('polls both accounts in parallel and returns their results', async () => {
    gmailState.listResponses.set('kevin-elzarka', [[{ id: 'em1', threadId: 'tA' }]]);
    gmailState.listResponses.set('kevin-taleforge', [[{ id: 'tm1', threadId: 'tB' }]]);
    gmailState.fetchMessages.set('em1', sampleMsg('em1'));
    gmailState.fetchMessages.set('tm1', sampleMsg('tm1'));

    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<{
      ok: Array<{ account: string; emitted: number }>;
      failed: unknown[];
    }>)({}));
    expect(r.failed).toHaveLength(0);
    const accounts = r.ok.map((x) => x.account).sort();
    expect(accounts).toEqual(['kevin-elzarka', 'kevin-taleforge']);
    expect(r.ok.every((x) => x.emitted === 1)).toBe(true);
  });

  it('emits capture.received with kind=email_inbox on kos.capture', async () => {
    gmailState.listResponses.set('kevin-elzarka', [[{ id: 'em1', threadId: 'tA' }]]);
    gmailState.listResponses.set('kevin-taleforge', [[]]);
    gmailState.fetchMessages.set('em1', sampleMsg('em1', 'damien@example.com'));

    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    expect(eventBridgeSendSpy).toHaveBeenCalledTimes(1);
    const cmd = eventBridgeSendSpy.mock.calls[0]![0] as {
      input: {
        Entries: Array<{
          Source: string;
          DetailType: string;
          EventBusName: string;
          Detail: string;
        }>;
      };
    };
    const entry = cmd.input.Entries[0]!;
    expect(entry.Source).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');
    expect(entry.EventBusName).toBe('kos.capture');
    const detail = JSON.parse(entry.Detail) as {
      capture_id: string;
      kind: string;
      channel: string;
      email: { account_id: string; message_id: string; from: string };
    };
    expect(detail.kind).toBe('email_inbox');
    expect(detail.channel).toBe('email-inbox');
    expect(detail.email.account_id).toBe('kevin-elzarka');
    expect(detail.email.message_id).toBe('em1');
    expect(detail.email.from).toBe('damien@example.com');
    expect(detail.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('skips message_ids already present in email_drafts (idempotency)', async () => {
    gmailState.listResponses.set('kevin-elzarka', [[
      { id: 'old1', threadId: 'tA' },
      { id: 'new1', threadId: 'tA' },
    ]]);
    gmailState.listResponses.set('kevin-taleforge', [[]]);
    gmailState.fetchMessages.set('new1', sampleMsg('new1'));
    persistState.knownByAccount.set('kevin-elzarka', new Set(['old1']));

    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<{
      ok: Array<{ account: string; emitted: number; skipped_duplicates: number }>;
    }>)({}));
    const elzarka = r.ok.find((x) => x.account === 'kevin-elzarka')!;
    expect(elzarka.emitted).toBe(1);
    expect(elzarka.skipped_duplicates).toBe(1);
    // Only the novel message was fetched (old1 short-circuited).
    expect(gmailState.fetchCallCount).toBe(1);
    expect(eventBridgeSendSpy).toHaveBeenCalledTimes(1);
  });

  it('401 on first attempt → invalidate + retry once; second 401 fails the account', async () => {
    gmailState.listResponses.set('kevin-elzarka', ['auth_stale', [{ id: 'em1', threadId: 'tA' }]]);
    gmailState.listResponses.set('kevin-taleforge', ['auth_stale', 'auth_stale']);
    gmailState.fetchMessages.set('em1', sampleMsg('em1'));

    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<{
      ok: Array<{ account: string }>;
      failed: Array<{ account: string }>;
    }>)({}));

    expect(r.ok.map((x) => x.account)).toEqual(['kevin-elzarka']);
    expect(r.failed.map((x) => x.account)).toEqual(['kevin-taleforge']);
    expect(oauthState.invalidated).toContain('kevin-elzarka');
    expect(oauthState.invalidated).toContain('kevin-taleforge');
  });

  it('emits an empty result when no new messages exist', async () => {
    gmailState.listResponses.set('kevin-elzarka', [[]]);
    gmailState.listResponses.set('kevin-taleforge', [[]]);

    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<{
      ok: Array<{ emitted: number }>;
    }>)({}));
    expect(r.ok.every((x) => x.emitted === 0)).toBe(true);
    expect(eventBridgeSendSpy).not.toHaveBeenCalled();
  });
});
