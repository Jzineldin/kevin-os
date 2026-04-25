/**
 * Hybrid query — BM25 + vector top-50 + semantic reranker top-10.
 *
 * Phase 6 MEM-03 query-side. Target p95 < 600ms for representative traffic.
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-RESEARCH.md
 */
import type { SearchHit } from '@kos/contracts/context';
import { getAzureSearchClient } from './client.js';
import { embedText } from './embed.js';

// IN-01 hardening (Plan 06-08): defense-in-depth UUID validation before
// interpolating entity IDs into the OData filter. Today every caller
// passes DB UUIDs (entity_index PK / mention_events.entity_id), so this
// is belt-and-braces — but it eliminates a future regression vector if a
// less-trusted caller is ever wired up.
const UUID_RE = /^[0-9a-f-]{36}$/i;

export interface HybridQueryInput {
  rawText: string;
  entityIds: string[];
  topK?: number;
  /** Override default index name. Defaults to AZURE_SEARCH_INDEX_NAME env. */
  indexName?: string;
}

export interface HybridQueryResult {
  hits: SearchHit[];
  elapsed_ms: number;
  semantic_reranker_applied: boolean;
}

export async function hybridQuery(input: HybridQueryInput): Promise<HybridQueryResult> {
  const started = Date.now();
  const {
    rawText,
    entityIds,
    topK = 10,
    indexName = process.env.AZURE_SEARCH_INDEX_NAME ?? 'kos-memory',
  } = input;

  // IN-01 hardening (Plan 06-08): validate entity IDs are UUIDs BEFORE we
  // interpolate them into the OData filter below. Runs first so a malicious
  // entityId never reaches the Azure SDK and so non-UUID inputs short-circuit
  // with a clear error.
  for (const id of entityIds) {
    if (!UUID_RE.test(id)) {
      throw new Error(
        `hybridQuery: entityId "${id}" is not a UUID — refusing to interpolate into OData filter (IN-01 hardening, Plan 06-08)`,
      );
    }
  }

  if (!rawText || rawText.trim().length === 0) {
    return { hits: [], elapsed_ms: Date.now() - started, semantic_reranker_applied: false };
  }

  const client = await getAzureSearchClient<AzureSearchDoc>(indexName);
  const vector = await embedText({ text: rawText, inputType: 'search_query' });

  const filter =
    entityIds.length > 0
      ? `entity_ids/any(id: search.in(id, '${entityIds.join(',')}'))`
      : undefined;

  const results = await client.search(rawText, {
    top: topK,
    vectorSearchOptions: {
      queries: [
        {
          kind: 'vector',
          vector,
          fields: ['content_vector'],
          kNearestNeighborsCount: 50,
        },
      ],
    },
    queryType: 'semantic',
    semanticSearchOptions: {
      configurationName: 'kos-semantic',
      captions: { captionType: 'extractive' },
    },
    filter,
    select: ['id', 'source', 'title', 'snippet', 'entity_ids', 'indexed_at'],
  });

  const hits: SearchHit[] = [];
  for await (const res of results.results) {
    const doc = res.document;
    hits.push({
      id: doc.id,
      source: doc.source,
      title: doc.title,
      snippet: doc.snippet,
      score: res.score,
      reranker_score: (res as unknown as { rerankerScore?: number }).rerankerScore ?? null,
      entity_ids: doc.entity_ids ?? [],
      indexed_at: doc.indexed_at,
    });
  }

  return {
    hits,
    elapsed_ms: Date.now() - started,
    semantic_reranker_applied: true,
  };
}

interface AzureSearchDoc {
  id: string;
  source: SearchHit['source'];
  title: string;
  snippet: string;
  content_vector: number[];
  entity_ids: string[];
  indexed_at: string;
}
