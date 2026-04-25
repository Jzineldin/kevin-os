/**
 * @kos/service-azure-search-indexer-transcripts — Phase 6 MEM-03.
 *
 * Scheduler: every 10 min. Indexes transcript-extractor outputs into Azure
 * Search with source='transcript'. Reads from agent_runs WHERE
 * agent_name='transcript-extractor', pulling context.summary + mentioned
 * entity list for searchable chunks.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { upsertDocuments } from '@kos/azure-search';
import { getPool, readCursor, writeCursor } from './common.js';

const CURSOR_KEY = 'azure-indexer-transcripts';
const BATCH_SIZE = 30;

export const handler = wrapHandler(async () => {
  await initSentry();
  tagTraceWithCaptureId(`azure-indexer-transcripts-${new Date().toISOString()}`);

  const pool = await getPool();
  const cursor = await readCursor(pool, CURSOR_KEY);

  // CR-03: agent_runs schema has `output_json` (jsonb) and `started_at`
  // (timestamptz) — NOT `context` or `created_at` (which never existed).
  // See packages/db/src/schema.ts:114,121 and the migration 0012 SQL
  // comment explicitly calling out this contract.
  const { rows } = await pool.query<{
    capture_id: string;
    owner_id: string;
    output_json: {
      transcript_id?: string;
      title?: string | null;
      summary?: string;
      decisions?: string[];
      open_questions?: string[];
    } | null;
    started_at: Date;
  }>(
    `SELECT capture_id, owner_id, output_json, started_at
       FROM agent_runs
      WHERE agent_name = 'transcript-extractor'
        AND status     = 'ok'
        AND started_at > $1
      ORDER BY started_at ASC
      LIMIT $2`,
    [cursor ?? new Date(0), BATCH_SIZE],
  );

  if (rows.length === 0) return { read: 0, upserted: 0, errors: 0, cursor };

  const batch = rows.map((r) => {
    const ctx = r.output_json ?? {};
    const title = ctx.title ?? `Transcript ${ctx.transcript_id ?? r.capture_id}`;
    const decisions = (ctx.decisions ?? []).join(' · ');
    const questions = (ctx.open_questions ?? []).join(' · ');
    const snippet = ctx.summary?.slice(0, 600) ?? '';
    return {
      id: `transcript_${ctx.transcript_id ?? r.capture_id}`,
      source: 'transcript' as const,
      title,
      snippet,
      content_for_embedding: [title, snippet, decisions, questions]
        .filter(Boolean)
        .join(' | '),
      entity_ids: [],
      indexed_at: r.started_at.toISOString(),
    };
  });

  const res = await upsertDocuments({ documents: batch });
  const newCursor = rows[rows.length - 1]!.started_at;
  await writeCursor(pool, CURSOR_KEY, newCursor);

  return {
    read: rows.length,
    upserted: res.succeeded,
    errors: res.failed,
    cursor: newCursor.toISOString(),
  };
});
