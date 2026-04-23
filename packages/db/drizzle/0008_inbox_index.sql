-- Migration 0008 — Phase 3 Plan 03-01 Task 1: inbox_index.
--
-- UI-04 data source. RDS mirror of the KOS Inbox Notion DB (per RESEARCH §9
-- recommendation (b)) so /api/inbox reads from a hot, indexed table instead of
-- round-tripping to Notion on every request. The notion-indexer writes here on
-- every 5-min poll for dbKind='kos_inbox'; the dashboard-api reads, and the
-- 0009 trigger emits a pointer-only pg_notify for each INSERT so the
-- dashboard-listen-relay can push an SSE event to Kevin's browser.
--
-- `id` matches the Notion page id verbatim (TEXT, not UUID) so re-indexing is
-- idempotent via INSERT ... ON CONFLICT (id) DO UPDATE.
--
-- kind values mirror 03-CONTEXT.md D-25 InboxItemKindSchema.
-- status values mirror the lifecycle the inbox approve/skip handlers drive.
--
-- owner_id forward-compat per STATE.md Locked Decision #13.
--
-- Reversibility: DROP TABLE IF EXISTS inbox_index CASCADE;

BEGIN;

CREATE TABLE IF NOT EXISTS "inbox_index" (
  "id"                     text PRIMARY KEY,
  "owner_id"               uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "kind"                   text NOT NULL,
  "title"                  text NOT NULL,
  "preview"                text NOT NULL,
  "bolag"                  text,
  "entity_id"              uuid REFERENCES "entity_index"("id"),
  "merge_id"               text REFERENCES "entity_merge_audit"("merge_id"),
  "payload"                jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"                 text NOT NULL DEFAULT 'pending',
  "notion_last_edited_at"  timestamptz,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inbox_index_kind_check" CHECK ("kind" IN (
    'draft_reply',
    'entity_routing',
    'new_entity',
    'merge_resume'
  )),
  CONSTRAINT "inbox_index_bolag_check" CHECK (
    "bolag" IS NULL OR "bolag" IN ('tale-forge','outbehaving','personal')
  ),
  CONSTRAINT "inbox_index_status_check" CHECK ("status" IN (
    'pending',
    'approved',
    'skipped',
    'rejected',
    'archived'
  ))
);

-- Hot read path: /api/inbox?status=pending ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS "inbox_index_pending"
  ON "inbox_index" ("owner_id", "created_at" DESC)
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "inbox_index_by_entity"
  ON "inbox_index" ("entity_id")
  WHERE "entity_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inbox_index_by_merge"
  ON "inbox_index" ("merge_id")
  WHERE "merge_id" IS NOT NULL;

COMMIT;
