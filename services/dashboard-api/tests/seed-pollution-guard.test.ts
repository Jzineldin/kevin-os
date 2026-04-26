/**
 * Seed-pollution-guard contract test (Phase 11 Plan 11-01).
 *
 * Phase 11 D-04: dashboard-api startup guard hard-fails when known seed-row
 * names are detected in inbox_index — defense-in-depth so a stray dev script
 * cannot silently re-pollute prod.
 *
 * Names guarded (per CONTEXT D-03):
 *   Damien Carter / Christina Larsson / Jan Eriksson / Lars Svensson /
 *   Almi Företagspartner / Re: Partnership proposal / Re: Summer meeting /
 *   Possible duplicate: Damien C. / Paused: Maria vs Maria Johansson /
 *   Outbehaving angel investor
 *
 * Wave 1 implementation: mocks db.execute via vi.hoisted + vi.mock pattern,
 * mirroring email-drafts.test.ts (RESEARCH.md §C3).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbExecuteMock } = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(async () => ({ rows: [] })),
}));

vi.mock('../src/db.js', () => ({
  getDb: async () => ({
    execute: dbExecuteMock,
    transaction: async (fn: (tx: { execute: typeof dbExecuteMock }) => Promise<unknown>) =>
      fn({ execute: dbExecuteMock }),
  }),
}));

describe('seed-pollution-guard (Phase 11 Plan 11-01)', () => {
  beforeEach(async () => {
    dbExecuteMock.mockReset();
    const mod = await import('../src/seed-pollution-guard.js');
    mod.__resetSeedPollutionCacheForTests();
  });

  it('throws when seed name found in inbox_index', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const { assertNoSeedPollution } = await import('../src/seed-pollution-guard.js');
    await expect(assertNoSeedPollution()).rejects.toThrow(/seed pollution/i);
  });

  it('returns when no seed names found', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    const { assertNoSeedPollution } = await import('../src/seed-pollution-guard.js');
    await expect(assertNoSeedPollution()).resolves.toBeUndefined();
  });

  it('caches clean result — second call does not query', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    const { assertNoSeedPollution } = await import('../src/seed-pollution-guard.js');
    await assertNoSeedPollution();
    await assertNoSeedPollution();
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('caches polluted result — second call throws without querying', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const { assertNoSeedPollution } = await import('../src/seed-pollution-guard.js');
    await expect(assertNoSeedPollution()).rejects.toThrow();
    await expect(assertNoSeedPollution()).rejects.toThrow(/seed pollution/i);
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('exports the exact 10 seed names from D-03', async () => {
    const { SEED_NAMES } = await import('../src/seed-pollution-guard.js');
    expect(SEED_NAMES).toEqual([
      'Damien Carter',
      'Christina Larsson',
      'Jan Eriksson',
      'Lars Svensson',
      'Almi Företagspartner',
      'Re: Partnership proposal',
      'Re: Summer meeting',
      'Possible duplicate: Damien C.',
      'Paused: Maria vs Maria Johansson',
      'Outbehaving angel investor',
    ]);
  });
});
