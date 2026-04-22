-- HNSW index on entity_index.embedding — pgvector 0.8.0 on PostgreSQL 16.5+.
-- Column is populated in Phase 6 (embeddings pipeline); index exists from
-- Phase 1 so the first write benefits from it.
-- m = 16, ef_construction = 64 follow the pgvector README defaults for ~1M-vec
-- workloads; we expect low thousands at Gate 4 so this is generous.
CREATE INDEX IF NOT EXISTS "entity_index_embedding_hnsw"
  ON "entity_index"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
