/**
 * Phase 7 Plan 07-01 — hot-entities query.
 *
 * D-17: morning-brief picks the top 10 entities by mention_events count in the
 * last 48h. These IDs are passed to loadContext() as the entityIds list so
 * the brief gets full dossier awareness for the entities Kevin actually
 * interacted with — not every entity in the graph.
 *
 * Excludes mention rows where entity_id IS NULL (those are unresolved
 * captures). owner_id always filtered.
 */
import type { Pool as PgPool } from 'pg';

export interface HotEntity {
  entity_id: string;
  name: string;
  mention_count: number;
}

export async function loadHotEntities(
  pool: PgPool,
  ownerId: string,
  hoursBack: number,
  limit: number,
): Promise<HotEntity[]> {
  const r = await pool.query(
    `SELECT me.entity_id, ei.name, count(*) AS mention_count
       FROM mention_events me
       JOIN entity_index ei ON ei.id = me.entity_id
      WHERE me.owner_id = $1
        AND me.entity_id IS NOT NULL
        AND me.occurred_at > now() - ($2::int * interval '1 hour')
      GROUP BY me.entity_id, ei.name
      ORDER BY count(*) DESC
      LIMIT $3`,
    [ownerId, hoursBack, limit],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    entity_id: String(row.entity_id),
    name: String(row.name),
    mention_count: Number(row.mention_count),
  }));
}
