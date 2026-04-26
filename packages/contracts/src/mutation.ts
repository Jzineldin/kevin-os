/**
 * Phase 8 / Plan 08-00 — Mutation pathway event + DB-row schemas (AGT-08).
 *
 * Three exported Zod schemas covering the imperative-verb pipeline:
 *   - PendingMutationProposedSchema — emitted by mutation-proposer
 *   - PendingMutationApprovedSchema — emitted by dashboard-api Approve route
 *   - PendingMutationExecutedSchema — emitted by mutation-executor
 *
 * Plus the MutationTypeEnum that unifies all 6 mutation kinds. The proposer
 * is intentionally restrictive — it emits proposals only; the dashboard
 * Approve gate is the only path that can promote a proposed mutation to an
 * executed one (no auto-archive, ever — even at confidence==1.0).
 */
import { z } from 'zod';

const UlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// --- The six mutation kinds --------------------------------------------
//
// Naming convention: <verb>_<resource_kind>. All are archive-not-delete.
//   - cancel_meeting       → calendar_events_cache.ignored_by_kevin = true
//   - delete_task          → command_center page set to status=archived
//                            (Notion archive flag flipped, NOT page delete)
//   - archive_doc          → document reference flipped to archived; the
//                            underlying S3 object is retained for the
//                            life of the bucket retention policy
//   - cancel_content_draft → content_drafts.status = 'cancelled'
//   - cancel_email_draft   → email_drafts.status   = 'cancelled' (Phase 4
//                            email_drafts table; mutation-executor also
//                            consumes any matching email_send_authorizations
//                            so the row is no longer Approve-eligible)
//   - reschedule_meeting   → annotation-only on calendar_events_cache. KOS
//                            does NOT write to Google Calendar — calendar-
//                            reader is read-only. The annotation surfaces in
//                            the dashboard so Kevin can do the actual GCal
//                            edit himself.
export const MutationTypeEnum = z.enum([
  'cancel_meeting',
  'delete_task',
  'archive_doc',
  'cancel_content_draft',
  'cancel_email_draft',
  'reschedule_meeting',
]);
export type MutationType = z.infer<typeof MutationTypeEnum>;

// Target-ref kind enum kept in sync with MutationTypeEnum (every kind has
// at least one mutation_type that targets it). `id` is resource-specific:
//   - meeting        → calendar_events_cache.event_id (text, GCal id)
//   - task           → Notion page id (text)
//   - content_draft  → content_drafts.id (uuid)
//   - email_draft    → email_drafts.id (uuid)
//   - document       → document_versions.id (uuid) OR a plain doc reference
const TargetKindEnum = z.enum([
  'meeting',
  'task',
  'content_draft',
  'email_draft',
  'document',
]);

const TargetRefSchema = z.object({
  kind: TargetKindEnum,
  id: z.string(),
  display: z.string().max(400),
});

// --- AGT-08 Step 3: proposer publishes a candidate mutation ------------
//
// Emitted on kos.output after Sonnet 4.6 resolves a target ref. The
// proposer always writes a row to pending_mutations BEFORE emitting; the
// emit is best-effort (the dashboard polls on a separate path too).
//
// `confidence` is the Sonnet self-rated confidence in the target. The
// proposer surfaces alternatives only when confidence < 0.85 OR multiple
// matches scored within 0.05 of the top hit (D-26 — disambig threshold).
export const PendingMutationProposedSchema = z.object({
  mutation_id: z.string().uuid(),
  capture_id: z.string().regex(UlidRegex),
  mutation_type: MutationTypeEnum,
  target_ref: TargetRefSchema,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(2000),
  proposed_at: z.string().datetime(),
  alternatives: z
    .array(
      z.object({
        target_ref: z.object({
          kind: z.string(),
          id: z.string(),
          display: z.string(),
        }),
        confidence: z.number(),
      }),
    )
    .max(5)
    .optional(),
});
export type PendingMutationProposed = z.infer<typeof PendingMutationProposedSchema>;

// --- AGT-08 Step 4: Kevin approves (and optionally picks an alternative) ---
//
// Emitted by dashboard-api Approve route. `selected_target_ref` is set ONLY
// when the proposal carried alternatives AND Kevin clicked an alternative
// (rather than the primary). When omitted, mutation-executor uses the
// primary target_ref from the pending_mutations row.
export const PendingMutationApprovedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  mutation_id: z.string().uuid(),
  authorization_id: z.string().uuid(),
  selected_target_ref: z
    .object({
      kind: z.string(),
      id: z.string(),
      display: z.string(),
    })
    .optional(),
  approved_at: z.string().datetime(),
});
export type PendingMutationApproved = z.infer<typeof PendingMutationApprovedSchema>;

// --- AGT-08 Step 5: mutation-executor publishes the outcome ------------
//
// Emitted on kos.output after the archive-not-delete operation completes
// (or fails). `result`:
//   - archived     → row's status flipped successfully
//   - rescheduled  → reschedule_meeting annotation written
//   - no_op        → target was already in the desired state (idempotent)
//   - failed       → DB / Notion error; `error` populated
export const PendingMutationExecutedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  mutation_id: z.string().uuid(),
  result: z.enum(['archived', 'rescheduled', 'no_op', 'failed']),
  error: z.string().max(2000).nullable(),
  executed_at: z.string().datetime(),
});
export type PendingMutationExecuted = z.infer<typeof PendingMutationExecutedSchema>;
