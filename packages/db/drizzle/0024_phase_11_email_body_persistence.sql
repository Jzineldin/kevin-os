-- Phase 11 polish: persist original email body on email_drafts.
--
-- Motivation: the dashboard's /inbox view shows only a list of subjects.
-- Users can't read what the sender actually wrote, which makes the
-- Approve / Edit / Skip flow impossible to evaluate (Gate 3 from the
-- original KOS-overview). Root cause: gmail-poller FETCHED the body
-- (bodyText + bodyHtml) and passed it through the EventBridge capture
-- payload, but email-triage discarded it after classification.
--
-- These two columns are nullable because:
--   1. Legacy rows (~11 pre-2026-04-27) have no body; never will.
--   2. Future captures that somehow lose the body (prompt-injection
--      escape, corrupted payload) should still persist a draft row
--      rather than silently drop the capture.
--
-- Sizes:
--   body_plain — plaintext, up to ~1 MB (soft enforced client-side via
--                a truncation step in the poller; column itself is TEXT
--                so no hard cap beyond PG's TOAST limits).
--   body_html  — original HTML. Rendered behind a stricter sanitizer
--                at display time (NOT trusted to the DOM).
--
-- Safe to replay: columns are ADD IF NOT EXISTS.

ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS body_plain TEXT,
  ADD COLUMN IF NOT EXISTS body_html  TEXT;

-- Optional: a preview column derived from body_plain for the list view
-- to avoid ever loading the full body on the list endpoint. Triggered by
-- backend INSERT/UPDATE, not a generated column — keeps it simple for
-- pg without requiring the immutable-function dance.
ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS body_preview TEXT;

-- Optional soft index on the preview column for future search.
-- Commented out intentionally — pg_trgm extension may not be installed.
-- CREATE INDEX IF NOT EXISTS email_drafts_body_preview_trgm
--   ON email_drafts USING gin (body_preview gin_trgm_ops);
