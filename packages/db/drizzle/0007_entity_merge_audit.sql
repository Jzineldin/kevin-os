-- Migration 0007 — Phase 3 Plan 03-01 Task 1: entity_merge_audit.
--
-- ENT-07 audit + resume state machine for manual entity merges (D-27..D-29).
-- Every Notion→RDS merge pipeline step writes one row here; the state column
-- implements the 11-state machine so the merge-resume Lambda can pick up a
-- partial merge exactly where it failed without re-running side-effects.
--
-- States (CHECK-enforced):
--   initiated                        — row written; no Notion mutation yet
--   notion_relations_copied          — inbound relations re-pointed on Notion
--   notion_archived                  — source Notion page archived (reversible)
--   rds_updated                      — entity_index + mention_events repointed
--   complete                         — terminal success
--   failed_at_<state>                — failure at each step above
--   cancelled                        — user aborted from Inbox `merge_resume` card
--   reverted                         — explicit revert executed (un-archive, etc.)
--
-- owner_id forward-compat per STATE.md Locked Decision #13. Literal default
-- matches packages/db/src/owner.ts KEVIN_OWNER_ID.
--
-- Reversibility: DROP TABLE IF EXISTS entity_merge_audit CASCADE; — drops
-- indexes with it. No trigger on this table in 0007 (the NOTIFY trigger is
-- added in 0009 so DROP TABLE here + 0008 rollback is clean).

BEGIN;

CREATE TABLE IF NOT EXISTS "entity_merge_audit" (
  "merge_id"           text PRIMARY KEY,
  "owner_id"           uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "source_entity_id"   uuid NOT NULL REFERENCES "entity_index"("id"),
  "target_entity_id"   uuid NOT NULL REFERENCES "entity_index"("id"),
  "initiated_by"       text NOT NULL DEFAULT 'kevin',
  "state"              text NOT NULL,
  "diff"               jsonb NOT NULL,
  "error_message"      text,
  "notion_archived_at" timestamptz,
  "rds_updated_at"     timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "completed_at"       timestamptz,
  CONSTRAINT "entity_merge_audit_state_check" CHECK ("state" IN (
    'initiated',
    'notion_relations_copied',
    'notion_archived',
    'rds_updated',
    'complete',
    'failed_at_initiated',
    'failed_at_notion_relations_copied',
    'failed_at_notion_archived',
    'failed_at_rds_updated',
    'cancelled',
    'reverted'
  ))
);

CREATE INDEX IF NOT EXISTS "entity_merge_audit_by_state"
  ON "entity_merge_audit" ("state", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "entity_merge_audit_by_source"
  ON "entity_merge_audit" ("source_entity_id");

CREATE INDEX IF NOT EXISTS "entity_merge_audit_by_owner"
  ON "entity_merge_audit" ("owner_id", "created_at" DESC);

COMMIT;
