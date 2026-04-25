-- Migration 0009 — Phase 3 Plan 03-01 Task 1: LISTEN/NOTIFY triggers for SSE fan-out.
--
-- Per 03-CONTEXT.md D-25: SSE payloads are POINTER-ONLY (kind + id + ts,
-- plus entity_id for timeline_event). The browser reconciles by calling
-- /api/<kind>/<id> to fetch full state. This stays under the 8 KB NOTIFY cap
-- and keeps SSE transport trivially cacheable.
--
-- Per RESEARCH §11 (lines 1042-1044) caveat: the "one function with TG_ARGV +
-- CASE-in-EXECUTE" pattern is NOT valid PL/pgSQL. We use FOUR DISTINCT
-- FUNCTIONS here; each trigger maps 1:1 to a function with a static 'kind'
-- string embedded.
--
-- 4 triggers installed:
--   trg_inbox_notify         AFTER INSERT ON inbox_index              → kind='inbox_item'
--   trg_entity_merge_notify  AFTER UPDATE OF state ON entity_merge_audit → kind='entity_merge' (only when state flips to 'complete')
--   trg_mention_notify       AFTER INSERT ON mention_events           → kind='timeline_event' (includes entity_id)
--   trg_agent_run_notify     AFTER INSERT ON agent_runs               → kind='capture_ack' | 'draft_ready' (conditional on agent_name)
--
-- Reversibility: DROP TRIGGER + DROP FUNCTION (bottom of file).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. inbox_index INSERT → kind='inbox_item'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_inbox_item() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('kos_output', json_build_object(
    'kind', 'inbox_item',
    'id',   NEW.id,
    'ts',   to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. entity_merge_audit UPDATE state → 'complete' → kind='entity_merge'
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_entity_merge() RETURNS trigger AS $$
BEGIN
  IF NEW.state = 'complete' AND OLD.state IS DISTINCT FROM 'complete' THEN
    PERFORM pg_notify('kos_output', json_build_object(
      'kind',      'entity_merge',
      'id',        NEW.merge_id,
      'entity_id', NEW.target_entity_id::text,
      'ts',        to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. mention_events INSERT → kind='timeline_event' (entity_id included)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_timeline_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('kos_output', json_build_object(
    'kind',      'timeline_event',
    'id',        NEW.id::text,
    'entity_id', NEW.entity_id::text,
    'ts',        to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4. agent_runs INSERT → kind='capture_ack' | 'draft_ready' (status='ok' only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_agent_run() RETURNS trigger AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.status <> 'ok' THEN
    RETURN NEW;
  END IF;

  v_kind := CASE
    WHEN NEW.agent_name = 'voice-capture'                            THEN 'capture_ack'
    WHEN NEW.agent_name IN ('email-triage-draft','email-triage')     THEN 'draft_ready'
    ELSE NULL
  END;

  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_notify('kos_output', json_build_object(
    'kind', v_kind,
    'id',   NEW.id::text,
    'ts',   to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Trigger definitions (drop-if-exists so migration is idempotent)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_inbox_notify        ON inbox_index;
DROP TRIGGER IF EXISTS trg_entity_merge_notify ON entity_merge_audit;
DROP TRIGGER IF EXISTS trg_mention_notify      ON mention_events;
DROP TRIGGER IF EXISTS trg_agent_run_notify    ON agent_runs;

CREATE TRIGGER trg_inbox_notify
  AFTER INSERT ON inbox_index
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_item();

CREATE TRIGGER trg_entity_merge_notify
  AFTER UPDATE OF state ON entity_merge_audit
  FOR EACH ROW EXECUTE FUNCTION notify_entity_merge();

CREATE TRIGGER trg_mention_notify
  AFTER INSERT ON mention_events
  FOR EACH ROW EXECUTE FUNCTION notify_timeline_event();

CREATE TRIGGER trg_agent_run_notify
  AFTER INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION notify_agent_run();

COMMIT;
