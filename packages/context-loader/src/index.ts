/**
 * @kos/context-loader — AGT-04 auto-context loader (Phase 6).
 *
 * Replaces the abandoned Claude Agent SDK pre-call hook pattern with an
 * explicit `loadContext()` helper each agent Lambda calls BEFORE invoking
 * Bedrock. Returns a ContextBundle whose `assembled_markdown` block is
 * injected into the system prompt with `cache_control: { type: 'ephemeral' }`.
 *
 * Kevin Context is ALWAYS included (prompt-cached across calls). Entity
 * dossiers are fetched in parallel with Azure Search semantic chunks and
 * linked-project metadata. The dossier cache layer (`cache.ts`) avoids
 * repeat Postgres + Azure traffic when entity state hasn't changed
 * (verified via `last_touch_hash`).
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
 */
export {
  loadContext,
  type LoadContextInput,
  type ContextBundleWithCalendar,
} from './loadContext.js';
export { loadKevinContextBlock, loadKevinContextMarkdown } from './kevin.js';
export { buildDossierMarkdown } from './markdown.js';
export {
  readDossierCache,
  writeDossierCache,
  invalidateDossierCache,
  computeLastTouchHash,
} from './cache.js';
// Phase 8 Plan 08-01 / D-11 — calendar window helper for the morning brief
// + per-entity context. Always-exported for downstream consumers (Phase 7
// + mutation-proposer); the loadContext-level integration is gated on the
// `includeCalendar` flag.
export {
  loadCalendarWindow,
  formatCalendarMarkdown,
  type CalendarWindowRow,
  type CalendarWindowAttendee,
} from './calendar.js';
