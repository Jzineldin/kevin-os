/**
 * Archive-not-delete applier (Plan 08-04 Task 2).
 *
 * Per Locked Decision #12 (CLAUDE.md "Reversibility — everything
 * reversible"): every mutation flips a status field; nothing is removed
 * from the DB. Operator can restore by flipping the same field back.
 *
 * Per CONTEXT D-17: KOS does NOT write to Google Calendar. cancel_meeting
 * flips calendar_events_cache.ignored_by_kevin → true; reschedule_meeting
 * is a NOTE-ONLY mutation (Kevin must move the event in Google manually).
 */
import type { Pool as PgPool } from 'pg';
import type { Client as NotionClient } from '@notionhq/client';
import { archiveCommandCenterRow } from './notion.js';

export type ApplyMutationResult =
  | { result: 'archived'; error?: never; emit?: { detailType: string; payload: unknown } }
  | { result: 'rescheduled'; error?: string }
  | { result: 'no_op'; error?: string }
  | { result: 'failed'; error: string };

export interface ApplyMutationArgs {
  pool: PgPool;
  ownerId: string;
  captureId: string;
  mutation_type: string;
  target_kind: string;
  target_id: string;
  /** Optional Notion client — only required for delete_task mutations. */
  notion?: NotionClient | null;
}

export async function applyMutation(
  args: ApplyMutationArgs,
): Promise<ApplyMutationResult> {
  try {
    switch (args.mutation_type) {
      case 'cancel_meeting':
        return await applyCancelMeeting(args);
      case 'reschedule_meeting':
        return await applyRescheduleMeeting(args);
      case 'delete_task':
        return await applyDeleteTask(args);
      case 'cancel_content_draft':
        return await applyCancelContentDraft(args);
      case 'cancel_email_draft':
        return await applyCancelEmailDraft(args);
      case 'archive_doc':
        // v1: document_versions is append-only metadata. Future enhancement
        // would add an `archived_at` column + UPDATE here.
        return {
          result: 'no_op',
          error: 'archive_doc v1 not implemented — document_versions is append-only metadata',
        };
      default:
        return { result: 'failed', error: `unknown mutation_type ${args.mutation_type}` };
    }
  } catch (err) {
    return { result: 'failed', error: String(err) };
  }
}

async function applyCancelMeeting(args: ApplyMutationArgs): Promise<ApplyMutationResult> {
  // calendar_events_cache PK is (event_id, account); we may have multiple
  // accounts but the same event_id is unique-per-account. UPDATE both rows
  // (idempotent — UPDATE matches whatever exists).
  const r = await args.pool.query(
    `UPDATE calendar_events_cache
        SET ignored_by_kevin = true
      WHERE event_id = $1 AND owner_id = $2
      RETURNING event_id`,
    [args.target_id, args.ownerId],
  );
  if (!r.rowCount) {
    return { result: 'failed', error: 'target_not_found:calendar_events_cache' };
  }
  return { result: 'archived' };
}

async function applyRescheduleMeeting(args: ApplyMutationArgs): Promise<ApplyMutationResult> {
  // Per D-17: KOS has NO Google Calendar write scope. We flip the old
  // event to ignored_by_kevin=true so it disappears from the dashboard,
  // and surface a note that Kevin must do the actual GCal move himself.
  const r = await args.pool.query(
    `UPDATE calendar_events_cache
        SET ignored_by_kevin = true
      WHERE event_id = $1 AND owner_id = $2
      RETURNING event_id`,
    [args.target_id, args.ownerId],
  );
  if (!r.rowCount) {
    return { result: 'failed', error: 'target_not_found:calendar_events_cache' };
  }
  return {
    result: 'rescheduled',
    error:
      'reschedule noted; Kevin must move the event in Google Calendar manually (D-17 — no write scope)',
  };
}

async function applyDeleteTask(args: ApplyMutationArgs): Promise<ApplyMutationResult> {
  // Phase 3 inbox_index is the DB-side mirror of the Notion Command Center
  // (services/voice-capture writes both). Flip the row to status=archived.
  const r = await args.pool.query(
    `UPDATE inbox_index
        SET status = 'archived',
            archived_at = now()
      WHERE id = $1::uuid AND owner_id = $2
      RETURNING notion_page_id, title`,
    [args.target_id, args.ownerId],
  );
  if (!r.rowCount) {
    return { result: 'failed', error: 'target_not_found:inbox_index' };
  }

  // Notion update — best-effort. If the Notion call fails the DB row is
  // already archived, so the dashboard reflects archive immediately; the
  // failed Notion update is logged for operator follow-up.
  const notionPageId = r.rows[0].notion_page_id as string | null;
  const origTitle = (r.rows[0].title as string) ?? '';
  if (args.notion && notionPageId) {
    try {
      await archiveCommandCenterRow(args.notion, { pageId: notionPageId, origTitle });
    } catch (err) {
      console.warn('[mutation-executor] notion archive failed', err);
    }
  }
  return { result: 'archived' };
}

async function applyCancelContentDraft(args: ApplyMutationArgs): Promise<ApplyMutationResult> {
  const r = await args.pool.query(
    `UPDATE content_drafts
        SET status = 'cancelled'
      WHERE id = $1::uuid AND owner_id = $2
      RETURNING id, capture_id`,
    [args.target_id, args.ownerId],
  );
  if (!r.rowCount) {
    return { result: 'failed', error: 'target_not_found:content_drafts' };
  }
  return {
    result: 'archived',
    emit: {
      detailType: 'content.cancel_requested',
      payload: {
        capture_id: args.captureId,
        draft_id: args.target_id,
        requested_at: new Date().toISOString(),
      },
    },
  };
}

async function applyCancelEmailDraft(args: ApplyMutationArgs): Promise<ApplyMutationResult> {
  const r = await args.pool.query(
    `UPDATE email_drafts
        SET status = 'cancelled'
      WHERE id = $1::uuid AND owner_id = $2
      RETURNING id, capture_id`,
    [args.target_id, args.ownerId],
  );
  if (!r.rowCount) {
    return { result: 'failed', error: 'target_not_found:email_drafts' };
  }
  return { result: 'archived' };
}
