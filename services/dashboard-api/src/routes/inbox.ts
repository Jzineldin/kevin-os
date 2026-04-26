/**
 * Phase 4 Plan 04-05 — Merged Inbox route handler.
 *
 * GET /inbox-merged — returns the union of:
 *   - email_drafts rows in status 'draft' / 'edited'
 *     (Plan 04-04 producer; Phase 3 inbox `kind: 'draft_reply'` renderer
 *     activates downstream)
 *   - agent_dead_letter rows where retried_at IS NULL
 *     (Phase 4 D-24; Phase 3 inbox `kind: 'dead_letter'` renderer)
 *   - the existing GET /inbox payload (inbox_index `kind: 'entity_routing'`
 *     etc — the Phase 3 sources stay unchanged)
 *
 * Mounted as a new path (`/inbox-merged` rather than overwriting
 * `/inbox`) so the existing Phase 3 inbox handler + tests stay green.
 * Dashboard switches its merged-inbox client to this path; the legacy
 * /inbox stays available for any integration that hasn't migrated.
 *
 * The response shape unions the Phase 3 inbox_item shape (kind +
 * id + title + preview + ...) with the new draft_reply / dead_letter
 * minimum projection. Dashboard's existing `kind`-discriminated
 * renderer fans out the right component.
 */
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import {
  listInboxDrafts,
  listInboxDeadLetters,
} from '../email-drafts-persist.js';

interface MergedItemDraft {
  kind: 'draft_reply';
  id: string;
  capture_id: string;
  from: string;
  subject: string;
  body_preview: string;
  classification: string;
  status: string;
  received_at: string;
}

interface MergedItemDeadLetter {
  kind: 'dead_letter';
  id: string;
  capture_id: string;
  tool_name: string;
  error_class: string;
  error: string;
  occurred_at: string;
}

type MergedItem = MergedItemDraft | MergedItemDeadLetter;

export async function mergedInboxHandler(_ctx: Ctx): Promise<RouteResponse> {
  const db = await getDb();
  let drafts;
  let deadLetters;
  try {
    [drafts, deadLetters] = await Promise.all([
      listInboxDrafts(db, 50),
      listInboxDeadLetters(db, 50),
    ]);
  } catch (err) {
    // Pre-Phase-4 deploy (tables not migrated) → return [] rather than 500.
    // The existing /inbox endpoint still serves the Phase 3 sources.
    // eslint-disable-next-line no-console
    console.warn('[dashboard-api] /inbox-merged degraded — Phase 4 tables unavailable', err);
    return {
      statusCode: 200,
      body: JSON.stringify({ items: [] }),
      headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=5' },
    };
  }

  const draftItems: MergedItemDraft[] = drafts.map((d) => ({
    kind: 'draft_reply',
    id: d.draft_id,
    capture_id: d.capture_id,
    from: d.from_email,
    subject: d.draft_subject ?? d.subject ?? '',
    body_preview: (d.draft_body ?? '').slice(0, 400),
    classification: d.classification,
    status: d.status,
    received_at: d.received_at,
  }));

  const deadLetterItems: MergedItemDeadLetter[] = deadLetters.map((x) => ({
    kind: 'dead_letter',
    id: x.id,
    capture_id: x.capture_id,
    tool_name: x.tool_name,
    error_class: x.error_class,
    error: x.error_message.slice(0, 400),
    occurred_at: x.occurred_at,
  }));

  // Sort by timestamp DESC — drafts use received_at, dead-letters use
  // occurred_at; both are ISO 8601 strings so lexicographic compare works.
  const items: MergedItem[] = [...draftItems, ...deadLetterItems].sort((a, b) => {
    const ta = a.kind === 'draft_reply' ? a.received_at : a.occurred_at;
    const tb = b.kind === 'draft_reply' ? b.received_at : b.occurred_at;
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1;
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ items }),
    headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=5' },
  };
}

register('GET', '/inbox-merged', mergedInboxHandler);
