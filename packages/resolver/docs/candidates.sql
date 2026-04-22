-- Returns top 20 candidates by hybrid score.
-- Params: $1 = mention text (lower-cased by caller), $2 = owner_id uuid, $3 = embedding vector(1024) text form '[0.1,0.2,...]'
--
-- REFERENCE DOC ONLY — the executable SQL lives as a template literal in
-- packages/resolver/src/candidates.ts (export `CANDIDATE_SQL`). esbuild (used by
-- KosLambda) does not bundle sibling .sql siblings by default, which would
-- cause runtime ENOENT in Lambda. Keep this file byte-identical with the
-- template literal so diffs + EXPLAIN plans remain readable.
WITH trigram_candidates AS (
  SELECT ei.id,
         GREATEST(
           similarity(LOWER(ei.name), $1),
           COALESCE((SELECT MAX(similarity(LOWER(a), $1)) FROM UNNEST(ei.aliases) a), 0)
         ) AS trigram_score
  FROM entity_index ei
  WHERE ei.owner_id = $2
    AND (
      LOWER(ei.name) % $1
      OR EXISTS (SELECT 1 FROM UNNEST(ei.aliases) a WHERE LOWER(a) % $1)
    )
  ORDER BY trigram_score DESC
  LIMIT 50
),
vector_candidates AS (
  SELECT ei.id,
         1 - (ei.embedding <=> $3::vector) AS cosine_score
  FROM entity_index ei
  WHERE ei.owner_id = $2
    AND ei.embedding IS NOT NULL
  ORDER BY ei.embedding <=> $3::vector
  LIMIT 50
)
SELECT ei.id,
       ei.name,
       ei.aliases,
       ei.linked_projects,
       ei.type,
       ei.role,
       ei.org,
       ei.last_touch,
       COALESCE(tc.trigram_score, 0)::float AS trigram_score,
       COALESCE(vc.cosine_score, 0)::float AS cosine_score,
       GREATEST(
         0.6 * COALESCE(tc.trigram_score, 0),
         0.6 * COALESCE(vc.cosine_score, 0),
         0.3 * COALESCE(tc.trigram_score, 0) + 0.7 * COALESCE(vc.cosine_score, 0)
       )::float AS hybrid_score
FROM entity_index ei
LEFT JOIN trigram_candidates tc ON tc.id = ei.id
LEFT JOIN vector_candidates vc ON vc.id = ei.id
WHERE (tc.id IS NOT NULL OR vc.id IS NOT NULL)
  AND ei.owner_id = $2
ORDER BY hybrid_score DESC
LIMIT 20;
