/**
 * Aggregate entity corpus — gather EVERY row related to the requested
 * entities, stitch into one huge markdown corpus for Vertex Gemini 1M-ctx.
 *
 * Rough budget: 4 chars/token → 800k tokens ≈ 3.2M chars. We truncate at
 * 3M chars (≈750k tokens) to leave headroom for Gemini system prompt +
 * output budget.
 */
import type { Pool as PgPool } from 'pg';

const MAX_CHARS = 3_000_000;

export interface AggregatedCorpus {
  markdown: string;
  chars: number;
  sections: number;
  truncated: boolean;
}

export async function aggregateEntityCorpus(opts: {
  pool: PgPool;
  ownerId: string;
  entityIds: string[];
  maxTokens: number;
}): Promise<AggregatedCorpus> {
  const { pool, ownerId, entityIds } = opts;
  const parts: string[] = [];

  // 1. Entity dossier rows.
  const entities = await pool.query(
    `SELECT entity_id, name, type, aliases, org, role, relationship, status,
            seed_context, last_touch, manual_notes, confidence, source
       FROM entity_index
      WHERE owner_id = $1 AND entity_id = ANY($2::uuid[])`,
    [ownerId, entityIds],
  );
  for (const e of entities.rows) {
    parts.push(`# Entity: ${e.name} (${e.type})`);
    parts.push(`- entity_id: ${e.entity_id}`);
    if (e.aliases?.length) parts.push(`- aliases: ${e.aliases.join(', ')}`);
    if (e.org) parts.push(`- org: ${e.org}`);
    if (e.role) parts.push(`- role: ${e.role}`);
    if (e.relationship) parts.push(`- relationship: ${e.relationship}`);
    if (e.status) parts.push(`- status: ${e.status}`);
    if (e.last_touch) parts.push(`- last_touch: ${e.last_touch}`);
    if (e.seed_context) parts.push(`\n## Seed context\n${e.seed_context}`);
    if (e.manual_notes) parts.push(`\n## Manual notes\n${e.manual_notes}`);
    parts.push('');
  }

  // 2. Mention events (last 6 months).
  const mentions = await pool.query(
    `SELECT entity_id, capture_id, kind, occurred_at, excerpt, metadata
       FROM mention_events
      WHERE owner_id = $1
        AND entity_id = ANY($2::uuid[])
        AND occurred_at > now() - interval '6 months'
      ORDER BY occurred_at DESC
      LIMIT 2000`,
    [ownerId, entityIds],
  );
  if (mentions.rows.length > 0) {
    parts.push(`# Mention events (last 6 months — ${mentions.rows.length} rows)`);
    for (const m of mentions.rows) {
      parts.push(
        `- [${m.occurred_at.toISOString()}] ${m.kind} (entity=${m.entity_id}, capture=${m.capture_id})`,
      );
      if (m.excerpt) parts.push(`  > ${m.excerpt.slice(0, 500)}`);
    }
    parts.push('');
  }

  // 3. transcript-extractor agent_runs touching these entities.
  const runs = await pool.query(
    `SELECT capture_id, agent_name, context, created_at
       FROM agent_runs
      WHERE owner_id = $1
        AND agent_name IN ('transcript-extractor', 'entity-resolver', 'email-triage', 'morning-brief', 'day-close')
        AND status = 'ok'
        AND created_at > now() - interval '6 months'
      ORDER BY created_at DESC
      LIMIT 500`,
    [ownerId],
  );
  if (runs.rows.length > 0) {
    parts.push(`# Agent runs (last 6 months — ${runs.rows.length} rows)`);
    for (const r of runs.rows) {
      parts.push(
        `- [${r.created_at.toISOString()}] ${r.agent_name} (capture=${r.capture_id})`,
      );
      if (r.context?.summary) parts.push(`  > ${String(r.context.summary).slice(0, 600)}`);
    }
    parts.push('');
  }

  const joined = parts.join('\n');
  const truncated = joined.length > MAX_CHARS;
  const markdown = truncated
    ? `${joined.slice(0, MAX_CHARS)}\n\n[TRUNCATED ${joined.length - MAX_CHARS} chars]`
    : joined;

  return {
    markdown,
    chars: markdown.length,
    sections: parts.filter((p) => p.startsWith('# ')).length,
    truncated,
  };
}
