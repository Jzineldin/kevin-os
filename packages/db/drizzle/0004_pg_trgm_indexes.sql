-- Migration 0004 — Phase 2: resolver hot-path indexes.
-- pg_trgm GIN on LOWER(name); HNSW recreated on 1024-dim embedding.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Pitfall 4: index the EXACT expression the query uses (`LOWER(name)`).
CREATE INDEX IF NOT EXISTS entity_index_name_trgm
  ON entity_index USING gin (LOWER(name) gin_trgm_ops);

-- Aliases are a text[] — GIN on array-of-lowered via a materialized derived column is the clean path.
-- Without a derived column, the query's EXISTS subquery with UNNEST cannot use an index on array elements
-- efficiently. Keep the query correctness; accept that EXISTS scan on aliases is O(candidates after trigram
-- narrows via name). At Kevin-scale (<5k entities), this is < 2 ms even without aliases index.
--
-- Future optimization (noted here for Phase 6+): add a `name_search` text column = name || ' ' || array_to_string(aliases, ' '),
-- create a single GIN index on it, query against LOWER(name_search). Holds off for now.

-- HNSW on the new 1024-dim embedding column (pgvector 0.8.x)
CREATE INDEX IF NOT EXISTS entity_index_embedding_hnsw
  ON entity_index USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
