/**
 * ENT-09 / D-09 hybrid scoring function.
 * Score = max(0.6·trigram, 0.6·cosine, 0.3·trigram + 0.7·cosine)
 * Covers typos (pg_trgm) AND semantic matches (pgvector cosine).
 *
 * Inputs are clamped to [0, 1] per pg_trgm and cosine-similarity ranges.
 * Regression on this formula corrupts every downstream resolver decision
 * (threat T-02-SCAFFOLD-01) — unit-tested in test/score.test.ts.
 */
export function hybridScore(trigram: number, cosine: number): number {
  if (trigram < 0 || trigram > 1) throw new Error(`trigram out of range: ${trigram}`);
  if (cosine < 0 || cosine > 1) throw new Error(`cosine out of range: ${cosine}`);
  return Math.max(
    0.6 * trigram,
    0.6 * cosine,
    0.3 * trigram + 0.7 * cosine,
  );
}

export type Stage = 'auto-merge' | 'llm-disambig' | 'inbox';

/**
 * D-10 thresholds:
 *   score > 0.95       → auto-merge (secondary signal check happens downstream)
 *   0.75 ≤ s ≤ 0.95    → Sonnet 4.6 disambiguation
 *   score < 0.75       → Inbox fallback
 */
export function resolveStage(score: number): Stage {
  if (score > 0.95) return 'auto-merge';
  if (score >= 0.75) return 'llm-disambig';
  return 'inbox';
}
