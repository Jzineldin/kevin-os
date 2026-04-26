/**
 * Integrations-health handler contract test (Phase 11 Plan 11-06).
 *
 * The /integrations/health endpoint aggregates per-channel last-success
 * timestamps from the agent_runs table. agent_name granularity verified
 * in Wave 0 schema verification: telegram-bot, gmail-poller, granola-poller,
 * calendar-reader, linkedin-webhook, chrome-webhook, morning-brief,
 * day-close, weekly-review.
 *
 * Channel-status classification:
 *   - healthy   if age <= max_age_min
 *   - degraded  if max_age_min < age <= 2× max_age_min
 *   - down      if age > 2× max_age_min   OR last_ok_at IS NULL
 *
 * Mocks db.execute via vi.hoisted + vi.mock('../src/db.js'), mirroring
 * email-drafts.test.ts and seed-pollution-handler.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IntegrationsHealthResponseSchema,
} from '@kos/contracts/dashboard';

const { dbExecuteMock } = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })),
}));

vi.mock('../src/db.js', () => ({
  getDb: async () => ({
    execute: dbExecuteMock,
    transaction: async (
      fn: (tx: { execute: typeof dbExecuteMock }) => Promise<unknown>,
    ) => fn({ execute: dbExecuteMock }),
  }),
  __setDbForTest: () => {},
}));

function emptyCtx() {
  return {
    method: 'GET' as const,
    path: '/integrations/health',
    params: {},
    query: {},
    body: null,
    headers: {},
  };
}

describe('integrations-health handler (Phase 11 Plan 11-06)', () => {
  beforeEach(() => {
    dbExecuteMock.mockReset();
  });

  it('Test 1: returns 6 channels + 6 schedulers with valid schema when DB is empty', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(() => IntegrationsHealthResponseSchema.parse(body)).not.toThrow();
    expect(body.channels).toHaveLength(6);
    expect(body.schedulers).toHaveLength(6);
  });

  it('Test 2: a channel with no agent_runs row returns status=down with last_event_at=null', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    const body = JSON.parse(res.body);
    const gmail = body.channels.find(
      (c: { name: string }) => c.name === 'Gmail',
    );
    expect(gmail).toBeDefined();
    expect(gmail.status).toBe('down');
    expect(gmail.last_event_at).toBeNull();
  });

  it('Test 3: a channel with recent last_ok returns status=healthy', async () => {
    const recent = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 min ago
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          agent_name: 'gmail-poller',
          last_ok: recent,
          last_any: recent,
          last_status: 'ok',
        },
      ],
    });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    const body = JSON.parse(res.body);
    const gmail = body.channels.find(
      (c: { name: string }) => c.name === 'Gmail',
    );
    expect(gmail.status).toBe('healthy');
    expect(gmail.last_event_at).toBe(recent);
  });

  it('Test 4: a channel with last_ok older than 2× max_age returns status=down', async () => {
    // Gmail max_age_min = 30; 7 days ago is well past 60 min.
    const veryOld = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          agent_name: 'gmail-poller',
          last_ok: veryOld,
          last_any: veryOld,
          last_status: 'ok',
        },
      ],
    });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    const body = JSON.parse(res.body);
    const gmail = body.channels.find(
      (c: { name: string }) => c.name === 'Gmail',
    );
    expect(gmail.status).toBe('down');
    expect(gmail.last_event_at).toBe(veryOld);
  });

  it('Test 5: a channel between 1× and 2× max_age returns status=degraded', async () => {
    // Gmail max_age_min = 30; 45 minutes ago is in degraded band.
    const middling = new Date(Date.now() - 45 * 60_000).toISOString();
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          agent_name: 'gmail-poller',
          last_ok: middling,
          last_any: middling,
          last_status: 'ok',
        },
      ],
    });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    const body = JSON.parse(res.body);
    const gmail = body.channels.find(
      (c: { name: string }) => c.name === 'Gmail',
    );
    expect(gmail.status).toBe('degraded');
  });

  it('Test 6: schedulers list contains morning-brief, day-close, weekly-review with last_run_at + last_status', async () => {
    const someTime = new Date(Date.now() - 60 * 60_000).toISOString();
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          agent_name: 'morning-brief',
          last_ok: someTime,
          last_any: someTime,
          last_status: 'ok',
        },
        {
          agent_name: 'day-close',
          last_ok: null,
          last_any: someTime,
          last_status: 'fail',
        },
      ],
    });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    const body = JSON.parse(res.body);
    const morning = body.schedulers.find(
      (s: { name: string }) => s.name === 'morning-brief',
    );
    expect(morning).toBeDefined();
    expect(morning.last_run_at).toBe(someTime);
    expect(morning.last_status).toBe('ok');
    expect(morning.next_run_at).toBeNull();

    const dayClose = body.schedulers.find(
      (s: { name: string }) => s.name === 'day-close',
    );
    expect(dayClose.last_status).toBe('fail');

    const weekly = body.schedulers.find(
      (s: { name: string }) => s.name === 'weekly-review',
    );
    expect(weekly).toBeDefined();
    expect(weekly.last_run_at).toBeNull();
    expect(weekly.last_status).toBeNull();
  });

  it('Test 7: response includes cache-control SWR=60 header', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    const res = await integrationsHealthHandler(emptyCtx());
    expect(res.headers?.['cache-control']).toMatch(/stale-while-revalidate=60/);
  });

  it('Test 8: IntegrationsHealthResponseSchema parses { channels: [], schedulers: [] }', () => {
    const empty = { channels: [], schedulers: [] };
    expect(() => IntegrationsHealthResponseSchema.parse(empty)).not.toThrow();
  });

  it('Test 9: SQL query is owner_id-scoped (raw substring assertion)', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    const { integrationsHealthHandler } = await import(
      '../src/handlers/integrations.js'
    );
    await integrationsHealthHandler(emptyCtx());
    // Inspect the recorded query — Drizzle's sql template object exposes
    // a `.queryChunks` field, but in mocks we receive an object whose
    // string-form contains the literal `owner_id` filter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (dbExecuteMock.mock as any).calls as unknown[][];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const arg = calls[0]?.[0];
    const text = JSON.stringify(arg ?? {});
    expect(text).toContain('owner_id');
    expect(text).toContain('agent_runs');
  });
});
