-- Phase 10 migration audit columns + indexes
-- Plan 10-00 — scaffolds the audit surface used by:
--   MIG-01  classify-adapter-cutover         (Plan 10-01)
--   MIG-02  n8n-workflows-archived, n8n-stopped (Plan 10-02)
--   MIG-03  brain-db-archived                (Plan 10-03)
--   CAP-10  discord-listener-cutover         (Plan 10-04)
--   INF-11  vps-service-stopped, vps-service-disabled, vps-powered-down,
--           hetzner-snapshot-taken, hetzner-snapshot-deleted,
--           telegram-webhook-retest          (Plans 10-05/10-06/10-07)
--
-- Migration number: 0021. Chosen over the plan's draft 0016 because
-- migrations 0014-0019 are already on disk (Phase 4 + 5 + 7 retro splits)
-- and 0020 is reserved as the next free slot for Phase 8 plan 08-00 (which
-- this scaffold sequences AFTER per ROADMAP). Cf. 10-00-AGENT-NOTES.md.
--
-- The `event_log` table itself was created in 0001 and refined in 0011.
-- This migration ALTERs to add:
--   - `actor` TEXT NOT NULL  (who/what wrote the row — plan or operator)
--   - new index `event_log_owner_at_idx` on (owner_id, occurred_at DESC)
--     so the dashboard can render a per-owner audit timeline efficiently
--   - COMMENT documenting the kind enum lives in
--     `packages/contracts/src/migration.ts EventLogKindSchema`
--
-- Backwards compat: existing rows get `actor='legacy'` via the DEFAULT;
-- after backfill the DEFAULT is dropped so future writers must supply an
-- actor explicitly.

BEGIN;

-- 1) Add `actor` column with a backfill default, then drop the default so
--    new writers (Phase 10 plans) cannot silently omit it.
ALTER TABLE event_log
  ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE event_log
  ALTER COLUMN actor DROP DEFAULT;

-- 2) Index for per-owner timeline reads. The pre-existing
--    `event_log_by_kind` covers (kind, occurred_at) — this is the
--    complementary index for the dashboard "Audit timeline" panel and the
--    Phase-10 verifier scripts that walk one owner_id at a time.
CREATE INDEX IF NOT EXISTS event_log_owner_at_idx
  ON event_log (owner_id, occurred_at DESC);

-- 3) Document the kind contract. Open-text in the DB; constrained at the
--    application layer via `@kos/contracts` EventLogKindSchema so future
--    kinds can land without an ALTER TABLE.
COMMENT ON COLUMN event_log.kind IS
  'See packages/contracts/src/migration.ts EventLogKindSchema for the allowed Phase-10 kinds.';
COMMENT ON COLUMN event_log.actor IS
  'Plan id (e.g. ''plan-10-03'') or operator handle that wrote the row.';

COMMIT;

-- Operator-only ROLLBACK (NOT auto-applied):
--   BEGIN;
--   DROP INDEX IF EXISTS event_log_owner_at_idx;
--   ALTER TABLE event_log DROP COLUMN IF EXISTS actor;
--   COMMIT;
