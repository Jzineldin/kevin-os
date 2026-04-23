-- Migration 0011 — Phase 3 dashboard roles + IAM auth grants.
--
-- Top-level CREATE ROLE / GRANT statements only — psql `:'var'` interpolation
-- does NOT work inside `DO $$ ... $$` blocks (psql treats dollar-quoted
-- strings as opaque). The wrapper script `db-push-dashboard-roles.sh` handles
-- idempotency by dropping any pre-existing dashboard_* roles before running
-- this migration.
--
-- Roles created:
--   dashboard_relay  — Fargate; LISTENs on kos_output, SELECTs ownership
--   dashboard_api    — Lambda; SELECTs from dashboard-readable tables
--   dashboard_notify — Lambda; only calls pg_notify('kos_output', ...)
--
-- Each role gets `rds_iam` so it can authenticate via IAM through RDS Proxy.

BEGIN;

CREATE ROLE dashboard_relay WITH LOGIN PASSWORD :'dashboard_relay_password';
CREATE ROLE dashboard_api    WITH LOGIN PASSWORD :'dashboard_api_password';
CREATE ROLE dashboard_notify WITH LOGIN PASSWORD :'dashboard_notify_password';

GRANT rds_iam TO dashboard_relay;
GRANT rds_iam TO dashboard_api;
GRANT rds_iam TO dashboard_notify;

-- dashboard_relay: read pointer-target tables for ownership validation
GRANT SELECT ON entity_index, project_index, mention_events, agent_runs,
                kevin_context, inbox_index, entity_merge_audit
       TO dashboard_relay;

-- dashboard_api: full SELECT for /today, /timeline, /entities, /inbox
GRANT SELECT ON entity_index, project_index, mention_events, agent_runs,
                kevin_context, inbox_index, telegram_inbox_queue,
                entity_merge_audit, event_log
       TO dashboard_api;

-- dashboard_notify: pg_notify is unrestricted; no GRANT needed.

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
