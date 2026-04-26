/**
 * Handler-integration test for the Phase 11 Plan 11-01 seed-pollution
 * gate.
 *
 * Replaces the originally-planned `verify-startup-guard.mjs` script (and
 * its `globalThis.__KOS_DB_EXEC_OVERRIDE__` hatch in production db.ts)
 * with a pure Vitest run that exercises the full Lambda handler entry
 * path: verifyBearer → assertNoSeedPollution → route(event).
 *
 * Production `services/dashboard-api/src/db.ts` is NEVER modified — we
 * mock the module at the import boundary using the same vi.hoisted +
 * vi.mock('../src/db.js') pattern as email-drafts.test.ts and
 * seed-pollution-guard.test.ts.
 *
 * Two cases:
 *   1. Polluted DB → handler returns 503 with body containing `seed_pollution`.
 *   2. Clean DB    → handler does NOT return 503 (it routes normally —
 *      whatever status code the route eventually produces is fine, as long
 *      as the gate let it through).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbExecuteMock } = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })),
}));

vi.mock('../src/db.js', () => ({
  getDb: async () => ({
    execute: dbExecuteMock,
    transaction: async (fn: (tx: { execute: typeof dbExecuteMock }) => Promise<unknown>) =>
      fn({ execute: dbExecuteMock }),
  }),
  __setDbForTest: () => {},
}));

// Stable bearer for the auth gate — must be set BEFORE the handler is
// imported because verifyBearer reads process.env at call time but the
// handler module's top-level imports do not capture it.
process.env.KOS_DASHBOARD_BEARER_TOKEN = 'test-bearer';

function fakeEvent() {
  return {
    version: '2.0',
    requestContext: {
      http: { method: 'GET', path: '/today', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: 'test-req',
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'test.lambda-url.eu-north-1.on.aws',
      domainPrefix: 'test',
      stage: '$default',
      time: '2026-04-26T18:00:00.000Z',
      timeEpoch: 1745690400000,
      routeKey: '$default',
    },
    headers: { authorization: `Bearer ${process.env.KOS_DASHBOARD_BEARER_TOKEN}` },
    rawPath: '/today',
    rawQueryString: '',
    isBase64Encoded: false,
    body: null,
    routeKey: '$default',
    cookies: [],
    queryStringParameters: undefined,
    pathParameters: undefined,
    stageVariables: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('dashboard-api handler — seed pollution gate (Plan 11-01 Task 2)', () => {
  beforeEach(async () => {
    dbExecuteMock.mockReset();
    const mod = await import('../src/seed-pollution-guard.js');
    mod.__resetSeedPollutionCacheForTests();
  });

  it('returns 503 with seed_pollution body when guard trips', async () => {
    // First db.execute call (the guard SELECT) returns a polluted row.
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const { handler } = await import('../src/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await handler(fakeEvent(), {} as any, () => undefined)) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/seed_pollution/);
    const parsed = JSON.parse(res.body) as { error: string; detail: string };
    expect(parsed.error).toBe('service_unavailable');
    expect(parsed.detail).toBe('seed_pollution');
  });

  it('passes the gate and routes normally when clean', async () => {
    // Guard SELECT returns empty rows; subsequent route queries also
    // return empty rows so /today succeeds (or 404s — anything non-503
    // proves the gate let the request through).
    dbExecuteMock.mockResolvedValue({ rows: [] });
    const { handler } = await import('../src/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await handler(fakeEvent(), {} as any, () => undefined)) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).not.toBe(503);
  });
});
