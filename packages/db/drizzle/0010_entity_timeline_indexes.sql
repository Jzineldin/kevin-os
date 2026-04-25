-- Migration 0010 — Phase 3 Plan 03-01 Task 1: timeline query indexes.
--
-- Per-entity dossier page executes a UNION ALL across `mention_events` (raw
-- captures tagged with an entity) and `agent_runs` (agent outputs whose
-- output_json references an entity via output_json->>'entity_id'). The budget
-- is < 500ms (UI-02, ENT-08). RESEARCH §10 lines 944-946 specifies:
--
--   1. A composite descending index on mention_events(entity_id, occurred_at DESC, id DESC)
--      for stable keyset pagination per (occurred_at, id).
--   2. An expression index on agent_runs((output_json->>'entity_id')::uuid)
--      restricted to rows that actually carry that key, so the index stays tight.
--
-- The existing mention_events_by_entity_time index in 0001 is ASCENDING on
-- occurred_at; the timeline query orders DESC, so the planner can still use
-- the B-tree scan backwards. We add a DESC variant for explicit keyset
-- pagination that includes `id` as a tiebreaker.
--
-- Reversibility: DROP INDEX IF EXISTS … (idempotent).

BEGIN;

-- Composite DESC + id tiebreaker for timeline keyset pagination.
CREATE INDEX IF NOT EXISTS "mention_events_by_entity_time_desc"
  ON "mention_events" ("entity_id", "occurred_at" DESC, "id" DESC)
  WHERE "owner_id" IS NOT NULL;

-- Expression index on agent_runs output_json->>'entity_id' for UNION half.
CREATE INDEX IF NOT EXISTS "agent_runs_by_entity_jsonb"
  ON "agent_runs" ((("output_json"->>'entity_id')::uuid), "started_at" DESC)
  WHERE "output_json" ? 'entity_id';

COMMIT;
