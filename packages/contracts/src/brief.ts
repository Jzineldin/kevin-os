/**
 * @kos/contracts/brief — Phase 7 brief tool_use contracts.
 *
 * These Zod schemas are the load-bearing structured-output shapes Sonnet 4.6
 * returns to the morning-brief / day-close / weekly-review Lambdas via
 * Bedrock `tool_use` (D-05). Each Lambda forces tool_choice to a single named
 * tool and validates the tool input with the matching schema; on parse
 * failure the Lambda falls back to a safe minimal brief and emits
 * `kos.system / brief.generation_failed` for operator visibility.
 *
 * The shapes are also consumed by `services/_shared/brief-renderer.ts` to
 * render Notion blocks (🏠 Today + Daily Brief Log) and the single Telegram
 * HTML message emitted on `kos.output / output.push`.
 *
 * Constraints enforced here (per 07-CONTEXT D-05):
 *   - prose_summary cap: 600 chars (morning, day-close), 1000 chars (weekly).
 *   - top_three: max 3 items per brief; each item ≤ 200 chars title.
 *   - dropped_threads: max 5 items per brief.
 *   - calendar_today / _tomorrow: max 20 events each (defensive).
 *   - drafts_ready: max 10 items.
 *   - active_threads_delta / _snapshot: max 10 / 20 items.
 *
 * No runtime side effects.
 */
import { z } from 'zod';

// ULID shape (26 chars, Crockford base32 excluding I L O U). Matches
// events.ts exactly so brief envelopes interoperate with capture_id.
const UlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// -- Building blocks ------------------------------------------------------

// The LLM often returns non-UUID placeholders for entity_ids (especially
// when entity_index is empty and it has nothing to reference). Rather than
// rejecting the whole brief when that happens — which drops the top-three
// list entirely — preprocess the array to keep only valid UUIDs. This
// mirrors what the persistence layer does at fan-out time anyway.
const UuidArraySchema = z.preprocess((v) => {
  if (!Array.isArray(v)) return v;
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return v.filter((x) => typeof x === 'string' && uuidRegex.test(x));
}, z.array(z.string().uuid()).max(5));

/**
 * Flexible datetime schema — accepts:
 *   - Full ISO-8601 ("2026-04-28T10:00:00Z")
 *   - Date-only ("2026-04-28") — normalized to "YYYY-MM-DDT00:00:00.000Z"
 *   - Space-separated ("2026-04-28 10:00:00Z") — space replaced with 'T'
 *
 * The LLM regularly emits one of the loose forms for fields like
 * `last_mentioned_at` (DroppedThread) and BriefCalendarEvent.start/end;
 * prior strict `z.string().datetime()` caused the entire brief to fall
 * back to the empty shell (observed 2026-04-28: Zod validation failed;
 * returning safe fallback). Coercion is lossless in the common cases
 * and fails the same way on genuinely unparseable input.
 */
const FlexibleDatetimeSchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  // Date-only → midnight UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  // Space separator → T separator
  const withT = s.replace(' ', 'T');
  // If it already parses as a Date, round-trip to ISO
  const d = new Date(withT);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return v;
}, z.string().datetime());

export const TopThreeItemSchema = z.object({
  title: z.string().min(1).max(200),
  entity_ids: UuidArraySchema,
  urgency: z.enum(['high', 'med', 'low']),
});
export type TopThreeItem = z.infer<typeof TopThreeItemSchema>;

export const DroppedThreadSchema = z.object({
  title: z.string().min(1).max(200),
  entity_ids: UuidArraySchema,
  last_mentioned_at: FlexibleDatetimeSchema.optional(),
});
export type DroppedThread = z.infer<typeof DroppedThreadSchema>;

// Renamed from `CalendarEventSchema` to avoid a barrel collision with
// dashboard.ts (Phase 3) which already exports `CalendarEventSchema` /
// `CalendarEvent` for the dashboard upcoming-events panel.
export const BriefCalendarEventSchema = z.object({
  start: FlexibleDatetimeSchema,
  end: FlexibleDatetimeSchema.optional(),
  title: z.string().min(1).max(200),
  attendees: z.array(z.string()).max(10).optional(),
});
export type BriefCalendarEvent = z.infer<typeof BriefCalendarEventSchema>;

