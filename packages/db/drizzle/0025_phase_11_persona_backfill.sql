-- Phase 11 persona backfill: populate entity_index from entity-resolver's
-- audit trail on agent_runs.
--
-- Context: the entity-resolver has been running for weeks, pushing every
-- mentioned name to a Notion "Entity Inbox" page for manual promotion.
-- That manual step was never wired, so entity_index stayed empty and the
-- dashboard's /entities page shows "No entities yet." This migration takes
-- the D-17 pragmatic shortcut: auto-create entity_index rows from the
-- agent_runs signal, let Kevin review/prune manually in Notion.
--
-- Approach:
--   1. Extract unique mention_texts from entity-resolver runs.
--   2. Filter out pronouns, tools, platforms, self-references (NOISE).
--   3. Heuristic-classify into person|organization.
--   4. INSERT into entity_index with aggregated seed context + last_touch.
--   5. Backfill mention_events from agent_runs for the timeline.
--
-- Idempotent: INSERT ... ON CONFLICT (notion_page_id) DO NOTHING where the
-- notion_page_id is a synthesized placeholder
-- 'backfill-<sha256(owner_id + lower(name))>'. Replay is a no-op.
-- When an entity is eventually promoted to a real Notion page, the
-- notion-indexer's UPSERT will overwrite the placeholder on the same row
-- (keyed by id, not notion_page_id, but name collision is avoided since
-- placeholders are prefixed).

BEGIN;

WITH
  raw_mentions AS (
    SELECT
      NULLIF(trim(split_part(agent_name, ':', 2)), '') AS raw_name,
      finished_at,
      capture_id,
      output_json
    FROM agent_runs
    WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
      AND agent_name LIKE 'entity-resolver:%'
      AND status = 'ok'
  ),
  dedup AS (
    SELECT
      lower(raw_name) AS name_key,
      (array_agg(raw_name ORDER BY
         (CASE WHEN raw_name = initcap(raw_name) THEN 0 ELSE 1 END),
         length(raw_name) DESC
      ))[1] AS canonical_name,
      COUNT(*) AS mention_count,
      MAX(finished_at) AS last_touched,
      MIN(finished_at) AS first_seen
    FROM raw_mentions
    WHERE raw_name IS NOT NULL
      AND length(raw_name) >= 2
      AND lower(raw_name) NOT IN (
        'kevin','jag','mig','min fru','mitt team','fru','team','vi',
        'tale forge','taleforge','tailforge','outbehaving',
        'notion','whatsapp','linkedin','google cloud','google workspace',
        'microsoft azure','azure','aws','cursor','canva','postiz',
        'supabase','superbase','sentry','datadog','twilio','roblox',
        'claude cowork','claude sonnet 4.7','gpt','chatgpt','lovable',
        'loveable','storytel','storybird','monday','cloud',
        'grundskoleutmaningen','internship-annons','freelance software/ai engineer',
        'cassel-ramverket','google image 2.5 flash','11 labs','posthog',
        'google forms','google credits','ionos','bmc','eic accelerator',
        'giant','howlingna energy','innovativa startups','uf',
        'khan academy kids','mindmirror','mind mirror','science park',
        'tailforge content hub','almi science park','speed',
        'gau consulting','gau ventures','hive and five','hirebetter'
      )
    GROUP BY lower(raw_name)
  ),
  classified AS (
    SELECT
      name_key,
      canonical_name,
      mention_count,
      last_touched,
      first_seen,
      CASE
        WHEN canonical_name ~ '^[A-ZÅÄÖÉ][a-zåäö]+$'
             AND lower(canonical_name) IN (
               'damien','christina','marcus','monika','monica','jonas',
               'linus','adam','tom','emma','simon','robin','quinten',
               'julius','anton','susanne','peter','magnus','kristina',
               'sara','sofia','silvia','jesper','kian','patricia',
               'nazeem','sarah','jerry','camille','joanna','abel',
               'javier','jonathan','tomas','charlotte',
               'johan','anna','jennie','maria'
             )
          THEN 'person'
        WHEN canonical_name ~ '^[A-ZÅÄÖÉ][a-zåäö]+ +[A-ZÅÄÖÉ][a-zåäö]+$'
          THEN 'person'
        WHEN canonical_name ~ '^[A-ZÅÄÖÉ][A-Za-zåäö]+$'
          THEN 'organization'
        ELSE 'organization'
      END AS inferred_type
    FROM dedup
  )

INSERT INTO entity_index
  (owner_id, notion_page_id, name, aliases, type, relationship, status, seed_context,
   last_touch, confidence, source, notion_last_edited_time, updated_at)
SELECT
  '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  'backfill-' || encode(sha256(('7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c/' || c.name_key)::bytea), 'hex'),
  c.canonical_name,
  ARRAY[c.canonical_name]::text[],
  c.inferred_type,
  'unknown',
  'active',
  format(
    'Backfilled from entity-resolver audit trail (%s mentions between %s and %s).',
    c.mention_count,
    to_char(c.first_seen AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD'),
    to_char(c.last_touched AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD')
  ),
  c.last_touched,
  50,
  ARRAY['backfill:agent_runs']::text[],
  c.last_touched,
  now()
FROM classified c
ON CONFLICT (notion_page_id) DO NOTHING;

-- Backfill mention_events for the per-entity timeline on the dossier page.
INSERT INTO mention_events
  (owner_id, entity_id, capture_id, source, context, occurred_at, created_at)
SELECT
  '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid,
  e.id,
  COALESCE(r.output_json->>'capture_id', r.capture_id, 'backfill-' || r.finished_at::text),
  'entity-resolver:backfill',
  format('Mentioned as "%s" in a voice memo, email, or transcript',
         COALESCE(r.output_json->>'mention_text', split_part(r.agent_name, ':', 2))),
  r.finished_at,
  now()
FROM agent_runs r
  JOIN entity_index e
    ON e.owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
   AND lower(e.name) = lower(trim(split_part(r.agent_name, ':', 2)))
WHERE r.owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
  AND r.agent_name LIKE 'entity-resolver:%'
  AND r.status = 'ok'
ON CONFLICT DO NOTHING;

SELECT 'entities_total' AS metric, COUNT(*)::text AS value
  FROM entity_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
UNION ALL
SELECT 'by_type::' || type, COUNT(*)::text
  FROM entity_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
  GROUP BY type
UNION ALL
SELECT 'mention_events_total', COUNT(*)::text
  FROM mention_events
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid;

COMMIT;
