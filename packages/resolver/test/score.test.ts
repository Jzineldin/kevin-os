import { describe, it, expect } from 'vitest';
import { hybridScore, resolveStage } from '../src/score.js';

/**
 * Scaffold placeholder tests — full fixture tests (typos, semantic matches,
 * threshold boundaries, auto-merge secondary signals) land in Plan 03.
 *
 * These two assertions are intentionally minimal: they gate the D-09 formula
 * and D-10 thresholds against accidental regressions during scaffolding.
 */
describe('@kos/resolver scaffold', () => {
  it('hybridScore(0, 0) === 0', () => {
    expect(hybridScore(0, 0)).toBe(0);
  });

  it('resolveStage(0.5) === "inbox"', () => {
    expect(resolveStage(0.5)).toBe('inbox');
  });
});
