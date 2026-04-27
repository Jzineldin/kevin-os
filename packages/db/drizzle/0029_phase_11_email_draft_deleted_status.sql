-- Phase 11 backlog: allow 'deleted' status on email_drafts so the
-- /email-drafts/:id/delete endpoint can archive rows without breaking
-- the existing CHECK constraint. Idempotent — replays drop+recreate
-- with the same allowed set.

ALTER TABLE email_drafts DROP CONSTRAINT IF EXISTS email_drafts_status_check;
ALTER TABLE email_drafts
  ADD CONSTRAINT email_drafts_status_check
  CHECK (status = ANY (ARRAY[
    'pending_triage','draft','edited','approved',
    'skipped','sent','failed','deleted'
  ]));
