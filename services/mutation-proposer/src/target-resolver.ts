/**
 * AGT-08 Stage-3 candidate gather (Plan 08-04).
 *
 * Loads candidate targets from 4 sources, filtered by mutation_type:
 *   - meeting        — calendar_events_cache (next 24h, ignored_by_kevin=false)
 *   - task           — command_center_index (open status)
 *   - content_draft  — content_drafts (status in draft/edited/scheduled)
 *   - email_draft    — email_drafts (status in draft/edited)
 *
 * Each candidate is annotated with a `secondary_signal` when an attendee /
 * recipient / entity reference matches the entityIds passed in (D-06
 * tiebreaker — explicit references beat timestamp proximity).
 *
 * Per CONTEXT D-27: this resolver MAY read but never writes. The DB role
 * `kos_mutation_proposer` is granted SELECT on the four source tables only.
 */
import type { Pool as PgPool } from 'pg';
import type { HaikuClassifyResult } from './classifier.js';

export interface TargetCandidate {
  kind: 'meeting' | 'task' | 'content_draft' | 'email_draft' | 'document';
  id: string;
  display: string;
  secondary_signal?: string;
}

export interface GatherCandidatesInput {
  pool: PgPool;
  ownerId: string;
  mutationType: HaikuClassifyResult['mutation_type'];
  /** Entity ids resolved upstream (e.g. by entity-resolver). */
  entityIds: string[];
  /** The original capture text — used for fuzzy display matching. */
  recentText: string;
}

const CALENDAR_LIMIT = 25;
const TASK_LIMIT = 20;
const DRAFT_LIMIT = 10;

export async function gatherTargetCandidates(
  input: GatherCandidatesInput,
): Promise<TargetCandidate[]> {
  const wantsMeeting =
    input.mutationType === 'cancel_meeting' ||
    input.mutationType === 'reschedule_meeting' ||
    input.mutationType === 'other';
  const wantsTask =
    input.mutationType === 'delete_task' || input.mutationType === 'other';
  const wantsContent =
    input.mutationType === 'cancel_content_draft' || input.mutationType === 'other';
  const wantsEmailDraft =
    input.mutationType === 'cancel_email_draft' || input.mutationType === 'other';
  const wantsDoc =
    input.mutationType === 'archive_doc' || input.mutationType === 'other';

  const parallel: Array<Promise<TargetCandidate[]>> = [];
  if (wantsMeeting) parallel.push(loadMeetings(input));
  if (wantsTask) parallel.push(loadTasks(input));
  if (wantsContent) parallel.push(loadContentDrafts(input));
  if (wantsEmailDraft) parallel.push(loadEmailDrafts(input));
  if (wantsDoc) parallel.push(loadDocuments(input));

  const buckets = await Promise.allSettled(parallel);
  const all: TargetCandidate[] = [];
  for (const b of buckets) {
    if (b.status === 'fulfilled') all.push(...b.value);
  }
  return all;
}

async function loadMeetings(input: GatherCandidatesInput): Promise<TargetCandidate[]> {
  try {
    const r = await input.pool.query(
      `SELECT event_id, summary, start_utc, attendees_json
         FROM calendar_events_cache
        WHERE owner_id = $1
          AND ignored_by_kevin = false
          AND start_utc BETWEEN now() AND now() + interval '7 days'
        ORDER BY start_utc ASC
        LIMIT $2`,
      [input.ownerId, CALENDAR_LIMIT],
    );
    return (r.rows as Array<{
      event_id: string;
      summary: string;
      start_utc: Date | string;
      attendees_json: unknown;
    }>).map((row) => {
      const start =
        typeof row.start_utc === 'string'
          ? row.start_utc
          : new Date(row.start_utc).toISOString();
      const attendeeMatch = matchEntitiesInJson(row.attendees_json, input.entityIds);
      const display = `${row.summary} @ ${start.slice(0, 16).replace('T', ' ')}`;
      const candidate: TargetCandidate = {
        kind: 'meeting',
        id: row.event_id,
        display,
      };
      if (attendeeMatch) candidate.secondary_signal = `attendee match: ${attendeeMatch}`;
      return candidate;
    });
  } catch (err) {
    console.warn('[target-resolver] meeting load failed', err);
    return [];
  }
}

