/**
 * Azure AI Search hit fixtures (Phase 6 Plan 06-00 Task 2).
 *
 * Used by `@kos/azure-search` query helper tests, `@kos/context-loader`
 * tests, and `services/azure-search-indexer-*` tests to validate hybrid
 * BM25 + vector + semantic-rerank result handling without hitting Azure.
 *
 * Shape matches the `SearchHitSchema` Zod schema in @kos/contracts/context.
 */
import type { SearchHit } from '@kos/contracts/context';

export interface SearchHitOverrides {
  id?: string;
  source?: SearchHit['source'];
  title?: string;
  snippet?: string;
  score?: number;
  reranker_score?: number | null;
  entity_ids?: string[];
  indexed_at?: string;
}

const DEFAULT_INDEXED_AT = '2026-04-20T15:00:00.000Z';

/**
 * Build a deterministic synthetic SearchHit. Default `source='transcript'`
 * with non-null reranker_score (semantic reranker enabled per D-11).
 */
export function fakeSearchHit(overrides: SearchHitOverrides = {}): SearchHit {
  return {
    id: overrides.id ?? 'transcript:01a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
    source: overrides.source ?? 'transcript',
    title: overrides.title ?? 'Möte med Damien om Almi och konvertibellån',
    snippet:
      overrides.snippet ??
      'Damien och Kevin diskuterade konvertibellånet med Almi Invest, bolagsstämma planerad till nästa fredag.',
    score: overrides.score ?? 0.82,
    reranker_score: overrides.reranker_score ?? 2.41,
    entity_ids: overrides.entity_ids ?? [],
    indexed_at: overrides.indexed_at ?? DEFAULT_INDEXED_AT,
  };
}

/**
 * Build N deterministic SearchHits with varied id/score/snippet so consumers
 * can assert on score-ordering and id-uniqueness.
 */
export function fakeSearchHits(n: number): SearchHit[] {
  const sources: SearchHit['source'][] = ['transcript', 'entity', 'project', 'daily_brief'];
  return Array.from({ length: n }, (_, i) => {
    const source = sources[i % sources.length]!;
    return fakeSearchHit({
      id: `${source}:fixture-${String(i).padStart(3, '0')}`,
      source,
      title: `Fixture hit ${i + 1}`,
      snippet: `Synthetic Azure search hit #${i + 1} from source=${source} for unit-test scoring assertions.`,
      // Score descends linearly so consumers can assert ordering.
      score: Number((0.95 - i * 0.03).toFixed(4)),
      reranker_score: Number((3.0 - i * 0.1).toFixed(4)),
    });
  });
}
