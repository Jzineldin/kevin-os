-- Phase 11 Plan 11-01: kos_chat IAM role for the kos-chat Lambda.
--
-- Creates the role if it doesn't exist, then grants the minimum privilege set
-- needed by the Lambda (CRUD on its own tables, SELECT on shared read-only
-- tables for entity lookups, INSERT on event_log for mutation audit trail).
--
-- RDS IAM auth: Lambda must have `rds-db:connect` on the `kos_chat` DB user
-- (granted in CDK via CfnDBCluster IAM policy — see agents-stack wiring).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    CREATE ROLE kos_chat;
  END IF;
END $$;

-- Allow IAM auth.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT rds_iam TO kos_chat';
  END IF;
END $$;

-- chat_sessions + chat_messages: full CRUD.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON chat_sessions TO kos_chat';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO kos_chat';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE chat_messages_id_seq TO kos_chat';
  END IF;
END $$;

-- Read-only access to entity_index for hot-entity context loading.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT SELECT ON entity_index TO kos_chat';
  END IF;
END $$;

-- Read-only access to email_drafts for search_emails tool.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT SELECT ON email_drafts TO kos_chat';
  END IF;
END $$;

-- INSERT on event_log for mutation audit trail (tool-use writes).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT INSERT ON event_log TO kos_chat';
  END IF;
END $$;

-- INSERT/UPDATE on entity_dossiers_cached (synthesize endpoint reuse).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT INSERT, UPDATE ON entity_dossiers_cached TO kos_chat';
  END IF;
END $$;

-- Kevin Context page cache read.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_chat') THEN
    EXECUTE 'GRANT SELECT ON notion_indexer_cursor TO kos_chat';
  END IF;
END $$;
