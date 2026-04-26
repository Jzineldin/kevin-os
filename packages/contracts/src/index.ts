/**
 * @kos/contracts — barrel export.
 *
 * Re-exports event schemas (Phase 1/2), dashboard schemas (Phase 3),
 * context schemas (Phase 6 AGT-04 + INF-10), brief schemas (Phase 7
 * AUTO-01/03/04), email schemas (Phase 4), Phase 8 outbound content +
 * mutation + calendar + document-version schemas, and Phase 10 migration
 * schemas (MIG-01/02 + CAP-10 + INF-11). Prefer scoped subpath imports
 * for new code:
 *   import { CaptureReceivedSchema } from '@kos/contracts/events';
 *   import { TodayResponseSchema } from '@kos/contracts/dashboard';
 *   import { ContextBundleSchema } from '@kos/contracts/context';
 *   import { MorningBriefSchema } from '@kos/contracts/brief';
 *   import { ClassifyPayloadSchema } from '@kos/contracts/migration';
 *   import { ContentTopicSubmittedSchema } from '@kos/contracts/content';
 *   import { PendingMutationProposedSchema } from '@kos/contracts/mutation';
 *   import { CalendarEventSchema } from '@kos/contracts/calendar';
 *   import { DocumentVersionSchema } from '@kos/contracts/document-version';
 *
 * NOTE on the DraftReadySchema collision:
 *   - email.ts exports `DraftReadySchema` (Phase 4 — one per email)
 *   - content.ts exports `DraftReadySchema` (Phase 8 — drafts grouped by topic)
 * The barrel preserves the Phase-4 export under its bare name (existing
 * email-triage callers use `import { DraftReadySchema } from '@kos/contracts'`)
 * and re-exports the Phase 8 schema explicitly as `ContentDraftReadySchema`.
 * Phase 8 callers MUST use the explicit subpath if they want the bare name:
 *   import { DraftReadySchema } from '@kos/contracts/content';
 */
export * from './events.js';
export * from './dashboard.js';
export * from './context.js';
export * from './brief.js';
export * from './email.js';
export * from './migration.js';
// Phase 8 Plan 08-00 — outbound content / mutation / calendar / document-version.
// Use explicit re-export lists for content.ts to disambiguate the
// DraftReadySchema name collision with email.ts (see note above).
export {
  ContentPlatformEnum,
  ContentTopicSubmittedSchema,
  ContentDraftSchema,
  DraftReadySchema as ContentDraftReadySchema,
  ContentApprovedSchema,
  ContentPublishedSchema,
} from './content.js';
export type {
  ContentPlatform,
  ContentTopicSubmitted,
  ContentDraft,
  DraftReady as ContentDraftReady,
  ContentApproved,
  ContentPublished,
} from './content.js';
export * from './mutation.js';
// calendar.ts also collides with dashboard.ts's `CalendarEvent` /
// `CalendarEventSchema` (Phase 3 dashboard surfaces a different shape that
// unions Granola + GCal events). Re-export Phase 8's calendar exports under
// a `Gcal` prefix in the barrel; consumers wanting the bare names use
// `@kos/contracts/calendar` subpath.
export {
  CalendarEventSchema as GcalCalendarEventSchema,
  CalendarEventsReadSchema,
} from './calendar.js';
export type {
  CalendarEvent as GcalCalendarEvent,
  CalendarEventsRead,
} from './calendar.js';
export * from './document-version.js';
