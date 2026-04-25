-- Phase 7 / Plan 07-00 — top3_membership + dropped_threads_v.
--
-- Why: morning-brief / day-close / weekly-review render a "Top 3" section
-- (D-05). Each Top-3 row is recorded here so the NEXT brief can surface any
-- entity that landed in a previous Top 3 but has not been acted on within
-- 24h ("dropped threads"). The trigger below auto-clears acted_on_at when a
-- mention_events row arrives for the same entity, so dropped-thread
-- detection becomes a single SELECT against dropped_threads_v.
--
-- Composition: dropped_threads_v joins top3_membership + entity_index +
-- mention_events directly. Phase 6's entity_timeline_mv is NOT joined —
-- this view is intentionally standalone so refreshes of the timeline MV
-- don't gate brief rendering.
--
-- Migration number: 0014. Phase 4 reserves 0013 per D-14 next-available
-- collision guard. If at execution time a different migration occupies
-- 0014, bump to the next free integer (mirror Plan 04-00 precedent).

-- top3_membership ---------------------------------------------------------
--
-- One row per (brief, entity) pair. Each brief's Top-3 fan-out writes 1..3
-- rows with the same brief_capture_id; entity_id references entity_index.
-- acted_on_at is NULL at insertion; the trigger below stamps it when the
-- next mention_events arrives for the same (owner, entity) pair after the
-- membered_at time.
CREATE TABLE IF NOT EXISTS "top3_membership" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"          uuid        NOT NULL,
  "brief_date"        date        NOT NULL,                                      -- Stockholm calendar date
  "brief_kind"        text        NOT NULL CHECK (brief_kind IN ('morning-brief','day-close','weekly-review')),
  "brief_capture_id"  text        NOT NULL,                                      -- ULID of the brief run
  "entity_id"         uuid        NOT NULL REFERENCES "entity_index"("id") ON DELETE CASCADE,
  "top3_title"        text        NOT NULL,
  "urgency"           text        NOT NULL CHECK (urgency IN ('high','med','low')),
  "membered_at"       timestamptz NOT NULL DEFAULT now(),
  "acted_on_at"       timestamptz                                                -- NULL until a matching mention_events arrives
);

-- Lookup-by-owner-date is the morning-brief / day-close hot path.
CREATE INDEX IF NOT EXISTS "top3_membership_by_owner_date"
  ON "top3_membership" ("owner_id", "brief_date");

-- Trigger updates need a fast lookup by (owner, entity).
CREATE INDEX IF NOT EXISTS "top3_membership_by_entity"
  ON "top3_membership" ("entity_id");

-- Partial index over pending rows speeds the dropped-threads scan.
CREATE INDEX IF NOT EXISTS "top3_membership_pending"
  ON "top3_membership" ("owner_id", "brief_date")
  WHERE "acted_on_at" IS NULL;

-- dropped_threads_v -------------------------------------------------------
--
-- Surfaces Top-3 entities that:
--   1. landed in a brief within the last 7 Stockholm-calendar days,
--   2. have not been acted on (acted_on_at IS NULL),
--   3. either have NO matching mention_events row, OR the most recent
--      mention is older than 24h ago.
--
-- Morning-brief queries:
--   SELECT * FROM dropped_threads_v
--   WHERE owner_id = $1 AND detected_for_date = $2::date
--   ORDER BY last_mentioned_at DESC NULLS LAST LIMIT 5;
CREATE OR REPLACE VIEW "dropped_threads_v" AS
SELECT
  tm.owner_id,
  tm.brief_date AS membered_on,
  (CURRENT_DATE AT TIME ZONE 'Europe/Stockholm')::date AS detected_for_date,
  tm.entity_id,
  ei.name AS entity_name,
  tm.top3_title AS title,
  tm.urgency,
  MAX(me.occurred_at) AS last_mentioned_at,
  MAX(tm.acted_on_at) AS last_acted_on_at
FROM "top3_membership" tm
JOIN "entity_index" ei ON ei.id = tm.entity_id
LEFT JOIN "mention_events" me
  ON me.entity_id = tm.entity_id AND me.owner_id = tm.owner_id
WHERE tm.acted_on_at IS NULL
  AND tm.brief_date >= (CURRENT_DATE AT TIME ZONE 'Europe/Stockholm' - INTERVAL '7 days')::date
GROUP BY tm.owner_id, tm.brief_date, tm.entity_id, ei.name, tm.top3_title, tm.urgency
HAVING MAX(me.occurred_at) IS NULL
    OR MAX(me.occurred_at) < (NOW() - INTERVAL '24 hours');

-- mark_top3_acted_on trigger ---------------------------------------------
--
-- When a mention_events row is inserted for (owner_id, entity_id), stamp
-- acted_on_at on every pending top3_membership row for the same pair where:
--   - membered_at < NEW.occurred_at (don't backfill rows added after the
--     mention),
--   - brief_date is within the last 7 Stockholm-calendar days from the
--     mention's day (mirrors the dropped_threads_v window).
CREATE OR REPLACE FUNCTION mark_top3_acted_on() RETURNS trigger AS $$
BEGIN
  IF NEW.entity_id IS NULL THEN
    RETURN NEW;
  END IF;
  UPDATE "top3_membership"
     SET "acted_on_at" = NOW()
   WHERE "owner_id" = NEW.owner_id
     AND "entity_id" = NEW.entity_id
     AND "acted_on_at" IS NULL
     AND "membered_at" < NEW.occurred_at
     AND "brief_date" >= (NEW.occurred_at AT TIME ZONE 'Europe/Stockholm')::date - INTERVAL '7 days';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_top3_acted_on ON "mention_events";
CREATE TRIGGER trg_mark_top3_acted_on
  AFTER INSERT ON "mention_events"
  FOR EACH ROW EXECUTE FUNCTION mark_top3_acted_on();
