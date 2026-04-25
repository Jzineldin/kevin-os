-- Phase 6 — Granola + Semantic Memory migration
--
-- Provides:
--   1. entity_dossiers_cached     — Postgres-backed dossier cache (D-17)
--   2. entity_timeline            — materialized view (MEM-04)
--   3. trg_entity_dossiers_cached_invalidate
--                                 — auto-delete cache row on mention_events insert
--   4. refresh_entity_timeline()  — SECURITY DEFINER wrapper for CONCURRENTLY refresh
--   5. azure_indexer_cursor       — per-indexer-source incremental sync cursor
--
-- All tables carry owner_id UUID NOT NULL for single-user → multi-user
-- forward-compat (Locked Decision #13).
--
-- Reference: .planning/phases/06-granola-semantic-memory/06-04-PLAN.md
--           .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
--           .planning/phases/06-granola-semantic-memory/06-00-PLAN.md

-- ---------------------------------------------------------------------------
-- 1. Dossier cache (Phase 6 D-17)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_dossiers_cached (
  entity_id        uuid       NOT NULL,
  owner_id         uuid       NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  last_touch_hash  text       NOT NULL,
  bundle           jsonb      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (entity_id, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_dossiers_cached_expires
  ON entity_dossiers_cached (expires_at);

CREATE INDEX IF NOT EXISTS idx_entity_dossiers_cached_owner
  ON entity_dossiers_cached (owner_id, entity_id);

COMMENT ON TABLE entity_dossiers_cached IS
  'Phase 6 D-17: Postgres-backed dossier cache keyed by (entity_id, owner_id). '
  'Invalidated by trg_entity_dossiers_cached_invalidate trigger on mention_events insert. '
  'TTL enforced via expires_at; context-loader only reads rows where expires_at > now().';

-- ---------------------------------------------------------------------------
-- 2. Trigger: auto-invalidate cache on new mention_events
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION invalidate_dossier_cache_on_mention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM entity_dossiers_cached
   WHERE entity_id = NEW.entity_id
     AND owner_id  = NEW.owner_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_entity_dossiers_cached_invalidate ON mention_events;
CREATE TRIGGER trg_entity_dossiers_cached_invalidate
AFTER INSERT ON mention_events
FOR EACH ROW
EXECUTE FUNCTION invalidate_dossier_cache_on_mention();

-- ---------------------------------------------------------------------------
-- 3. entity_timeline materialized view (MEM-04)
--
-- Unions mention_events, agent_runs (for "resolver-auto-merge" audit rows),
-- and email_drafts (Phase 4; graceful NULL join if table not yet present).
-- The dashboard /api/entities/:id/timeline query pages with offset+limit
-- against this MV; live 10-min overlay UNIONs mention_events WHERE
-- occurred_at > now() - interval '10 minutes'.
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS entity_timeline;
CREATE MATERIALIZED VIEW entity_timeline AS
-- Phase 1 mention_events schema (migration 0001): columns are
-- (id, owner_id, entity_id, capture_id, source, context, occurred_at, created_at).
-- Earlier drafts of this migration referenced m.kind / m.excerpt — those
-- columns do not exist on mention_events; using them would make this
-- migration fail at apply time. Mapping: source → kind, context → excerpt.
SELECT
  m.owner_id,
  m.entity_id,
  m.capture_id,
  m.source AS kind,
  m.occurred_at,
  m.context AS excerpt,
  'mention'::text AS event_source
FROM mention_events m
WHERE m.entity_id IS NOT NULL
UNION ALL
-- Phase 1 agent_runs schema (migration 0001): the JSON column is named
-- output_json (NOT context). agent-resolver / transcript-extractor write
-- output_json with at minimum {entity_id, summary} when they detect a
-- mention; we read those fields back here.
SELECT
  ar.owner_id,
  (ar.output_json->>'entity_id')::uuid AS entity_id,
  ar.capture_id,
  ar.agent_name AS kind,
  ar.started_at AS occurred_at,
  (ar.output_json->>'summary')::text AS excerpt,
  'agent_run'::text                  AS event_source
FROM agent_runs ar
WHERE ar.output_json ? 'entity_id'
  AND ar.agent_name IN ('entity-resolver', 'transcript-extractor');

-- CONCURRENTLY refresh requires a unique index covering ALL rows.
-- capture_id can be null on legacy rows, so include occurred_at + kind +
-- event_source in the unique tuple to avoid collisions on (owner_id,
-- entity_id, NULL) under heavy entity-resolver load.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_entity_timeline_event
  ON entity_timeline (owner_id, entity_id, capture_id, occurred_at, event_source, kind);

CREATE INDEX IF NOT EXISTS idx_entity_timeline_owner_entity_occurred
  ON entity_timeline (owner_id, entity_id, occurred_at DESC);

COMMENT ON MATERIALIZED VIEW entity_timeline IS
  'Phase 6 MEM-04: per-entity timeline aggregating mention_events + agent_runs. '
  'Refreshed every 5 min by services/entity-timeline-refresher Lambda via CONCURRENTLY. '
  'Dashboard reads union this with live 10-min mention_events overlay for hot-entity freshness.';

-- ---------------------------------------------------------------------------
-- 4. Refresh function — SECURITY DEFINER so scheduled Lambda can invoke
--    with least privilege (REFRESH MATERIALIZED VIEW normally requires
--    owner privileges).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_entity_timeline()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline;
END;
$$;

COMMENT ON FUNCTION refresh_entity_timeline() IS
  'Phase 6 MEM-04: scheduled every 5 min via EventBridge Scheduler. '
  'CONCURRENTLY requires uniq_entity_timeline_event index (above). '
  'SECURITY DEFINER so the refresher Lambda role does not need MV ownership.';

-- ---------------------------------------------------------------------------
-- 5. Grants — applied by Phase-1 roles migration (0011_dashboard_roles.sql)
--    follow-up. Keeping grants DDL in this migration for reviewability:
-- ---------------------------------------------------------------------------

-- Dashboard read-only role (Phase 3) needs SELECT on new MV + cache read.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_dashboard_reader') THEN
    EXECUTE 'GRANT SELECT ON entity_timeline TO kos_dashboard_reader';
    EXECUTE 'GRANT SELECT ON entity_dossiers_cached TO kos_dashboard_reader';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_agent_writer') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON entity_dossiers_cached TO kos_agent_writer';
    EXECUTE 'GRANT SELECT ON entity_timeline TO kos_agent_writer';
    EXECUTE 'GRANT EXECUTE ON FUNCTION refresh_entity_timeline() TO kos_agent_writer';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Azure indexer cursor table (Phase 6 MEM-03)
--
-- Each azure-search-indexer-* Lambda reads + writes a row keyed by `key`
-- ('azure-indexer-entities', 'azure-indexer-projects', etc.) to track the
-- `updated_at` watermark of the last-processed row per source.
-- ---------------------------------------------------------------------------

-- owner_id carried per Locked Decision #13 (every RDS table) even though
-- the cursor key itself is globally-unique. Single-user v1 → multi-user
-- forward-compat at zero cost.
CREATE TABLE IF NOT EXISTS azure_indexer_cursor (
  key            text        PRIMARY KEY,
  owner_id       uuid        NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  last_seen_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotent column add for forward-compat — handles environments where
-- migration 0012 was applied before owner_id was added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'azure_indexer_cursor' AND column_name = 'owner_id'
  ) THEN
    EXECUTE 'ALTER TABLE azure_indexer_cursor ADD COLUMN owner_id uuid NOT NULL DEFAULT ''7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c''::uuid';
  END IF;
END $$;

COMMENT ON TABLE azure_indexer_cursor IS
  'Phase 6 MEM-03: per-indexer-source incremental sync cursor. Each indexer '
  'Lambda reads its cursor on cold-start, queries source table WHERE updated_at > cursor, '
  'advances cursor to max(updated_at) of processed batch. First-run cursor is NULL '
  '(=> fetch-all-then-advance). owner_id present per Locked Decision #13.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_agent_writer') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON azure_indexer_cursor TO kos_agent_writer';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Rollback (operator-only — execute manually if 0012 needs to be reverted):
--
-- DROP MATERIALIZED VIEW IF EXISTS entity_timeline;
-- DROP TRIGGER IF EXISTS trg_entity_dossiers_cached_invalidate ON mention_events;
-- DROP FUNCTION IF EXISTS invalidate_dossier_cache_on_mention();
-- DROP FUNCTION IF EXISTS refresh_entity_timeline();
-- DROP TABLE IF EXISTS entity_dossiers_cached;
-- DROP TABLE IF EXISTS azure_indexer_cursor;
--
-- Order matters: trigger before function, MV before any base table, indexer
-- cursor table last (no dependents). Drizzle's forward-only chain does NOT
-- run this rollback; it lives here purely as a runbook reference per Plan
-- 06-04 acceptance test #2 (rollback comment-block presence).
-- ---------------------------------------------------------------------------
