-- Migration 0017 — Phase 4 Plan 04-05 RDS roles & grants.
--
-- Two pieces:
--   1. Create `kos_email_sender` IAM-auth role for the email-sender
--      Lambda. Narrow surface: SELECT/UPDATE on email_drafts (only the
--      columns the Lambda touches), SELECT/UPDATE on
--      email_send_authorizations, INSERT on agent_dead_letter (for
--      withTimeoutAndRetry's dead-letter path).
--   2. Extend `dashboard_api` (created in migration 0011) with read +
--      write on the new Phase 4 email tables so the Approve / Edit /
--      Skip routes can persist state. Also INSERT on
--      email_send_authorizations (the security-critical write).
--
-- IAM-auth pattern matches migration 0015 (kos_agent_writer): role gets
-- a password (consumed from `kos/db/kos_email_sender` Secrets Manager
-- secret) AND `rds_iam` so it can also authenticate via RDS-issued IAM
-- tokens.
--
-- Idempotent: ALTER ROLE if exists, else CREATE. The wrapper script that
-- drives this re-runs ALTER ROLE on secret rotation.
--
-- Requires psql `-v` substitution: `kos.email_sender_password`.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_email_sender') THEN
    EXECUTE format(
      'ALTER ROLE kos_email_sender WITH LOGIN PASSWORD %L',
      current_setting('kos.email_sender_password')
    );
  ELSE
    EXECUTE format(
      'CREATE ROLE kos_email_sender WITH LOGIN PASSWORD %L',
      current_setting('kos.email_sender_password')
    );
  END IF;
END
$$;

GRANT rds_iam TO kos_email_sender;

-- email-sender narrow surface --------------------------------------------
-- SELECT entire row + UPDATE only the three "post-send" columns.
GRANT SELECT                                          ON email_drafts                TO kos_email_sender;
GRANT UPDATE (status, sent_at, sent_message_id)        ON email_drafts                TO kos_email_sender;
GRANT SELECT                                          ON email_send_authorizations    TO kos_email_sender;
GRANT UPDATE (consumed_at, send_result)                ON email_send_authorizations    TO kos_email_sender;
-- Dead-letter writes from withTimeoutAndRetry on final SES failure.
GRANT SELECT, INSERT                                   ON agent_dead_letter            TO kos_email_sender;

-- dashboard_api full read+write surface for Approve/Edit/Skip + Inbox merge
-- (created by migration 0011; here we extend with the Phase 4 tables).
GRANT SELECT, INSERT, UPDATE                           ON email_drafts                TO dashboard_api;
GRANT SELECT, INSERT, UPDATE                           ON email_send_authorizations    TO dashboard_api;
GRANT SELECT                                           ON agent_dead_letter            TO dashboard_api;

COMMIT;

-- ---------------------------------------------------------------------------
-- Reversibility (operator-run only):
-- ---------------------------------------------------------------------------
-- BEGIN;
-- REVOKE ALL ON email_drafts, email_send_authorizations, agent_dead_letter
--        FROM kos_email_sender, dashboard_api;
-- REVOKE rds_iam FROM kos_email_sender;
-- DROP ROLE IF EXISTS kos_email_sender;
-- COMMIT;
