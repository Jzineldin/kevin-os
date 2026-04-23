-- Migration 0011 — Phase 3 dashboard roles + IAM auth grants.
--
-- Creates 3 Postgres roles used exclusively by the KosDashboard stack:
--   dashboard_relay  — Fargate service; LISTENs on kos_output channel
--   dashboard_api    — Lambda; SELECTs from dashboard-readable tables
--   dashboard_notify — Lambda; only calls pg_notify('kos_output', ...)
--
-- Each role is granted `rds_iam` so it can authenticate via IAM through RDS
-- Proxy (the proxy uses stored secret credentials to AS-authenticate; the
-- service uses an IAM-signed token as its password to the proxy).
--
-- Passwords are passed in via psql `-v` variables; the values come from the
-- Secrets Manager secrets that CDK creates and registers with the proxy.
-- See scripts/db-push.sh for the wrapper that fetches secrets and invokes
-- this migration.
--
-- Reversibility: DROP ROLE statements at the bottom (commented; uncomment to
-- roll back).

BEGIN;

-- ---------------------------------------------------------------------------
-- dashboard_relay — LISTEN on kos_output for SSE fan-out
-- ---------------------------------------------------------------------------
-- LISTEN/NOTIFY in PG 16 needs no explicit grant; any role can LISTEN.
-- We grant SELECT on the pointer-target tables so the relay can validate
-- ownership before forwarding the SSE pointer to the browser.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_relay') THEN
    CREATE ROLE dashboard_relay WITH LOGIN PASSWORD :'dashboard_relay_password';
  ELSE
    EXECUTE format('ALTER ROLE dashboard_relay WITH LOGIN PASSWORD %L', :'dashboard_relay_password');
  END IF;
END $$;
GRANT rds_iam TO dashboard_relay;
GRANT SELECT ON entity_index, project_index, mention_events, agent_runs,
                kevin_context, inbox_index, entity_merge_audit
       TO dashboard_relay;

-- ---------------------------------------------------------------------------
-- dashboard_api — read-only SELECT for /today, /timeline, /entities, /inbox
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_api') THEN
    CREATE ROLE dashboard_api WITH LOGIN PASSWORD :'dashboard_api_password';
  ELSE
    EXECUTE format('ALTER ROLE dashboard_api WITH LOGIN PASSWORD %L', :'dashboard_api_password');
  END IF;
END $$;
GRANT rds_iam TO dashboard_api;
GRANT SELECT ON entity_index, project_index, mention_events, agent_runs,
                kevin_context, inbox_index, telegram_inbox_queue,
                entity_merge_audit, event_log
       TO dashboard_api;

-- ---------------------------------------------------------------------------
-- dashboard_notify — pg_notify only (EventBridge -> SSE fan-out trigger)
-- ---------------------------------------------------------------------------
-- pg_notify is unrestricted in PG 16 — no GRANT needed beyond LOGIN + rds_iam.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_notify') THEN
    CREATE ROLE dashboard_notify WITH LOGIN PASSWORD :'dashboard_notify_password';
  ELSE
    EXECUTE format('ALTER ROLE dashboard_notify WITH LOGIN PASSWORD %L', :'dashboard_notify_password');
  END IF;
END $$;
GRANT rds_iam TO dashboard_notify;

COMMIT;

-- ---------------------------------------------------------------------------
-- Reversibility (uncomment to roll back):
-- ---------------------------------------------------------------------------
-- BEGIN;
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dashboard_relay, dashboard_api, dashboard_notify;
-- REVOKE rds_iam FROM dashboard_relay, dashboard_api, dashboard_notify;
-- DROP ROLE IF EXISTS dashboard_relay;
-- DROP ROLE IF EXISTS dashboard_api;
-- DROP ROLE IF EXISTS dashboard_notify;
-- COMMIT;
