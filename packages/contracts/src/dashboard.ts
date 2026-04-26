/**
 * @kos/contracts/dashboard — shared zod schemas for Phase 3 dashboard-api routes
 * and the Vercel-side API proxy.
 *
 * Single source of truth: both apps/dashboard (Vercel) and
 * services/dashboard-api (in-VPC Lambda) import from this file so the
 * request/response shapes cannot drift. See 03-RESEARCH.md §7 (routing
 * table + zod boundary) and 03-CONTEXT.md D-25 (SSE payload contract).
 *
 * zod pin: 3.23.8 (monorepo-wide — do not upgrade here; see root
 * package.json). When the repo eventually moves to zod 4, this file
 * compiles unchanged aside from `.record(key, value)` which must become
 * the 2-arg form.
 */
import { z } from 'zod';

// -- Shared primitives ----------------------------------------------------

// ULID: 26 chars, Crockford base32 excluding I L O U.
export const UlidSchema = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]+$/);

export const UuidSchema = z.string().uuid();

export const BolagSchema = z.enum(['tale-forge', 'outbehaving', 'personal']);
export type Bolag = z.infer<typeof BolagSchema>;

export const IsoDateTimeSchema = z.string().datetime();

// -- Today view (GET /today) — RESEARCH §9 -------------------------------

export const TodayBriefSchema = z.object({
  body: z.string(),
  generated_at: IsoDateTimeSchema,
});
export type TodayBrief = z.infer<typeof TodayBriefSchema>;

export const TodayPrioritySchema = z.object({
  id: z.string(),
  title: z.string(),
  bolag: BolagSchema.nullable(),
  entity_id: UuidSchema.nullable(),
  entity_name: z.string().nullable(),
});
export type TodayPriority = z.infer<typeof TodayPrioritySchema>;

export const TodayDraftSchema = z.object({
  id: z.string(),
  entity: z.string(),
  preview: z.string(),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  received_at: IsoDateTimeSchema,
});
export type TodayDraft = z.infer<typeof TodayDraftSchema>;

export const TodayDroppedThreadSchema = z.object({
  id: z.string(),
  entity_id: UuidSchema,
  entity: z.string(),
  age_days: z.number(),
  bolag: BolagSchema.nullable(),
});
export type TodayDroppedThread = z.infer<typeof TodayDroppedThreadSchema>;

export const TodayMeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  start_at: IsoDateTimeSchema,
  end_at: IsoDateTimeSchema,
  is_now: z.boolean(),
  bolag: BolagSchema.nullable(),
});
export type TodayMeeting = z.infer<typeof TodayMeetingSchema>;

export const TodayResponseSchema = z.object({
  brief: TodayBriefSchema.nullable(),
  priorities: z.array(TodayPrioritySchema),
  drafts: z.array(TodayDraftSchema),
  dropped: z.array(TodayDroppedThreadSchema),
  meetings: z.array(TodayMeetingSchema),
});
export type TodayResponse = z.infer<typeof TodayResponseSchema>;

// -- Entity + timeline (GET /entities/:id, GET /entities/:id/timeline) ----

export const EntityTypeSchema = z.enum(['Person', 'Project', 'Company', 'Document']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const EntityLinkedProjectSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  bolag: BolagSchema.nullable(),
});

export const EntityResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  type: EntityTypeSchema,
  aliases: z.array(z.string()),
  org: z.string().nullable(),
  role: z.string().nullable(),
  relationship: z.string().nullable(),
  status: z.string(),
  seed_context: z.string().nullable(),
  manual_notes: z.string().nullable(),
  last_touch: IsoDateTimeSchema.nullable(),
  confidence: z.number().nullable(),
  linked_projects: z.array(EntityLinkedProjectSchema),
  stats: z.object({
    first_contact: IsoDateTimeSchema.nullable(),
    total_mentions: z.number(),
    active_threads: z.number(),
  }),
  ai_block: z
    .object({
      body: z.string(),
      cached_at: IsoDateTimeSchema.nullable(),
    })
    .nullable(),
});
export type EntityResponse = z.infer<typeof EntityResponseSchema>;

export const TimelineRowKindSchema = z.enum([
  'mention',
  'agent_run',
  'email',
  'transcript',
  'doc',
  'task',
  'decision',
  'merge',
]);
export type TimelineRowKind = z.infer<typeof TimelineRowKindSchema>;

