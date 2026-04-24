/**
 * Upsert documents — merge-or-upload into the Azure Search index.
 *
 * Phase 6 MEM-03 write-side. Called by services/azure-search-indexer-*.
 * Idempotent (same id merges); adds vector if missing; preserves indexed_at.
 */
import type { SearchHit } from '@kos/contracts/context';
import { getAzureSearchClient } from './client.js';
import { embedText } from './embed.js';

export interface UpsertBatch {
  indexName?: string;
  documents: Array<{
    id: string;
    source: SearchHit['source'];
    title: string;
    snippet: string;
    content_for_embedding: string;
    entity_ids: string[];
    indexed_at: string;
  }>;
}

export async function upsertDocuments(
  batch: UpsertBatch,
): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  const {
    indexName = process.env.AZURE_SEARCH_INDEX_NAME ?? 'kos-memory',
    documents,
  } = batch;

  if (documents.length === 0) return { succeeded: 0, failed: 0, errors: [] };

  const client = await getAzureSearchClient<AzureSearchDoc>(indexName);

  const withVectors = await Promise.all(
    documents.map(async (d) => ({
      id: d.id,
      source: d.source,
      title: d.title,
      snippet: d.snippet,
      entity_ids: d.entity_ids,
      indexed_at: d.indexed_at,
      content_vector: await embedText({
        text: d.content_for_embedding,
        inputType: 'search_document',
      }),
    })),
  );

  const res = await client.mergeOrUploadDocuments(withVectors);
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const r of res.results) {
    if (r.succeeded) succeeded++;
    else {
      failed++;
      if (r.errorMessage) errors.push(`${r.key}: ${r.errorMessage}`);
    }
  }
  return { succeeded, failed, errors };
}

interface AzureSearchDoc {
  id: string;
  source: SearchHit['source'];
  title: string;
  snippet: string;
  entity_ids: string[];
  indexed_at: string;
  content_vector: number[];
}
