import type { Pool } from 'pg';
import { hybridScore, resolveStage, type Stage } from './score.js';

// IMPORTANT: inline SQL string literal. Keep byte-identical with packages/resolver/docs/candidates.sql
// (reference doc). Do NOT readFileSync a sibling .sql — KosLambda uses esbuild which does not bundle
// .sql siblings by default, which would cause runtime ENOENT in Lambda.
export const CANDIDATE_SQL = `
-- Returns top 20 candidates by hybrid score.
-- Params: $1 = mention text (lower-cased by caller), $2 = owner_id uuid, $3 = embedding vector(1024) text form '[0.1,0.2,...]'
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
`;

export interface Candidate {
  id: string;
  name: string;
  aliases: string[];
  linkedProjects: string[];
  type: string;
  role: string | null;
  org: string | null;
  lastTouch: Date | null;
  trigramScore: number;
  cosineScore: number;
  hybridScore: number;
  stage: Stage;
}

export interface FindCandidatesInput {
  mention: string; // raw text, will be lower-cased
  ownerId: string; // uuid
  embedding: number[]; // 1024-dim; cosine-ready
  limit?: number; // defaults to 20
}

export async function findCandidates(pool: Pool, input: FindCandidatesInput): Promise<Candidate[]> {
  if (input.embedding.length !== 1024) {
    throw new Error(`embedding must be 1024-dim, got ${input.embedding.length}`);
  }
  const mention = input.mention.toLowerCase().trim();
  if (mention.length === 0) return [];
  const vectorLit = `[${input.embedding.join(',')}]`;
  const res = await pool.query(CANDIDATE_SQL, [mention, input.ownerId, vectorLit]);
  return res.rows.map((row) => {
    const trigramScore = Number(row.trigram_score);
    const cosineScore = Number(row.cosine_score);
    // Defense in depth: recompute hybridScore in JS so any SQL drift is caught by tests.
    const hybrid = hybridScore(trigramScore, cosineScore);
    return {
      id: String(row.id),
      name: String(row.name),
      aliases: row.aliases ?? [],
      linkedProjects: row.linked_projects ?? [],
      type: String(row.type),
      role: row.role ?? null,
      org: row.org ?? null,
      lastTouch: row.last_touch ?? null,
      trigramScore,
      cosineScore,
      hybridScore: hybrid,
      stage: resolveStage(hybrid),
    };
  });
}

/**
 * D-11 secondary signal: project co-occurrence for > 0.95 auto-merge gate.
 * Returns true iff candidate.linkedProjects shares at least one project_id
 * with the current capture's project mentions.
 */
export function hasProjectCooccurrence(candidate: Candidate, captureProjectIds: string[]): boolean {
  if (captureProjectIds.length === 0) return false;
  const cp = new Set(captureProjectIds);
  return candidate.linkedProjects.some((p) => cp.has(p));
}