export const DraftReadyListItemSchema = z.object({
  draft_id: z.string().uuid(),
  from: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  classification: z.enum(['urgent', 'important']),
});
export type DraftReadyListItem = z.infer<typeof DraftReadyListItemSchema>;

// -- Common base ----------------------------------------------------------

// Both morning-brief and day-close share Top 3 + dropped-threads + prose
// summary. WeeklyReview has its own shape (no Top 3 / no dropped_threads —
// weekly cadence renders a recap + next-week candidates instead).
export const BriefCommonFieldsSchema = z.object({
  prose_summary: z.string().min(1).max(600),
  top_three: z.array(TopThreeItemSchema).min(0).max(3),
  dropped_threads: z.array(DroppedThreadSchema).max(5),
});
export type BriefCommonFields = z.infer<typeof BriefCommonFieldsSchema>;

// -- MorningBrief (AUTO-01) ----------------------------------------------

export const MorningBriefSchema = BriefCommonFieldsSchema.extend({
  calendar_today: z.array(BriefCalendarEventSchema).max(20).default([]),
  calendar_tomorrow: z.array(BriefCalendarEventSchema).max(20).default([]),
  drafts_ready: z.array(DraftReadyListItemSchema).max(10).default([]),
});
export type MorningBrief = z.infer<typeof MorningBriefSchema>;

// -- DayCloseBrief (AUTO-03) ---------------------------------------------

export const SlippedItemSchema = z.object({
  title: z.string().min(1).max(200),
  entity_ids: UuidArraySchema,
  reason: z.string().max(200).optional(),
});
export type SlippedItem = z.infer<typeof SlippedItemSchema>;

export const ActiveThreadDeltaSchema = z.object({
  thread: z.string().min(1).max(200),
  status: z.enum(['new', 'updated', 'closed']),
});
export type ActiveThreadDelta = z.infer<typeof ActiveThreadDeltaSchema>;

export const DayCloseBriefSchema = BriefCommonFieldsSchema.extend({
  slipped_items: z.array(SlippedItemSchema).max(5),
  recent_decisions: z.array(z.string().max(200)).max(5),
  active_threads_delta: z.array(ActiveThreadDeltaSchema).max(10),
});
export type DayCloseBrief = z.infer<typeof DayCloseBriefSchema>;

// -- WeeklyReview (AUTO-04) ----------------------------------------------

export const WeeklyReviewBolagSchema = z.enum([
  'almi',
  'speed',
  'tale-forge',
  'outbehaving',
  'other',
]);
export type WeeklyReviewBolag = z.infer<typeof WeeklyReviewBolagSchema>;

export const ActiveThreadSnapshotSchema = z.object({
  thread: z.string().min(1).max(200),
  where: WeeklyReviewBolagSchema,
  status: z.string().max(200),
});
export type ActiveThreadSnapshot = z.infer<typeof ActiveThreadSnapshotSchema>;

export const NextWeekCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  why: z.string().min(1).max(200),
});
export type NextWeekCandidate = z.infer<typeof NextWeekCandidateSchema>;

export const WeeklyReviewSchema = z.object({
  prose_summary: z.string().min(1).max(1000),
  week_recap: z.array(z.string().min(1).max(240)).max(10),
  next_week_candidates: z.array(NextWeekCandidateSchema).max(7),
  active_threads_snapshot: z.array(ActiveThreadSnapshotSchema).max(20),
});
export type WeeklyReview = z.infer<typeof WeeklyReviewSchema>;

// -- Envelope wrapping brief output for agent_runs storage ---------------

export const BriefKindSchema = z.enum(['morning-brief', 'day-close', 'weekly-review']);
export type BriefKind = z.infer<typeof BriefKindSchema>;

export const BriefAgentRunOutputSchema = z.object({
  brief_kind: BriefKindSchema,
  brief_capture_id: z.string().regex(UlidRegex),
  rendered_at: FlexibleDatetimeSchema,
  data: z.union([MorningBriefSchema, DayCloseBriefSchema, WeeklyReviewSchema]),
});
export type BriefAgentRunOutput = z.infer<typeof BriefAgentRunOutputSchema>;