export const TimelineRowSchema = z.object({
  id: z.string(),
  kind: TimelineRowKindSchema,
  occurred_at: IsoDateTimeSchema,
  source: z.string(),
  context: z.string(),
  capture_id: z.string().nullable(),
  href: z.string().nullable(),
  // Phase 6 MEM-04: true when the row was sourced from the live 10-min
  // overlay (mention_events occurred_at > now() - interval '10 minutes')
  // and NOT yet present in entity_timeline MV. Optional so existing
  // callers (Phase 3 dashboard fixtures, pre-MEM-04 test rows) keep
  // type-checking unchanged; consumers should treat undefined === false.
  is_live_overlay: z.boolean().optional(),
});
export type TimelineRow = z.infer<typeof TimelineRowSchema>;

export const TimelinePageSchema = z.object({
  rows: z.array(TimelineRowSchema),
  // base64("${occurred_at_iso}:${id}") per RESEARCH §10
  next_cursor: z.string().nullable(),
  // Phase 6 MEM-04: server-timing for budget verification (D-26 <50ms p95).
  // Optional + nullable to keep wire-format backwards-compatible.
  elapsed_ms: z.number().int().nonnegative().optional(),
});
export type TimelinePage = z.infer<typeof TimelinePageSchema>;

// -- Entity edit (POST /entities/:id) per D-29 ----------------------------

/**
 * Fields Kevin can manually edit on a Person or Project entity via the
 * dossier's "Edit entity" Dialog. All fields optional — the handler
 * shallow-merges into the Notion page; omitted keys are untouched.
 *
 * Mirrors Phase 1 ENT-01 schema (Name, Aliases, Org, Role, Relationship,
 * Status, LinkedProjects [via array of Notion page ids], SeedContext,
 * ManualNotes). Type is immutable in Phase 3 (would require re-indexing).
 */
export const EntityEditSchema = z.object({
  name: z.string().min(1).optional(),
  aliases: z.array(z.string()).optional(),
  org: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  relationship: z.string().nullable().optional(),
  status: z.string().optional(),
  seed_context: z.string().nullable().optional(),
  manual_notes: z.string().nullable().optional(),
});
export type EntityEditRequest = z.infer<typeof EntityEditSchema>;

export const EntityEditResponseSchema = z.object({
  ok: z.literal(true),
  id: UuidSchema,
});
export type EntityEditResponse = z.infer<typeof EntityEditResponseSchema>;

// -- Integrations health (GET /integrations-health) — Phase 11 D-07 -------

/**
 * Channel-health row as surfaced by the `/integrations-health` page and the
 * Today view's channel-health strip. Single source of truth for both
 * Plan 11-04 (page) and Plan 11-06 (Today strip) — they import from here
 * rather than redefining locally.
 *
 * `type='capture'` covers inbound channels (Telegram, Gmail, Granola,
 * Calendar, LinkedIn, Chrome). `type='scheduler'` covers cron-style
 * jobs surfaced on the same page (mission-control "Cron Jobs" analog —
 * see CONTEXT D-01 + 11-PATTERNS A6 lines 435-451).
 *
 * `last_event_at` is nullable: null = no event ever observed (treat as
 * '—' in UI per ChannelHealth.timeAgo()).
 */
export const ChannelHealthItemSchema = z.object({
  name: z.string(),
  type: z.enum(['capture', 'scheduler']),
  status: z.enum(['healthy', 'degraded', 'down']),
  last_event_at: IsoDateTimeSchema.nullable(),
});
export type ChannelHealthItem = z.infer<typeof ChannelHealthItemSchema>;

export const SchedulerHealthItemSchema = z.object({
  name: z.string(),
  next_run_at: IsoDateTimeSchema.nullable(),
  last_run_at: IsoDateTimeSchema.nullable(),
  last_status: z.enum(['ok', 'fail', 'pending']).nullable(),
});
export type SchedulerHealthItem = z.infer<typeof SchedulerHealthItemSchema>;

export const IntegrationsHealthResponseSchema = z.object({
  channels: z.array(ChannelHealthItemSchema),
  schedulers: z.array(SchedulerHealthItemSchema),
});
export type IntegrationsHealthResponse = z.infer<
  typeof IntegrationsHealthResponseSchema
>;

// -- Calendar (GET /calendar/week) per D-04 -------------------------------

/**
 * Calendar event as surfaced by the Week view. Phase 3 source is
 * Command Center Notion DB only (Deadline + Idag date properties).
 * Google Calendar merge is Phase 8 (CAP-09). `linked_entity_id` is
 * populated when the Command Center row carries a LinkedEntity relation
 * so clicking the bar deep-links to `/entities/[id]`.
 */
export const CalendarEventSourceSchema = z.enum([
  'command_center_deadline',
  'command_center_idag',
]);
export type CalendarEventSource = z.infer<typeof CalendarEventSourceSchema>;

export const CalendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start_at: IsoDateTimeSchema,
  end_at: IsoDateTimeSchema,
  linked_entity_id: UuidSchema.nullable(),
  bolag: BolagSchema.nullable(),
  source: CalendarEventSourceSchema,
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const CalendarWeekResponseSchema = z.object({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  events: z.array(CalendarEventSchema),
});
export type CalendarWeekResponse = z.infer<typeof CalendarWeekResponseSchema>;

