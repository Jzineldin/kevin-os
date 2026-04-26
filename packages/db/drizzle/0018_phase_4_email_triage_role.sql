-- Migration 0018 — Phase 4 Plan 04-04 kos_email_triage role.
--
-- Creates the IAM-auth Postgres role used by the email-triage Lambda
-- (services/email-triage). Narrow surface:
--   - INSERT, UPDATE on email_drafts (writes Haiku/Sonnet outputs)
--   - SELECT on entity_index, project_index, mention_events (context lookup)
--   - INSERT on agent_runs (idempotency rows)
--   - INSERT on mention_events (entity-resolver routing)
--   - INSERT on agent_dead_letter (withTimeoutAndRetry final-failure path)
--
-- Pattern mirrors migration 0015 (kos_agent_writer) and 0017
-- (kos_email_sender): role gets a password (from
-- `kos/db/kos_email_triage` Secrets Manager secret) AND `rds_iam` so it
-- can also authenticate via RDS-issued IAM tokens through the proxy.
--
-- Hard structural property: kos_email_triage has NO permissions on
-- email_send_authorizations — that table is the Approve gate, only
-- writable by dashboard_api (Plan 04-05 routes) and readable by
-- kos_email_sender (Plan 04-05 sender). email-triage cannot bypass.
--
-- Idempotent: ALTER ROLE if exists, else CREATE.
--
-- Requires psql `-v` substitution: `kos.email_triage_password`.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_email_triage') THEN
    EXECUTE format(
      'ALTER ROLE kos_email_triage WITH LOGIN PASSWORD %L',
      current_setting('kos.email_triage_password')
    );
  ELSE
    EXECUTE format(
      'CREATE ROLE kos_email_triage WITH LOGIN PASSWORD %L',
      current_setting('kos.email_triage_password')
    );
  END IF;
END
$$;

GRANT rds_iam TO kos_email_triage;

-- Phase 4 email surface (writes drafts, no authorization access)
GRANT SELECT, INSERT, UPDATE ON email_drafts        TO kos_email_triage;
GRANT INSERT                 ON agent_dead_letter   TO kos_email_triage;
GRANT INSERT                 ON agent_runs          TO kos_email_triage;
GRANT INSERT                 ON mention_events      TO kos_email_triage;

-- Phase 2/6 read surface (context for classify + draft)
GRANT SELECT ON entity_index, project_index, mention_events,
                kevin_context, agent_runs, kos_inbox
       TO kos_email_triage;

-- Phase 6 dossier cache read (graceful-degrade context loader)
GRANT SELECT ON entity_dossiers_cached TO kos_email_triage;

-- Phase 6 azure_indexer_cursor — email-triage doesn't write here; only
-- granted SELECT in case future enhancements want cursor-based reads.
GRANT SELECT ON azure_indexer_cursor TO kos_email_triage;

COMMIT;
