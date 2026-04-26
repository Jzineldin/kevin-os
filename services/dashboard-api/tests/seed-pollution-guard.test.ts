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
 * Wave 0 ships skipped placeholders. Wave 1 (Plan 11-01) implements:
 *   - clean DB → assertNoSeedPollution() resolves; cachedResult='clean'
 *   - polluted DB → assertNoSeedPollution() throws; downstream handler
 *     wraps and returns HTTP 503 (not 500 — fail-loud distinct path)
 *   - cached result short-circuits subsequent calls (1 SELECT per cold start)
 *
 * Mirrors email-drafts.test.ts vi.hoisted db mock pattern (RESEARCH.md §C3).
 */
import { describe, it } from 'vitest';

describe('seed-pollution-guard (Phase 11 Plan 11-01)', () => {
  it.skip(
    'throws when seed name found in inbox_index',
    async () => {
      // Wave 1 implements:
      //   vi.mock('../src/db.js') with fakeDb.execute returning
      //   { rows: [{ '?column?': 1 }] } for the SELECT 1 ... LIMIT 1 probe.
      //   Expect assertNoSeedPollution() to reject with seed-pollution Error.
      //   Use vi.resetModules() between cases — guard caches at module scope.
    },
  );

  it.skip(
    'returns clean cached result when no seed names present',
    async () => {
      // Wave 1 implements: fakeDb.execute returns { rows: [] } — guard
      // resolves; cachedResult='clean'; second call short-circuits without
      // hitting db.execute again (assert call count === 1).
    },
  );

  it.skip(
    'caches polluted result and re-throws on subsequent calls',
    async () => {
      // Wave 1 implements: once polluted, do not re-query — every subsequent
      // call throws synchronously (defense in depth against transient
      // network blips masking pollution state).
    },
  );
});
