-- Phase 11 follow-up: migrate 1887 rows that were written under a ghost
-- KEVIN_OWNER_ID hardcoded in the CDK brief-Lambda wiring. Run after the
-- accompanying CDK fix (integrations-lifecycle.ts commonEnv now reads
-- props.kevinOwnerId, not the literal '9e4be978-...').
--
-- Safe + idempotent: UPDATE only targets the ghost UUID; rows already
-- on the correct owner_id are untouched. A replay leaves counts=0.
--
-- Verified against prod on 2026-04-27 08:15 UTC:
--   agent_runs          1887 ghost rows → remapped
--   event_log                 0 → no-op
--   top3_membership           0 → no-op
--   entity_index              0 → no-op
--   inbox_index               0 → no-op
--   telegram_inbox_queue      0 → no-op
-- Only agent_runs was affected because only morning-brief/day-close/
-- weekly-review/verify-notification-cap ran under the ghost owner.

BEGIN;

UPDATE agent_runs
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE event_log
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE top3_membership
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE entity_index
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE inbox_index
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE telegram_inbox_queue
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE email_drafts
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE calendar_events_cache
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

UPDATE mention_events
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

COMMIT;
