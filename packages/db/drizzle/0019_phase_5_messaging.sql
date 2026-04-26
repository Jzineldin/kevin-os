-- phase 5 messaging
-- Phase 5 Plan 05-00: WhatsApp session keys (Baileys pluggable auth), system
-- alerts, sync status. See .planning/phases/05-messaging-channels/05-CONTEXT.md
-- D-06, D-18, D-19.
--
-- Note on numbering: the original Plan 05-00 reserved 0017, but Phase 4 +
-- Phase 7 + dashboard-roles migrations have since landed 0011..0018, so the
-- next available sequential number at execute time is 0019. References in
-- subsequent Plans (05-04 / 05-05) use 0019 verbatim.
--
-- Three tables, every one carrying owner_id uuid NOT NULL per D-13 (forward
-- compat for multi-tenant productisation per memory note
-- project_multi_tenant_future).
--
-- pgcrypto extension is assumed present (enabled in migration 0001 / Phase 1).

BEGIN;

-- whatsapp_session_keys --------------------------------------------------
--
-- Baileys signal-protocol state persisted per owner via the pluggable
-- AuthenticationState provider. Composite PK (owner_id, key_id) lets a
-- single multi-tenant Fargate task host more than one WhatsApp session if
-- KOS ever drops the single-user invariant; today owner_id is constant.
--
-- key_type is denormalised from key_id so the dashboard can render the key
-- inventory without parsing key_id strings (`pre-key-1`, `session-46XXX@...`).
-- value_jsonb is the raw Baileys-serialised payload — opaque to KOS.
CREATE TABLE IF NOT EXISTS "whatsapp_session_keys" (
  "owner_id"     uuid        NOT NULL,
  "key_id"       text        NOT NULL,
  "key_type"     text        NOT NULL,
  "value_jsonb"  jsonb       NOT NULL,
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "key_id")
);

CREATE INDEX IF NOT EXISTS "idx_whatsapp_session_keys_type"
  ON "whatsapp_session_keys" ("owner_id", "key_type");

-- system_alerts ----------------------------------------------------------
--
-- Capture-side alerts surfaced by the dashboard (NOT push, NOT Telegram —
-- ADHD-compatibility constraint per CLAUDE.md). dashboard-api SELECTs
-- WHERE ack_at IS NULL and renders unacked rows in the alerts panel; an
-- ack endpoint stamps ack_at when Kevin clears a row.
CREATE TABLE IF NOT EXISTS "system_alerts" (
  "id"          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "owner_id"    uuid        NOT NULL,
  "source"      text        NOT NULL,   -- chrome | linkedin | whatsapp | discord | baileys | emailengine | system
  "severity"    text        NOT NULL,   -- info | warn | error | auth_fail | unusual_activity
  "message"     text        NOT NULL,
  "raised_at"   timestamptz NOT NULL DEFAULT now(),
  "ack_at"      timestamptz             -- NULL until Kevin acks in Dashboard
);

CREATE INDEX IF NOT EXISTS "idx_system_alerts_owner_raised"
  ON "system_alerts" ("owner_id", "raised_at" DESC);

-- Partial index for the dashboard's hot path: list unacked alerts only.
CREATE INDEX IF NOT EXISTS "idx_system_alerts_unacked"
  ON "system_alerts" ("owner_id", "raised_at" DESC) WHERE "ack_at" IS NULL;

-- sync_status ------------------------------------------------------------
--
-- Per-channel last-healthy timestamp + queue depth used by the verifier
-- (verify-gate-5-baileys) and the dashboard for graceful-degrade rendering.
-- paused_until is set by the LinkedIn 24h backoff (auth_fail) — channel is
-- silently disabled until the timestamp passes, no Telegram notification.
CREATE TABLE IF NOT EXISTS "sync_status" (
  "owner_id"         uuid        NOT NULL,
  "channel"          text        NOT NULL,   -- chrome | linkedin | whatsapp | discord | emailengine
  "last_healthy_at"  timestamptz,
  "queue_depth"      integer     NOT NULL DEFAULT 0,
  "paused_until"     timestamptz,
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "channel")
);

COMMIT;

-- ROLLBACK (operator-run only):
-- BEGIN;
-- DROP TABLE IF EXISTS sync_status;
-- DROP TABLE IF EXISTS system_alerts;
-- DROP TABLE IF EXISTS whatsapp_session_keys;
-- COMMIT;