// -- Inbox (GET /inbox, POST /inbox/:id/...) ------------------------------

export const InboxItemKindSchema = z.enum([
  'draft_reply',
  'entity_routing',
  'new_entity',
  'merge_resume',
  // Phase 11 D-05 — added so /inbox-merged can return agent_dead_letter
  // rows under a single InboxItemSchema. The /inbox legacy route never
  // emits this kind; only /inbox-merged does.
  'dead_letter',
]);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

/**
 * Phase 11 D-05 — email classification surfaced on inbox rows.
 *
 * Source-of-truth values match the email_drafts.classification column
 * (services/email-triage). New phases that introduce additional buckets
 * must update this enum together with the column.
 */
export const EmailClassificationSchema = z.enum([
  'urgent',
  'important',
  'informational',
  'junk',
]);
export type EmailClassification = z.infer<typeof EmailClassificationSchema>;

/**
 * Phase 11 D-05 — email_drafts.status state machine surfaced on inbox
 * rows so the renderer can hide Approve/Skip on terminal statuses.
 */
export const EmailDraftStatusSchema = z.enum([
  'pending_triage',
  'draft',
  'edited',
  'approved',
  'skipped',
  'sent',
  'failed',
]);
export type EmailDraftStatus = z.infer<typeof EmailDraftStatusSchema>;

export const InboxItemSchema = z.object({
  id: z.string(),
  kind: InboxItemKindSchema,
  title: z.string(),
  preview: z.string(),
  bolag: BolagSchema.nullable(),
  entity_id: UuidSchema.nullable(),
  merge_id: UlidSchema.nullable(),
  payload: z.record(z.unknown()),
  created_at: IsoDateTimeSchema,
  // Phase 11 D-05 — email-only metadata. Optional + nullable so legacy
  // clients (and non-email kinds like entity_routing) round-trip cleanly.
  classification: EmailClassificationSchema.nullable().optional(),
  email_status: EmailDraftStatusSchema.nullable().optional(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxListSchema = z.object({
  items: z.array(InboxItemSchema),
});
export type InboxList = z.infer<typeof InboxListSchema>;

export const InboxApproveSchema = z.object({
  edits: z.record(z.unknown()).optional(),
});
export type InboxApproveRequest = z.infer<typeof InboxApproveSchema>;

export const InboxEditSchema = z.object({
  fields: z.record(z.unknown()),
});
export type InboxEditRequest = z.infer<typeof InboxEditSchema>;

export const InboxActionResponseSchema = z.object({
  ok: z.literal(true),
});
export type InboxActionResponse = z.infer<typeof InboxActionResponseSchema>;

// -- Merge (POST /entities/:target_id/merge, .../resume) ------------------

export const MergeRequestSchema = z.object({
  source_id: UuidSchema,
  merge_id: UlidSchema,
  diff: z.record(z.unknown()),
});
export type MergeRequest = z.infer<typeof MergeRequestSchema>;

export const MergeResponseSchema = z.object({
  ok: z.boolean(),
  merge_id: UlidSchema,
  resumable: z.boolean().optional(),
});
export type MergeResponse = z.infer<typeof MergeResponseSchema>;

export const MergeResumeRequestSchema = z.object({
  merge_id: UlidSchema,
});
export type MergeResumeRequest = z.infer<typeof MergeResumeRequestSchema>;

// -- Capture (POST /capture) ----------------------------------------------

export const CapturePostSchema = z
  .object({
    text: z.string().max(10000).optional(),
    audio_s3: z.string().url().optional(),
  })
  .refine((v) => v.text !== undefined || v.audio_s3 !== undefined, {
    message: 'text or audio_s3 required',
  });
export type CaptureRequest = z.infer<typeof CapturePostSchema>;

export const CaptureResponseSchema = z.object({
  capture_id: UlidSchema,
  received_at: IsoDateTimeSchema,
});
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

// -- SSE event contract (D-25 verbatim) -----------------------------------

export const SseEventKindSchema = z.enum([
  'inbox_item',
  'entity_merge',
  'capture_ack',
  'draft_ready',
  'timeline_event',
]);
export type SseEventKind = z.infer<typeof SseEventKindSchema>;

export const SseEventSchema = z.object({
  kind: SseEventKindSchema,
  id: z.string(),
  entity_id: UuidSchema.optional(),
  ts: IsoDateTimeSchema,
});
export type SseEvent = z.infer<typeof SseEventSchema>;

// -- Auth ------------------------------------------------------------------

export const LoginRequestSchema = z.object({
  token: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  ok: z.literal(true),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
