/**
 * notion_indexer_cursor accessor for db_kind='transkripten' (Plan 06-01 D-02).
 *
 * Mirrors the Phase 1 notion-indexer cursor shape: rows are keyed by
 * `db_id` (PK) but selected by `db_kind` since the operator may rotate the
 * Transkripten DB id without rewriting the row. First-run hydration:
 * if a row exists with the placeholder owner_id (`00000000-...`), bind it
 * to the supplied ownerId once.
 *
 * Cursor advance carries a -1 minute safety margin per RESEARCH §6 to
 * account for Notion's minute-granularity `last_edited_time` boundaries.
 */
import type { Pool as PgPool } from 'pg';

export interface CursorRow {
  dbId: string;
  lastCursorAt: Date;
}

const PLACEHOLDER_OWNER = '00000000-0000-0000-0000-000000000000';
const PLACEHOLDER_DB_ID = 'PLACEHOLDER_TRANSKRIPTEN_DB_ID';
const FIRST_RUN_BACKLOG_HOURS = 24;

/**
 * Read (or self-seed) the transkripten cursor row.
 *
 * Self-seeding rules:
 *   - If no row exists, INSERT with `now() - 24h` so the first poll picks up
 *     the prior-day backlog without crushing Notion API quotas (D-02).
 *   - If the row's owner_id is the placeholder UUID, UPDATE it to ownerId
 *     (one-time hydration after migration 0012 lays down the blank row).
 *   - If db_id is the placeholder sentinel, throw an actionable error
 *     pointing at the operator runbook.
 */
export async function getCursor(pool: PgPool, ownerId: string): Promise<CursorRow> {
  // 1. Try to read.
  const r = await pool.query<{ db_id: string; last_cursor_at: Date; owner_id: string }>(
    `SELECT db_id, last_cursor_at, owner_id
       FROM notion_indexer_cursor
      WHERE db_kind = 'transkripten'
      ORDER BY last_run_at DESC NULLS LAST
      LIMIT 1`,
  );

  if ((r.rowCount ?? 0) === 0) {
    // No row yet — self-seed with the placeholder db_id and now()-24h cursor.
    // Operator MUST update db_id post-deploy (deferred-items.md).
    const seedAt = new Date(Date.now() - FIRST_RUN_BACKLOG_HOURS * 3600_000);
    await pool.query(
      `INSERT INTO notion_indexer_cursor (db_id, db_kind, owner_id, last_cursor_at, last_run_at)
            VALUES ($1, 'transkripten', $2, $3, NOW())
       ON CONFLICT (db_id) DO NOTHING`,
      [PLACEHOLDER_DB_ID, ownerId, seedAt],
    );
    throw new Error(
      `getCursor: notion_indexer_cursor for db_kind='transkripten' has placeholder db_id. ` +
        `Run \`node scripts/discover-notion-dbs.mjs --db transkripten\` then ` +
        `\`UPDATE notion_indexer_cursor SET db_id='<real-id>' WHERE db_kind='transkripten' AND db_id='${PLACEHOLDER_DB_ID}';\``,
    );
  }

  const row = r.rows[0]!;

  // 2. Placeholder db_id detected — refuse to query Notion with sentinel.
  if (row.db_id === PLACEHOLDER_DB_ID) {
    throw new Error(
      `getCursor: notion_indexer_cursor.db_id is still the placeholder sentinel. ` +
        `Run \`node scripts/discover-notion-dbs.mjs --db transkripten\` and ` +
        `\`UPDATE notion_indexer_cursor SET db_id='<real-id>' WHERE db_kind='transkripten';\``,
    );
  }

  // 3. Hydrate placeholder owner_id once.
  if (row.owner_id === PLACEHOLDER_OWNER) {
    await pool.query(
      `UPDATE notion_indexer_cursor SET owner_id = $1 WHERE db_id = $2`,
      [ownerId, row.db_id],
    );
  }

  return {
    dbId: row.db_id,
    lastCursorAt: row.last_cursor_at,
  };
}

/**
 * Advance the cursor for db_kind='transkripten'. The caller MUST pass
 * `max(last_edited_time over batch) - 1 minute` to handle Notion's
 * minute-granularity boundary (RESEARCH §6 caveat 1).
 */
export async function advanceCursor(
  pool: PgPool,
  ownerId: string,
  newCursor: Date,
): Promise<void> {
  await pool.query(
    `UPDATE notion_indexer_cursor
        SET last_cursor_at = $1,
            last_run_at    = NOW(),
            last_error     = NULL
      WHERE db_kind = 'transkripten' AND owner_id = $2`,
    [newCursor, ownerId],
  );
}
