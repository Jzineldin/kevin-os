/**
 * @kos/azure-search — hybrid BM25 + vector + semantic reranker query lib.
 *
 * Phase 6 MEM-03. Consumed by `packages/context-loader` (via injected
 * `azureSearch` callable) and by `services/azure-search-indexer-*` for
 * write operations.
 *
 * Uses REST API version 2025-09-01 (latest stable). Binary quantization
 * is configured at index creation time (Phase 1 Plan 01-05); this library
 * only issues queries/upserts against the already-provisioned index.
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-RESEARCH.md §Azure
 */
export { hybridQuery, type HybridQueryInput, type HybridQueryResult } from './query.js';
export { upsertDocuments, type UpsertBatch } from './upsert.js';
export { embedText, type EmbedInput } from './embed.js';
export { getAzureSearchClient, type AzureSearchConfig } from './client.js';
