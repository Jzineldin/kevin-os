/**
 * Dossier cache — Postgres-backed (per 06-CONTEXT.md D-17; NOT ElastiCache).
 *
 * Keyed by (entity_id, last_touch_hash). Invalidated by the migration-0012
 * trigger `trg_entity_dossiers_cached_invalidate` which deletes the cache
 * row on any `mention_events` insert referencing the entity.
 *
 * The `last_touch_hash` column lets us detect stale cache entries even if
 * the trigger misses a write path (defense-in-depth).
 */
import { createHash } from 'node:crypto';
import type { Pool as PgPool } from 'pg';
import type { ContextBundle } from '@kos/contracts/context';

export interface DossierCacheRow {
  entity_id: string;
  owner_id: string;
  last_touch_hash: string;
  bundle: ContextBundle;
  created_at: Date;
  expires_at: Date;
}

/**
 * Compute a stable hash of an entity's "touch state" — name, last_touch
 * timestamp, recent-mentions-count. Invalidates cache when any of these
 * change without waiting on the trigger.
 */
export function computeLastTouchHash(input: {
  name: string;
  last_touch: string | null;
  recent_mention_count: number;
}): string {
  const h = createHash('sha256');
  h.update(input.name);
  h.update('|');
  h.update(input.last_touch ?? '');
  h.update('|');
  h.update(String(input.recent_mention_count));
  return h.digest('hex').slice(0, 16);
}

export async function readDossierCache(opts: {
  pool: PgPool;
  ownerId: string;
  entityIds: string[];
}): Promise<Map<string, DossierCacheRow>> {
  const { pool, ownerId, entityIds } = opts;
  if (entityIds.length === 0) return new Map();

  const { rows } = await pool.query<DossierCacheRow>(
    `SELECT entity_id, owner_id, last_touch_hash, bundle, created_at, expires_at
       FROM entity_dossiers_cached
      WHERE owner_id = $1
        AND entity_id = ANY($2::uuid[])
        AND expires_at > now()`,
    [ownerId, entityIds],
  );

  return new Map(rows.map((r) => [r.entity_id, r]));
}

export async function writeDossierCache(opts: {
  pool: PgPool;
  ownerId: string;
  entityId: string;
  lastTouchHash: string;
  bundle: ContextBundle;
  ttlSeconds?: number;
}): Promise<void> {
  const { pool, ownerId, entityId, lastTouchHash, bundle, ttlSeconds = 3600 } = opts;
  await pool.query(
    `INSERT INTO entity_dossiers_cached
           (entity_id, owner_id, last_touch_hash, bundle, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)
      ON CONFLICT (entity_id, owner_id) DO UPDATE
         SET last_touch_hash = EXCLUDED.last_touch_hash,
             bundle          = EXCLUDED.bundle,
             expires_at      = EXCLUDED.expires_at`,
    [entityId, ownerId, lastTouchHash, JSON.stringify(bundle), ttlSeconds],
  );
}

export async function invalidateDossierCache(opts: {
  pool: PgPool;
  ownerId: string;
  entityIds: string[];
}): Promise<void> {
  const { pool, ownerId, entityIds } = opts;
  if (entityIds.length === 0) return;
  await pool.query(
    `DELETE FROM entity_dossiers_cached
      WHERE owner_id = $1
        AND entity_id = ANY($2::uuid[])`,
    [ownerId, entityIds],
  );
}
