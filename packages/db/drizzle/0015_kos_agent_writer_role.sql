-- Migration 0015 — Phase 6/7 kos_agent_writer role.
--
-- Creates the IAM-auth Postgres role that Phase 6 + 7 Lambdas use to
-- read/write through the RDS Proxy:
--   - entity-timeline-refresher           (REFRESH MATERIALIZED VIEW)
--   - azure-search-indexer-{entities,projects,transcripts,daily-brief}
--                                         (SELECT + cursor UPSERT)
--   - dossier-loader                      (cache READ/WRITE)
--   - granola-poller                      (transcripts INSERT)
--   - mv-refresher                        (REFRESH MV)
--
-- Plumbing pattern matches migration 0011 (dashboard roles): role created
-- with a password (consumed from `kos/db/kos_agent_writer` Secrets Manager
-- secret created in DataStack), `rds_iam` granted so the role can also
-- authenticate via RDS-issued IAM tokens, and table-level GRANTs scoped to
-- exactly the surface the Phase 6+7 Lambdas touch.
--
-- Idempotent: ALTER ROLE if exists, else CREATE. Safe to re-run after a
-- secret rotation (the wrapper script that drives this re-runs ALTER ROLE
-- with the new password).
--
-- Requires psql `-v` substitution: `kos_agent_writer_password`.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_agent_writer') THEN
    EXECUTE format('ALTER ROLE kos_agent_writer WITH LOGIN PASSWORD %L', current_setting('kos.agent_writer_password'));
  ELSE
    EXECUTE format('CREATE ROLE kos_agent_writer WITH LOGIN PASSWORD %L', current_setting('kos.agent_writer_password'));
  END IF;
END
$$;

GRANT rds_iam TO kos_agent_writer;

-- Phase 6 surface
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_dossiers_cached TO kos_agent_writer;
GRANT SELECT                          ON entity_timeline       TO kos_agent_writer;
GRANT EXECUTE ON FUNCTION refresh_entity_timeline()             TO kos_agent_writer;
GRANT SELECT, INSERT, UPDATE          ON azure_indexer_cursor   TO kos_agent_writer;

-- Phase 6 read access for Azure indexers (entity_index, project_index,
-- mention_events, agent_runs feed Azure Search documents).
GRANT SELECT ON entity_index, project_index, mention_events, agent_runs,
                kevin_context, inbox_index
       TO kos_agent_writer;

-- Phase 7 surface (top3_membership writes from morning/day-close/weekly
-- briefs; verify-notification-cap reads telegram_inbox_queue).
GRANT SELECT, INSERT, UPDATE          ON top3_membership        TO kos_agent_writer;
GRANT SELECT                          ON dropped_threads_v      TO kos_agent_writer;
GRANT SELECT                          ON telegram_inbox_queue   TO kos_agent_writer;

-- Phase 6 Granola poller writes mention_events (from extracted transcripts).
GRANT INSERT ON mention_events TO kos_agent_writer;

COMMIT;
