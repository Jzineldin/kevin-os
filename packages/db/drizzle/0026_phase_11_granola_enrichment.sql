-- Phase 11 granola enrichment: mop up ghost-owner mention_events the
-- first pass (migration 0023) missed, and link granola-transcript
-- mentions to the now-populated entity_index (migration 0025).
--
-- Context:
--   Migration 0023 missed ~336 mention_events rows that still lived
--   under the ghost owner_id '9e4be978-...'. Either the UPDATE failed
--   silently or new rows were re-emitted after the first pass. This
--   migration sweeps them again (idempotent — a zero-row UPDATE on a
--   clean DB).
--
--   After 0025 created 43 backfilled entities, the ~334 granola-
--   transcript mention_events are in the right owner_id but still have
--   entity_id=NULL — the transcript-extractor doesn't set entity_id
--   when it writes (see services/transcript-extractor/src/persist.ts:192).
--   We link them now via a name-match against entity_index.

BEGIN;

-- A) Ghost-owner sweep (mention_events).
UPDATE mention_events
   SET owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 WHERE owner_id = '9e4be978-cc7d-571b-98ec-a1e92373682c'::uuid;

-- B) Link granola-transcript mentions to entities by name match.
--
-- transcript-extractor writes context in two shapes:
--   '<Name> — inbox=<page-id>'            (when the name resolved to an
--                                          existing entity inbox page)
--   '<Name>: <quoted sentence>'           (when the name is in-line)
-- Extract the leading name token (everything before the first ' — ' OR
-- ': ') and match case-insensitively against entity_index.name.
UPDATE mention_events m
   SET entity_id = e.id
  FROM entity_index e
 WHERE m.owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
   AND e.owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
   AND m.entity_id IS NULL
   AND m.source = 'granola-transcript'
   AND split_part(split_part(m.context, '—', 1), ':', 1)
         ~* ('^\s*' || e.name || '\s*$');

-- Report
SELECT source,
       COUNT(*) AS total,
       COUNT(entity_id) AS with_entity
  FROM mention_events
 WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
 GROUP BY source
 ORDER BY total DESC;

COMMIT;
