/**
 * Azure AI Search index definition for KOS semantic memory.
 *
 * CRITICAL: `vectorSearch.compressions[0].kind === 'binaryQuantization'` MUST
 * be present on the FIRST PUT. Binary quantization cannot be retrofitted onto
 * an existing index — retrofit requires a full reindex (01-RESEARCH.md Pattern
 * 5, line 472). If the field list needs to change later, bump to
 * `kos-memory-v2` and rebuild from source-of-truth in Phase 6.
 *
 * Payload shape matches Azure AI Search REST API `2025-09-01`:
 *   https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-quantization
 *   https://learn.microsoft.com/en-us/azure/search/search-how-to-create-search-index
 *
 * This module is imported both by the bootstrap Lambda (runtime PUT) and by
 * the CDK stack (synth-time SHA-256 fingerprint on file content). Keep it a
 * single exported `as const` object so the fingerprint is deterministic.
 */
export const KOS_MEMORY_INDEX_NAME = 'kos-memory-v1';

export const KOS_MEMORY_INDEX_DEFINITION = {
  name: KOS_MEMORY_INDEX_NAME,
  fields: [
    { name: 'id', type: 'Edm.String', key: true, filterable: true },
    { name: 'owner_id', type: 'Edm.String', filterable: true },
    {
      name: 'content',
      type: 'Edm.String',
      searchable: true,
      analyzer: 'standard.lucene',
    },
    {
      name: 'entity_ids',
      type: 'Collection(Edm.String)',
      filterable: true,
    },
    {
      name: 'source',
      type: 'Edm.String',
      filterable: true,
      facetable: true,
    },
    {
      name: 'occurred_at',
      type: 'Edm.DateTimeOffset',
      filterable: true,
      sortable: true,
    },
    {
      name: 'content_vector',
      type: 'Collection(Edm.Single)',
      dimensions: 1536,
      vectorSearchProfile: 'kos-hnsw-binary',
    },
  ],
  vectorSearch: {
    algorithms: [
      {
        name: 'kos-hnsw',
        kind: 'hnsw',
        hnswParameters: {
          m: 4,
          efConstruction: 400,
          efSearch: 500,
          metric: 'cosine',
        },
      },
    ],
    compressions: [
      {
        name: 'kos-binary-compression',
        kind: 'binaryQuantization',
        rescoringOptions: {
          enableRescoring: true,
          defaultOversampling: 10,
          rescoreStorageMethod: 'preserveOriginals',
        },
      },
    ],
    profiles: [
      {
        name: 'kos-hnsw-binary',
        algorithm: 'kos-hnsw',
        compression: 'kos-binary-compression',
      },
    ],
  },
  semantic: {
    configurations: [
      {
        name: 'kos-semantic',
        prioritizedFields: {
          contentFields: [{ fieldName: 'content' }],
          keywordsFields: [{ fieldName: 'entity_ids' }],
        },
      },
    ],
  },
} as const;
