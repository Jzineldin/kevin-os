/**
 * @kos/service-azure-search-indexer-daily-brief — Phase 6 MEM-03.
 *
 * Scheduler: every 30 min (briefs are lower-write-rate than transcripts).
 * Indexes morning-brief + day-close + weekly-review Lambda outputs (Phase 7)
 * into Azure Search with source='daily_brief'. Reads agent_runs WHERE
 * agent_name IN ('morning-brief', 'day-close', 'weekly-review').
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { upsertDocuments } from '@kos/azure-search';
import { getPool, readCursor, writeCursor } from './common.js';

const CURSOR_KEY = 'azure-indexer-daily-brief';
const BATCH_SIZE = 50;
const BRIEF_AGENTS = ['morning-brief', 'day-close', 'weekly-review'];

export const handler = wrapHandler(async () => {
  await initSentry();
  tagTraceWithCaptureId(`azure-indexer-daily-brief-${new Date().toISOString()}`);

  const pool = await getPool();
  const cursor = await readCursor(pool, CURSOR_KEY);

  const { rows } = await pool.query<{
    capture_id: string;
    agent_name: string;
    context: {
      brief_body?: string;
      date?: string;
      top_priorities?: string[];
      slipped_items?: string[];
    };
    created_at: Date;
  }>(
    `SELECT capture_id, agent_name, context, created_at
       FROM agent_runs
      WHERE agent_name = ANY($1::text[])
        AND status     = 'ok'
        AND created_at > $2
      ORDER BY created_at ASC
      LIMIT $3`,
    [BRIEF_AGENTS, cursor ?? new Date(0), BATCH_SIZE],
  );

  if (rows.length === 0) return { read: 0, upserted: 0, errors: 0, cursor };

  const batch = rows.map((r) => {
    const ctx = r.context ?? {};
    const title = `${r.agent_name} ${ctx.date ?? r.created_at.toISOString().slice(0, 10)}`;
    const body = ctx.brief_body ?? '';
    const priorities = (ctx.top_priorities ?? []).join(' · ');
    const slipped = (ctx.slipped_items ?? []).join(' · ');
    return {
      id: `brief:${r.capture_id}`,
      source: 'daily_brief' as const,
      title,
      snippet: body.slice(0, 600),
      content_for_embedding: [title, body, priorities, slipped]
        .filter(Boolean)
        .join(' | '),
      entity_ids: [],
      indexed_at: r.created_at.toISOString(),
    };
  });

  const res = await upsertDocuments({ documents: batch });
  const newCursor = rows[rows.length - 1]!.created_at;
  await writeCursor(pool, CURSOR_KEY, newCursor);

  return {
    read: rows.length,
    upserted: res.succeeded,
    errors: res.failed,
    cursor: newCursor.toISOString(),
  };
});
