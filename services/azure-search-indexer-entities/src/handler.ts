/**
 * @kos/service-azure-search-indexer-entities — Phase 6 MEM-03.
 *
 * Scheduler: every 10 min (EventBridge Scheduler).
 *
 * Reads entities updated since last cursor from `entity_index`, embeds via
 * Cohere v4, upserts into Azure Search index `kos-memory` with
 * source='entity'. Idempotent on entity_id; merge-or-upload preserves
 * indexed_at on first write.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { upsertDocuments } from '@kos/azure-search';
import { getPool, readCursor, writeCursor } from './common.js';

const CURSOR_KEY = 'azure-indexer-entities';
const BATCH_SIZE = 50;

export const handler = wrapHandler(async (): Promise<{
  read: number;
  upserted: number;
  errors: number;
  cursor: string | null;
}> => {
  await initSentry();
  tagTraceWithCaptureId(`azure-indexer-entities-${new Date().toISOString()}`);

  const pool = await getPool();
  const cursor = await readCursor(pool, CURSOR_KEY);

  const { rows } = await pool.query<{
    entity_id: string;
    name: string;
    aliases: string[] | null;
    type: string;
    org: string | null;
    role: string | null;
    seed_context: string | null;
    manual_notes: string | null;
    updated_at: Date;
  }>(
    `SELECT entity_id, name, aliases, type, org, role, seed_context, manual_notes, updated_at
       FROM entity_index
      WHERE updated_at > $1
      ORDER BY updated_at ASC
      LIMIT $2`,
    [cursor ?? new Date(0), BATCH_SIZE],
  );

  if (rows.length === 0) {
    return { read: 0, upserted: 0, errors: 0, cursor };
  }

  const batch = rows.map((r) => {
    const snippet = [r.seed_context, r.manual_notes].filter(Boolean).join(' · ').slice(0, 600);
    const aliasStr = r.aliases?.join(', ') ?? '';
    const contentForEmbedding = [
      r.name,
      r.type,
      r.org,
      r.role,
      aliasStr,
      snippet,
    ]
      .filter(Boolean)
      .join(' | ');
    return {
      id: `entity:${r.entity_id}`,
      source: 'entity' as const,
      title: `${r.name}${r.type ? ` (${r.type})` : ''}`,
      snippet: snippet || `${r.name}${r.org ? ` @ ${r.org}` : ''}${r.role ? ` — ${r.role}` : ''}`,
      content_for_embedding: contentForEmbedding,
      entity_ids: [r.entity_id],
      indexed_at: r.updated_at.toISOString(),
    };
  });

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
