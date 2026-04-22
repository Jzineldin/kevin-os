-- Migration 0006 — Phase 2 Plan 02-08 Task 2: add entity_index.embed_hash for re-embed dedup.
--
-- The notion-indexer's entities upsert path now embeds D-08 entity text on
-- every insert + on changes. To avoid re-embedding identical text on every
-- 5-min poll (Pitfall: Denial of Wallet), we cache the sha256 of the text
-- that produced the current embedding and short-circuit the embed call when
-- the new text hashes to the same value.
--
-- Backfill: NULL on existing rows. The first time the indexer touches an
-- existing row it will compute hash=sha256(entityText), see embed_hash IS
-- NULL, embed once, and store the hash going forward.
--
-- Reversibility: DROP COLUMN IF EXISTS embed_hash; — no data loss
-- (embeddings stay; only the dedup hash is removed).

BEGIN;
ALTER TABLE entity_index ADD COLUMN IF NOT EXISTS embed_hash text;
COMMIT;
