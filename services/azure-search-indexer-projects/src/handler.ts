/**
 * @kos/service-azure-search-indexer-projects — Phase 6 MEM-03.
 *
 * Scheduler: every 10 min. Indexes `project_index` rows (Notion Projects DB
 * mirror) into Azure Search with source='project'.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { upsertDocuments } from '@kos/azure-search';
import { getPool, readCursor, writeCursor } from './common.js';

const CURSOR_KEY = 'azure-indexer-projects';
const BATCH_SIZE = 50;

export const handler = wrapHandler(async () => {
  await initSentry();
  tagTraceWithCaptureId(`azure-indexer-projects-${new Date().toISOString()}`);

  const pool = await getPool();
  const cursor = await readCursor(pool, CURSOR_KEY);

  // CR-04: project_index PK column is `id` (see packages/db/src/schema.ts:76
  // and migration 0001:38). Alias `id AS project_id` so downstream code and
  // the Azure document id (`project:${r.project_id}`) remain stable.
  const { rows } = await pool.query<{
    project_id: string;
    name: string;
    bolag: string | null;
    status: string | null;
    description: string | null;
    seed_context: string | null;
    updated_at: Date;
  }>(
    `SELECT id AS project_id, name, bolag, status, description, seed_context, updated_at
       FROM project_index
      WHERE updated_at > $1
      ORDER BY updated_at ASC
      LIMIT $2`,
    [cursor ?? new Date(0), BATCH_SIZE],
  );

  if (rows.length === 0) return { read: 0, upserted: 0, errors: 0, cursor };

  const batch = rows.map((r) => ({
    id: `project:${r.project_id}`,
    source: 'project' as const,
    title: `${r.name}${r.bolag ? ` · ${r.bolag}` : ''}`,
    snippet: (r.description ?? r.seed_context ?? '').slice(0, 600),
    content_for_embedding: [
      r.name,
      r.bolag,
      r.status,
      r.description,
      r.seed_context,
    ]
      .filter(Boolean)
      .join(' | '),
    entity_ids: [],
    indexed_at: r.updated_at.toISOString(),
  }));

  const res = await upsertDocuments({ documents: batch });
  const newCursor = rows[rows.length - 1]!.updated_at;
  await writeCursor(pool, CURSOR_KEY, newCursor);

  return {
    read: rows.length,
    upserted: res.succeeded,
    errors: res.failed,
    cursor: newCursor.toISOString(),
  };
});
