-- Phase 11 follow-up: grant dashboard_api + kos_agent_writer the SELECT /
-- DML they need on tables introduced by Phases 8+10 that weren't granted
-- at the time. Codifies the live hotfix run on 2026-04-27 that unblocked
-- /today, /calendar/week, /inbox-merged, and calendar-reader.
--
-- Background: the DB roles were created by migrations 0011 + 0015 + 0017
-- + 0018 with an explicit GRANT list per role; later migrations added new
-- tables (calendar_events_cache, pending_mutations, content_drafts, etc.)
-- but did not amend the role GRANTs. Result: prod Lambdas started
-- returning 500 "permission denied for table X" after Phase 11 deploy.
--
-- These GRANTs are idempotent (GRANT is a no-op if the privilege is
-- already held) so replaying the migration is safe.
--
-- Verified-needed targets (from dashboard-api handlers/integrations.ts,
-- handlers/today.ts, handlers/calendar.ts and calendar-reader Lambda):
--   dashboard_api (SELECT only):
--     calendar_events_cache, entity_dossiers_cached, dropped_threads_v,
--     system_alerts, sync_status, top3_membership, notion_indexer_cursor,
--     azure_indexer_cursor, content_drafts, document_versions
--   kos_agent_writer (RW):
--     calendar_events_cache, content_drafts, document_versions,
--     top3_membership, pending_mutations, sync_status,
--     azure_indexer_cursor, system_alerts

BEGIN;

-- ---- dashboard_api: read-only -----------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_api') THEN
    -- Each GRANT is wrapped in its own DO block with a table-exists guard
    -- so a partially-migrated tree still runs to completion.
    IF to_regclass('public.calendar_events_cache') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON calendar_events_cache TO dashboard_api';
    END IF;
    IF to_regclass('public.entity_dossiers_cached') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON entity_dossiers_cached TO dashboard_api';
    END IF;
    IF to_regclass('public.dropped_threads_v') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON dropped_threads_v TO dashboard_api';
    END IF;
    IF to_regclass('public.system_alerts') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON system_alerts TO dashboard_api';
    END IF;
    IF to_regclass('public.sync_status') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON sync_status TO dashboard_api';
    END IF;
    IF to_regclass('public.top3_membership') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON top3_membership TO dashboard_api';
    END IF;
    IF to_regclass('public.notion_indexer_cursor') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON notion_indexer_cursor TO dashboard_api';
    END IF;
    IF to_regclass('public.azure_indexer_cursor') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON azure_indexer_cursor TO dashboard_api';
    END IF;
    IF to_regclass('public.content_drafts') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON content_drafts TO dashboard_api';
    END IF;
    IF to_regclass('public.document_versions') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON document_versions TO dashboard_api';
    END IF;
  END IF;
END $$;

-- ---- kos_agent_writer: DML --------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_agent_writer') THEN
    IF to_regclass('public.calendar_events_cache') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events_cache TO kos_agent_writer';
    END IF;
    IF to_regclass('public.content_drafts') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON content_drafts TO kos_agent_writer';
    END IF;
    IF to_regclass('public.document_versions') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON document_versions TO kos_agent_writer';
    END IF;
    IF to_regclass('public.top3_membership') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON top3_membership TO kos_agent_writer';
    END IF;
    IF to_regclass('public.pending_mutations') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON pending_mutations TO kos_agent_writer';
    END IF;
    IF to_regclass('public.sync_status') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON sync_status TO kos_agent_writer';
    END IF;
    IF to_regclass('public.azure_indexer_cursor') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE ON azure_indexer_cursor TO kos_agent_writer';
    END IF;
    IF to_regclass('public.system_alerts') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON system_alerts TO kos_agent_writer';
    END IF;

    -- Sequences for any serial/identity columns on the above tables.
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kos_agent_writer;
  END IF;
END $$;

COMMIT;
