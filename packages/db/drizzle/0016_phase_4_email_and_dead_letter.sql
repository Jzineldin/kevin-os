-- Migration 0016 — Phase 4 email pipeline + agent dead letter (3 tables).
--
-- Note on numbering: the original Plan 04-00 reserved 0012, then 0013 as a
-- collision guard for Phase 6's 0012. At execution time Phase 6 (0012) has
-- landed, AND Phase 7 has landed migrations 0014 + 0015, so the next
-- available sequential number is 0016. References in subsequent Plans
-- (04-04 / 04-05) use 0016 verbatim.
--
-- Three tables, every one carrying owner_id uuid NOT NULL per D-13 (forward
-- compat for multi-tenant productisation per memory note
-- project_multi_tenant_future).
--
-- pgcrypto extension is assumed present (enabled in migration 0001 / Phase 1).

-- email_drafts ------------------------------------------------------------
--
-- One row per inbound email (forward, inbox-push, or — eventually —
-- forward-attached-thread). The `account_id` ties drafts to the inbox they
-- came from for per-account voice mirroring (D-22). Phase 4 idempotency is
-- enforced at the SQL layer via UNIQUE (account_id, message_id) — replays
-- of the same EmailEngine `messageNew` webhook never double-insert.
CREATE TABLE IF NOT EXISTS "email_drafts" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"          uuid        NOT NULL,
  "capture_id"        text        NOT NULL,
  "account_id"        text        NOT NULL,
  "message_id"        text        NOT NULL,
  "from_email"        text        NOT NULL,
  "to_email"          text[]      NOT NULL DEFAULT '{}',
  "subject"           text,
  "classification"    text        NOT NULL CHECK (classification IN ('urgent','important','informational','junk','pending_triage')),
  "draft_body"        text,
  "draft_subject"     text,
  "status"            text        NOT NULL DEFAULT 'draft' CHECK (status IN ('pending_triage','draft','edited','approved','skipped','sent','failed')),
  "received_at"       timestamptz NOT NULL,
  "triaged_at"        timestamptz,
  "approved_at"       timestamptz,
  "sent_at"           timestamptz,
  "sent_message_id"   text,
  CONSTRAINT "email_drafts_account_message_uidx" UNIQUE ("account_id", "message_id")
);

-- Hot path: inbox queue render (status='draft' newest-first).
CREATE INDEX IF NOT EXISTS "email_drafts_owner_status_idx"
  ON "email_drafts" ("owner_id", "status", "received_at" DESC);

-- Hot path: inbox filter-by-classification (Phase 5 dashboard view).
CREATE INDEX IF NOT EXISTS "email_drafts_owner_classification_idx"
  ON "email_drafts" ("owner_id", "classification", "received_at" DESC);

-- email_send_authorizations ----------------------------------------------
--
-- Single-use token enforced by the email-sender Lambda: an EmailApproved
-- event carries the authorization_id, email-sender re-reads this row,
-- checks consumed_at IS NULL, performs ses:SendRawEmail, then stamps
-- consumed_at + send_result. This indirection prevents replays of the
-- EmailApproved EventBridge detail from sending the same email twice.
CREATE TABLE IF NOT EXISTS "email_send_authorizations" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"      uuid        NOT NULL,
  "draft_id"      uuid        NOT NULL REFERENCES "email_drafts"("id") ON DELETE CASCADE,
  "approved_by"   text        NOT NULL DEFAULT 'kevin',
  "approved_at"   timestamptz NOT NULL DEFAULT now(),
  "consumed_at"   timestamptz,
  "send_result"   jsonb
);

CREATE INDEX IF NOT EXISTS "email_send_authorizations_owner_draft_idx"
  ON "email_send_authorizations" ("owner_id", "draft_id");

-- agent_dead_letter ------------------------------------------------------
--
-- Written by services/_shared/with-timeout-retry.ts on final failure of any
-- wrapped agent tool call. The dashboard surfaces these in real time via
-- the InboxDeadLetterSchema event emitted alongside each row.
CREATE TABLE IF NOT EXISTS "agent_dead_letter" (
  "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"         uuid        NOT NULL,
  "capture_id"       text        NOT NULL,
  "agent_run_id"     uuid,
  "tool_name"        text        NOT NULL,
  "error_class"      text        NOT NULL,
  "error_message"    text        NOT NULL,
  "request_preview"  text,
  "occurred_at"      timestamptz NOT NULL DEFAULT now(),
  "retried_at"       timestamptz
);

CREATE INDEX IF NOT EXISTS "agent_dead_letter_owner_occurred_idx"
  ON "agent_dead_letter" ("owner_id", "occurred_at" DESC);

-- ROLLBACK (operator-run only):
-- DROP TABLE IF EXISTS agent_dead_letter;
-- DROP TABLE IF EXISTS email_send_authorizations;
-- DROP TABLE IF EXISTS email_drafts;
