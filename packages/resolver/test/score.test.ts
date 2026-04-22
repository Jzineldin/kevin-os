import { describe, it, expect } from 'vitest';
import { hybridScore, resolveStage } from '../src/score.js';

describe('hybridScore', () => {
  it('is 0 when both inputs are 0', () => {
    expect(hybridScore(0, 0)).toBe(0);
  });
  it('exact trigram match (c=0) → max(0.6·1, 0, 0.3·1) = 0.6', () => {
    expect(hybridScore(1, 0)).toBeCloseTo(0.6, 10);
  });
  it('exact cosine match (t=0) → max(0, 0.6·1, 0.7·1) = 0.7 (weighted branch wins)', () => {
    // Plan text said 0.6; mathematically the 0.3·0 + 0.7·1 = 0.7 branch dominates.
    // Rule 1 (bug in plan test expectation; implementation matches D-09 formula).
    expect(hybridScore(0, 1)).toBeCloseTo(0.7, 10);
  });
  it('both exact → max branch yields 1.0', () => {
    expect(hybridScore(1, 1)).toBeCloseTo(1.0, 10);
  });
  it('moderate typo (0.85 trigram, 0 cosine) → 0.6 × 0.85 = 0.51', () => {
    expect(hybridScore(0.85, 0)).toBeCloseTo(0.51, 10);
  });
  it('semantic-only (0 trigram, 0.92 cosine) → 0.3·0 + 0.7·0.92 = 0.644 wins over 0.6·0.92=0.552', () => {
    expect(hybridScore(0, 0.92)).toBeCloseTo(0.644, 10);
  });
  it('mixed Damian/Damien typo (0.833 trigram, 0.70 cosine): max(0.499, 0.42, 0.25+0.49)=0.74', () => {
    const s = hybridScore(0.833, 0.70);
    // 0.6*0.833=0.4998; 0.6*0.70=0.42; 0.3*0.833+0.7*0.70=0.7399 → winner
    expect(s).toBeCloseTo(0.7399, 3);
  });
  it('rejects trigram out of range', () => {
    expect(() => hybridScore(-0.1, 0)).toThrow();
    expect(() => hybridScore(1.1, 0)).toThrow();
  });
  it('rejects cosine out of range', () => {
    expect(() => hybridScore(0, -0.1)).toThrow();
    expect(() => hybridScore(0, 1.1)).toThrow();
  });
});

describe('resolveStage', () => {
  it('> 0.95 → auto-merge', () => {
    expect(resolveStage(0.96)).toBe('auto-merge');
    expect(resolveStage(1.0)).toBe('auto-merge');
  });
  it('exactly 0.95 → llm-disambig (inclusive lower bound at 0.75, exclusive upper bound at > 0.95 per D-10)', () => {
    expect(resolveStage(0.95)).toBe('llm-disambig');
  });
  it('0.75 ≤ s ≤ 0.95 → llm-disambig', () => {
    expect(resolveStage(0.75)).toBe('llm-disambig');
    expect(resolveStage(0.85)).toBe('llm-disambig');
  });
  it('< 0.75 → inbox', () => {
    expect(resolveStage(0.7499)).toBe('inbox');
    expect(resolveStage(0)).toBe('inbox');
  });
});
