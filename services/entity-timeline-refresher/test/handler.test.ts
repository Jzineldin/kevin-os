/**
 * Plan 06-04 Task 1 — entity-timeline-refresher unit tests.
 *
 * Mocks pg.Pool + RDS Signer + _shared sentry/tracing so the handler runs
 * end-to-end in <50ms without a real RDS Proxy. Asserts the canonical
 * REFRESH SQL string is issued, that elapsedMs is returned, and that
 * pool.query rejection propagates through wrapHandler (Sentry will catch
 * + report; tests verify the throw escapes).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

// Mock pg before persist.ts imports it.
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: queryMock,
  })),
}));

// Mock @aws-sdk/rds-signer so getPool() never tries to call STS.
vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: vi.fn().mockImplementation(() => ({
    getAuthToken: vi.fn().mockResolvedValue('mock-iam-token'),
  })),
}));

// Mock _shared sentry + tracing so handler runs without external deps.
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn().mockResolvedValue(undefined),
  // wrapHandler is identity in tests — we want to observe the underlying throw.
  wrapHandler: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
}));

vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn().mockResolvedValue(undefined),
  tagTraceWithCaptureId: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  queryMock.mockReset();
  process.env.DATABASE_HOST = 'kos-rds-proxy.proxy-test.eu-north-1.rds.amazonaws.com';
  process.env.AWS_REGION = 'eu-north-1';
  // Reset the persist module's pool cache between tests.
  vi.resetModules();
  const persist = await import('../src/persist.js');
  persist.__resetPoolForTest();
});

describe('entity-timeline-refresher handler', () => {
  it('happy path: pool.query called with REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const { handler } = await import('../src/handler.js');

    const result = (await handler(
      {} as never,
      {} as never,
      () => undefined,
    )) as { ok: true; elapsedMs: number };

    expect(queryMock).toHaveBeenCalledOnce();
    const [sql] = queryMock.mock.calls[0]!;
    expect(sql).toContain('REFRESH MATERIALIZED VIEW CONCURRENTLY');
    expect(sql).toContain('entity_timeline');
    expect(result.ok).toBe(true);
  });

  it('elapsedMs returned in result object', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const { handler } = await import('../src/handler.js');
    const result = (await handler(
      {} as never,
      {} as never,
      () => undefined,
    )) as { ok: true; elapsedMs: number };
    expect(result).toHaveProperty('elapsedMs');
    expect(typeof result.elapsedMs).toBe('number');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('pool.query reject → tries SECURITY DEFINER fallback then rethrows', async () => {
    // First call (raw REFRESH) rejects → fallback to SELECT refresh_entity_timeline()
    queryMock.mockRejectedValueOnce(new Error('permission denied for materialized view'));
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const { handler } = await import('../src/handler.js');
    const result = (await handler(
      {} as never,
      {} as never,
      () => undefined,
    )) as { ok: true; elapsedMs: number };
    expect(result.ok).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(2);
    // Second call should be the SECURITY DEFINER wrapper.
    const [secondSql] = queryMock.mock.calls[1]!;
    expect(secondSql).toContain('refresh_entity_timeline');
  });

  it('pool.query rejects on BOTH paths → handler throws (wrapHandler reports to Sentry)', async () => {
    queryMock.mockRejectedValueOnce(new Error('permission denied'));
    queryMock.mockRejectedValueOnce(new Error('also denied'));
    const { handler } = await import('../src/handler.js');
    await expect(
      handler({} as never, {} as never, () => undefined),
    ).rejects.toThrow(/permission denied/);
  });
});
