-- Migration 0003 — Phase 2: resize entity_index.embedding from vector(1536) to vector(1024)
-- for Cohere Embed Multilingual v3 (D-05). Adds embedding_model text column for provenance.
--
-- Precondition: zero non-null embeddings (Phase 1 01-02 SUMMARY confirms).
-- Asserts explicitly before destructive ALTER so a production surprise cannot silently drop data.
--
-- Note: kevin_context has no embedding column in Phase 1; this migration does not touch it.
-- Phase 6 will add kevin_context.embedding directly at vector(1024) — no resize needed.

BEGIN;

-- Precondition guard
DO $$
DECLARE cnt int;
BEGIN
  SELECT COUNT(*) INTO cnt FROM entity_index WHERE embedding IS NOT NULL;
  IF cnt > 0 THEN
    RAISE EXCEPTION 'Migration 0003 precondition failed: entity_index has % non-null embeddings. Re-embedding plan needed before this migration can run.', cnt;
  END IF;
END $$;

-- Drop HNSW index first (it references the column being dropped)
DROP INDEX IF EXISTS entity_index_embedding_hnsw;

-- Destructive resize (safe because cnt=0 asserted above)
ALTER TABLE entity_index DROP COLUMN embedding;
ALTER TABLE entity_index ADD COLUMN embedding vector(1024);

-- Provenance column (CONTEXT specifics: "Kevin wants to see which embedding model produced each entity's vector")
ALTER TABLE entity_index ADD COLUMN embedding_model text;

COMMIT;
