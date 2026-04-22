-- KOS initial schema — 8 tables, every table carries owner_id with Kevin's UUID
-- as the SQL DEFAULT (STATE.md Locked Decision #13). pgvector extension is
-- created here; RESEARCH Pitfall 4 requires Postgres 16.5+ for pgvector 0.8.0.
-- RESEARCH Pitfall 5: the `vector` column on entity_index is defined inside
-- CREATE TABLE, never via ALTER TABLE (Drizzle emits a malformed quoted type on
-- ALTER).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- entity_index (ENT-01) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "entity_index" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "notion_page_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "aliases" text[] DEFAULT ARRAY[]::text[],
  "type" text NOT NULL,
  "org" text,
  "role" text,
  "relationship" text,
  "status" text,
  "linked_projects" text[] DEFAULT ARRAY[]::text[],
  "seed_context" text,
  "last_touch" timestamptz,
  "manual_notes" text,
  "confidence" integer,
  "source" text[] DEFAULT ARRAY[]::text[],
  "embedding" vector(1536),
  "notion_last_edited_time" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "entity_index_by_owner_type" ON "entity_index" ("owner_id", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "entity_index_notion_page_uq" ON "entity_index" ("notion_page_id");

-- project_index (ENT-02) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS "project_index" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "notion_page_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "bolag" text,
  "status" text,
  "description" text,
  "linked_people" text[] DEFAULT ARRAY[]::text[],
  "seed_context" text,
  "notion_last_edited_time" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "project_index_by_owner" ON "project_index" ("owner_id");

-- notion_indexer_cursor (D-08 / D-11) ----------------------------------------
CREATE TABLE IF NOT EXISTS "notion_indexer_cursor" (
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "db_id" text PRIMARY KEY,
  "db_kind" text NOT NULL,
  "last_cursor_at" timestamptz NOT NULL DEFAULT to_timestamp(0),
  "last_run_at" timestamptz,
  "last_error" text
);

-- agent_runs -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "capture_id" text,
  "agent_name" text NOT NULL,
  "input_hash" text,
  "output_json" jsonb,
  "tokens_input" integer,
  "tokens_output" integer,
  "cost_usd_microcents" integer,
  "status" text NOT NULL,
  "error_message" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "agent_runs_by_capture" ON "agent_runs" ("capture_id");
CREATE INDEX IF NOT EXISTS "agent_runs_by_owner_started" ON "agent_runs" ("owner_id", "started_at");

-- mention_events -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mention_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "entity_id" uuid REFERENCES "entity_index"("id"),
  "capture_id" text,
  "source" text NOT NULL,
  "context" text,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "mention_events_by_entity_time" ON "mention_events" ("entity_id", "occurred_at");

-- event_log ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "event_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "kind" text NOT NULL,
  "detail" jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "event_log_by_kind" ON "event_log" ("kind", "occurred_at");

-- telegram_inbox_queue (D-13) ------------------------------------------------
CREATE TABLE IF NOT EXISTS "telegram_inbox_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "body" text NOT NULL,
  "reason" text NOT NULL,
  "queued_at" timestamptz NOT NULL DEFAULT now(),
  "released_at" timestamptz
);

-- kevin_context (MEM-02) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS "kevin_context" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  "notion_block_id" text NOT NULL UNIQUE,
  "section_heading" text NOT NULL,
  "section_body" text NOT NULL,
  "notion_last_edited_time" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kevin_context_by_owner_heading" ON "kevin_context" ("owner_id", "section_heading");