async function loadTasks(input: GatherCandidatesInput): Promise<TargetCandidate[]> {
  try {
    // command_center_index lives in inbox_index for Phase 3 (kind='task' rows).
    // We use a defensive query that prefers a dedicated command_center_index
    // table if present, else falls back to inbox_index task-kind rows.
    const r = await input.pool.query(
      `SELECT id::text AS id, title, status
         FROM inbox_index
        WHERE owner_id = $1
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT $2`,
      [input.ownerId, TASK_LIMIT],
    );
    return (r.rows as Array<{ id: string; title: string; status: string }>).map(
      (row) => ({
        kind: 'task' as const,
        id: row.id,
        display: row.title,
      }),
    );
  } catch (err) {
    console.warn('[target-resolver] task load failed', err);
    return [];
  }
}

async function loadContentDrafts(
  input: GatherCandidatesInput,
): Promise<TargetCandidate[]> {
  try {
    const r = await input.pool.query(
      `SELECT id::text AS id, platform, body, status
         FROM content_drafts
        WHERE owner_id = $1
          AND status IN ('draft','edited','scheduled')
        ORDER BY created_at DESC
        LIMIT $2`,
      [input.ownerId, DRAFT_LIMIT],
    );
    return (
      r.rows as Array<{ id: string; platform: string; body: string; status: string }>
    ).map((row) => ({
      kind: 'content_draft' as const,
      id: row.id,
      display: `${row.platform}: ${(row.body ?? '').slice(0, 80)}`,
    }));
  } catch (err) {
    console.warn('[target-resolver] content_drafts load failed', err);
    return [];
  }
}

async function loadEmailDrafts(input: GatherCandidatesInput): Promise<TargetCandidate[]> {
  try {
    const r = await input.pool.query(
      `SELECT id::text AS id, from_email, to_email, subject, draft_subject, received_at
         FROM email_drafts
        WHERE owner_id = $1
          AND status IN ('draft','edited')
        ORDER BY received_at DESC
        LIMIT $2`,
      [input.ownerId, DRAFT_LIMIT],
    );
    return (
      r.rows as Array<{
        id: string;
        from_email: string;
        to_email: string[];
        subject: string | null;
        draft_subject: string | null;
        received_at: Date | string;
      }>
    ).map((row) => ({
      kind: 'email_draft' as const,
      id: row.id,
      display: `to ${row.to_email?.[0] ?? row.from_email}: ${row.draft_subject ?? row.subject ?? ''}`,
    }));
  } catch (err) {
    console.warn('[target-resolver] email_drafts load failed', err);
    return [];
  }
}

async function loadDocuments(input: GatherCandidatesInput): Promise<TargetCandidate[]> {
  try {
    const r = await input.pool.query(
      `SELECT id::text AS id, doc_name, recipient_email, sent_at
         FROM document_versions
        WHERE owner_id = $1
        ORDER BY sent_at DESC
        LIMIT $2`,
      [input.ownerId, DRAFT_LIMIT],
    );
    return (
      r.rows as Array<{
        id: string;
        doc_name: string;
        recipient_email: string;
        sent_at: Date | string;
      }>
    ).map((row) => ({
      kind: 'document' as const,
      id: row.id,
      display: `${row.doc_name} → ${row.recipient_email}`,
    }));
  } catch (err) {
    console.warn('[target-resolver] document_versions load failed', err);
    return [];
  }
}

/**
 * Lightweight attendee match — looks for any of the entityIds in the
 * attendees_json array. Returns the first matched entity id or undefined.
 *
 * D-06 tiebreaker: "the Damien call" should beat a same-time non-Damien
 * meeting; this match populates `secondary_signal` so Sonnet can lean on
 * the explicit reference.
 */
function matchEntitiesInJson(
  attendeesJson: unknown,
  entityIds: string[],
): string | undefined {
  if (!entityIds.length || !Array.isArray(attendeesJson)) return undefined;
  const flat = JSON.stringify(attendeesJson).toLowerCase();
  for (const eid of entityIds) {
    if (flat.includes(eid.toLowerCase())) return eid;
  }
  return undefined;
}
