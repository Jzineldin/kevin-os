/**
 * handler.test.ts — calendar-reader handler (Plan 08-01 Task 1).
 *
 * Behavioural coverage:
 *   1. Scheduler event → both accounts polled in parallel.
 *   2. Events upserted via persist.upsertCalendarEvents; counts surfaced.
 *   3. Fetch window = [now - 1h, now + 48h].
 *   4. 401 on first account → token invalidated + retry once; if 2nd attempt
 *      also 401, log + continue with the other account.
 *   5. Emits a `calendar.events.cached` event per successful account
 *      (kos.capture observability).
 *   6. Idempotency: repeated invocations within 1 min reuse the same UPSERT
 *      semantics — `unchanged` count carries the no-op outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks --- (declared BEFORE handler import for hoisting safety) -------

const oauthState = {
  // sequence: per call, what does getAccessToken yield?
  // Use throw-by-call by setting `throwOnCall` map.
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

const gcalState = {
  // Per-account list of "what fetchEventsWindow does on call N".
  // Each entry is either a list of GcalEvent rows, or a thrown auth_stale.
  responses: new Map<string, Array<'auth_stale' | 'error' | unknown[]>>(),
  callCount: new Map<string, number>(),
  receivedTokens: [] as string[],
  receivedWindows: [] as Array<{ timeMin: string; timeMax: string }>,
};

vi.mock('../src/gcal.js', () => {
  class GcalAuthStaleError extends Error {
    code = 'auth_stale' as const;
    constructor(m = 'gcal auth stale') {
      super(m);
    }
  }
  return {
    GcalAuthStaleError,
    fetchEventsWindow: vi.fn(
      async (args: { accessToken: string; timeMinIso: string; timeMaxIso: string }) => {
        gcalState.receivedTokens.push(args.accessToken);
        gcalState.receivedWindows.push({
          timeMin: args.timeMinIso,
          timeMax: args.timeMaxIso,
        });
        // Recover the per-account dispatch from the mocked token format:
        //   tok-<account>-<n>
        const m = /^tok-(.+?)-(\d+)$/.exec(args.accessToken);
        const account = m ? m[1]! : 'unknown';
        const seq = gcalState.responses.get(account) ?? [[]];
        const n = (gcalState.callCount.get(account) ?? 0);
        gcalState.callCount.set(account, n + 1);
        const r = seq[Math.min(n, seq.length - 1)];
        if (r === 'auth_stale') {
          throw new GcalAuthStaleError(`auth stale ${account}`);
        }
        if (r === 'error') {
          throw new Error('boom');
        }
        return r as unknown[];
      },
    ),
  };
});

const persistState = {
  upserted: [] as Array<{
    account: string;
    events: number;
    counts: { inserted: number; updated: number; unchanged: number };
  }>,
  // Default counts every test gets unless overridden.
  countsByAccount: new Map<
    string,
    { inserted: number; updated: number; unchanged: number }
  >(),
};

vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  upsertCalendarEvents: vi.fn(
    async (
      _pool: unknown,
      args: { account: string; events: unknown[]; calendarId: string },
    ) => {
      const counts = persistState.countsByAccount.get(args.account) ?? {
        inserted: args.events.length,
        updated: 0,
        unchanged: 0,
      };
      persistState.upserted.push({
        account: args.account,
        events: args.events.length,
        counts,
      });
      return counts;
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

const tagSpy = vi.fn();
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagSpy,
}));

// ---------------------------------------------------------------------------
beforeEach(() => {
  oauthState.callCount.clear();
  oauthState.invalidated = [];
  gcalState.responses.clear();
  gcalState.callCount.clear();
  gcalState.receivedTokens = [];
  gcalState.receivedWindows = [];
  persistState.upserted = [];
  persistState.countsByAccount.clear();
  eventBridgeSendSpy.mockClear();
  tagSpy.mockClear();
  process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
  process.env.KOS_CAPTURE_BUS_NAME = 'kos.capture';
  process.env.AWS_REGION = 'eu-north-1';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
});

// Shape conformant with what the real upsert expects.
const SAMPLE_EVENT_ELZARKA = {
  event_id: 'gcal-evt-001',
  summary: 'Damien sync',
  description: null,
  location: null,
  start_utc: '2026-04-25T11:00:00.000Z',
  end_utc: '2026-04-25T12:00:00.000Z',
  timezone: 'Europe/Stockholm',
  attendees: [],
  is_all_day: false,
  updated_at: '2026-04-20T09:00:00.000Z',
};
const SAMPLE_EVENT_TALEFORGE = {
  event_id: 'gcal-evt-tf-001',
  summary: 'Investor update',
  description: null,
  location: null,
  start_utc: '2026-04-25T15:00:00.000Z',
  end_utc: '2026-04-25T16:00:00.000Z',
  timezone: 'Europe/Stockholm',
  attendees: [],
  is_all_day: false,
  updated_at: '2026-04-20T09:00:00.000Z',
};

describe('calendar-reader handler', () => {
  it('polls both accounts in parallel and upserts the result', async () => {
    gcalState.responses.set('kevin-elzarka', [[SAMPLE_EVENT_ELZARKA]]);
    gcalState.responses.set('kevin-taleforge', [[SAMPLE_EVENT_TALEFORGE]]);

    const { handler } = await import('../src/handler.js');
    const result = await (
      handler as unknown as (e: unknown) => Promise<{
        ok: Array<{ account: string; events: number }>;
        failed: Array<unknown>;
      }>
    )({});

    expect(result.failed).toHaveLength(0);
    expect(result.ok).toHaveLength(2);
    const accounts = result.ok.map((r) => r.account).sort();
    expect(accounts).toEqual(['kevin-elzarka', 'kevin-taleforge']);
    expect(persistState.upserted).toHaveLength(2);
  });

  it('events upserted via persist.upsertCalendarEvents; counts surfaced', async () => {
    gcalState.responses.set('kevin-elzarka', [[SAMPLE_EVENT_ELZARKA]]);
    gcalState.responses.set('kevin-taleforge', [[SAMPLE_EVENT_TALEFORGE]]);
    persistState.countsByAccount.set('kevin-elzarka', {
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    persistState.countsByAccount.set('kevin-taleforge', {
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });

    const { handler } = await import('../src/handler.js');
    const result = await (
      handler as unknown as (e: unknown) => Promise<{
        ok: Array<{ account: string; events: number; inserted: number; updated: number }>;
      }>
    )({});

    const e = result.ok.find((r) => r.account === 'kevin-elzarka')!;
    const t = result.ok.find((r) => r.account === 'kevin-taleforge')!;
    expect(e.inserted).toBe(1);
    expect(e.updated).toBe(0);
    expect(t.inserted).toBe(0);
    expect(t.updated).toBe(1);
  });

  it('fetch window = [now - 1h, now + 48h] per RESEARCH P-3 / P-4', async () => {
    gcalState.responses.set('kevin-elzarka', [[]]);
    gcalState.responses.set('kevin-taleforge', [[]]);

    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    const expectedTimeMin = new Date('2026-04-25T09:00:00Z').toISOString();
    const expectedTimeMax = new Date('2026-04-27T10:00:00Z').toISOString();
    expect(gcalState.receivedWindows).toHaveLength(2);
    for (const w of gcalState.receivedWindows) {
      expect(w.timeMin).toBe(expectedTimeMin);
      expect(w.timeMax).toBe(expectedTimeMax);
    }
  });

  it('401 on first attempt → token invalidated + retry once; second 401 logs + continues other account', async () => {
    // kevin-elzarka returns auth_stale on call 1, succeeds on call 2.
    gcalState.responses.set('kevin-elzarka', ['auth_stale', [SAMPLE_EVENT_ELZARKA]]);
    // kevin-taleforge returns auth_stale on every call → fails after retry.
    gcalState.responses.set('kevin-taleforge', ['auth_stale', 'auth_stale']);

    const { handler } = await import('../src/handler.js');
    const result = await (
      handler as unknown as (e: unknown) => Promise<{
        ok: Array<{ account: string }>;
        failed: Array<{ account: string; reason: string }>;
      }>
    )({});

    // kevin-elzarka recovered after 1 retry.
    expect(result.ok.map((r) => r.account)).toEqual(['kevin-elzarka']);
    // kevin-taleforge gave up.
    expect(result.failed.map((r) => r.account)).toEqual(['kevin-taleforge']);
    // invalidateToken called once for each account that hit 401.
    expect(oauthState.invalidated).toContain('kevin-elzarka');
    expect(oauthState.invalidated).toContain('kevin-taleforge');
  });

  it('emits calendar.events.cached event per successful account on kos.capture', async () => {
    gcalState.responses.set('kevin-elzarka', [[SAMPLE_EVENT_ELZARKA]]);
    gcalState.responses.set('kevin-taleforge', [[SAMPLE_EVENT_TALEFORGE]]);

    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    expect(eventBridgeSendSpy).toHaveBeenCalledTimes(2);
    const seenDetailTypes = eventBridgeSendSpy.mock.calls.map((c) => {
      const cmd = c[0] as { input: { Entries: Array<{ DetailType: string; Source: string; EventBusName: string; Detail: string }> } };
      return cmd.input.Entries[0]!;
    });
    for (const entry of seenDetailTypes) {
      expect(entry.DetailType).toBe('calendar.events.cached');
      expect(entry.Source).toBe('kos.capture');
      expect(entry.EventBusName).toBe('kos.capture');
      const detail = JSON.parse(entry.Detail) as {
        account: string;
        events_count: number;
        window_start_utc: string;
        window_end_utc: string;
      };
      expect(detail.events_count).toBe(1);
      expect(detail.window_start_utc).toBeDefined();
      expect(detail.window_end_utc).toBeDefined();
    }
  });

  it('idempotency: repeated invocation passes upsert (unchanged count carries the no-op)', async () => {
    gcalState.responses.set('kevin-elzarka', [[SAMPLE_EVENT_ELZARKA], [SAMPLE_EVENT_ELZARKA]]);
    gcalState.responses.set('kevin-taleforge', [[], []]);

    // First invocation: 1 inserted.
    persistState.countsByAccount.set('kevin-elzarka', {
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    const { handler } = await import('../src/handler.js');
    const r1 = await (
      handler as unknown as (e: unknown) => Promise<{ ok: Array<{ account: string; inserted: number; unchanged: number }> }>
    )({});
    expect(r1.ok.find((r) => r.account === 'kevin-elzarka')!.inserted).toBe(1);

    // Second invocation moments later: 0 inserted, 1 unchanged (same row).
    persistState.countsByAccount.set('kevin-elzarka', {
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    vi.setSystemTime(new Date('2026-04-25T10:00:30Z'));
    const r2 = await (
      handler as unknown as (e: unknown) => Promise<{ ok: Array<{ account: string; inserted: number; unchanged: number }> }>
    )({});
    const e2 = r2.ok.find((r) => r.account === 'kevin-elzarka')!;
    expect(e2.inserted).toBe(0);
    expect(e2.unchanged).toBe(1);
  });
});
