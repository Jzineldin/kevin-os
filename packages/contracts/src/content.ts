/**
 * Phase 8 / Plan 08-00 — Outbound content pipeline event + DB-row schemas.
 *
 * Six exported Zod schemas covering AGT-07 + CAP-09:
 *   - ContentTopicSubmittedSchema  — Kevin gives content-writer a topic
 *   - ContentDraftSchema           — content_drafts row shape
 *   - DraftReadySchema             — emitted on kos.output when all platform
 *                                    drafts for a topic complete (Phase 8
 *                                    has its own DraftReadySchema, distinct
 *                                    from the email pipeline's DraftReady)
 *   - ContentApprovedSchema        — emitted by dashboard-api Approve route
 *                                    when Kevin approves (or schedules) a
 *                                    single platform draft
 *   - ContentPublishedSchema       — emitted by publisher after a successful
 *                                    Postiz MCP create-post call
 *   - ContentPlatformEnum          — the 5 supported platforms
 *
 * NOTE on naming collision: this file's `DraftReadySchema` is for content
 * drafts (multiple per topic). Phase 4 / `email.ts` exports a different
 * `DraftReadySchema` for email drafts (one per email). Both are re-exported
 * from the barrel — consumers must import from the explicit subpath when
 * disambiguation matters:
 *   import { DraftReadySchema as EmailDraftReadySchema } from '@kos/contracts/email';
 *   import { DraftReadySchema as ContentDraftReadySchema } from '@kos/contracts/content';
 *
 * The barrel `export *` exports the latter (content) under the bare name —
 * this is a deliberate Phase-8-wins choice; downstream Phase 4 consumers
 * should already be importing from the `@kos/contracts/email` subpath.
 */
import { z } from 'zod';

// ULID shape (26 chars, Crockford base32 alphabet excluding I L O U). Mirrors
// the regex in events.ts; redeclared here so this file is self-contained at
// the schema level.
const UlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// --- Platform enum ------------------------------------------------------
//
// The 5 supported outbound platforms. Each maps 1:1 to a Postiz integration
// + a section in BRAND_VOICE.md. Adding a new platform requires:
//   (1) extending this enum
//   (2) adding a Postiz integration (out-of-band, Postiz UI)
//   (3) adding a BRAND_VOICE.md section + flipping human_verification:false
//   (4) extending content_drafts.platform CHECK constraint
export const ContentPlatformEnum = z.enum([
  'instagram',
  'linkedin',
  'tiktok',
  'reddit',
  'newsletter',
]);
export type ContentPlatform = z.infer<typeof ContentPlatformEnum>;

// --- AGT-07 Step 1: Kevin submits a topic -------------------------------
//
// Emitted by capture-side Lambdas (telegram-bot, dashboard-api,
// emailengine-webhook, etc.) when Kevin's voice/text is classified by
// Phase 2 triage as `route='content-writer'`. The triage Lambda is the
// nominal emitter; this schema is the contract content-writer parses on
// receipt. `topic_text` upper bound matches Phase 2 capture text caps.
export const ContentTopicSubmittedSchema = z.object({
  topic_id: z.string().regex(UlidRegex),
  capture_id: z.string().regex(UlidRegex),
  topic_text: z.string().min(1).max(5000),
  platforms: z.array(ContentPlatformEnum).min(1).max(5),
  submitted_at: z.string().datetime(),
});
export type ContentTopicSubmitted = z.infer<typeof ContentTopicSubmittedSchema>;

// --- content_drafts row shape -------------------------------------------
//
// Mirror of the SQL table in migration 0020. Used by content-writer-platform
// to parse rows it has just inserted, and by the dashboard reader path.
// `media_urls` defaults to [] when omitted; `status` enum mirrors the SQL
// CHECK constraint.
export const ContentDraftSchema = z.object({
  draft_id: z.string().uuid(),
  topic_id: z.string().regex(UlidRegex),
  platform: ContentPlatformEnum,
  content: z.string().min(1).max(10000),
  media_urls: z.array(z.string().url()).max(10).optional(),
  status: z.enum([
    'draft',
    'edited',
    'approved',
    'skipped',
    'scheduled',
    'published',
    'cancelled',
    'failed',
  ]),
  created_at: z.string().datetime(),
});
export type ContentDraft = z.infer<typeof ContentDraftSchema>;

// --- AGT-07 Step 3: all platforms drafted ------------------------------
//
// Emitted on kos.output when content-writer's Step Functions Map has
// converged for a single topic. `drafts[].preview` capped at 400 chars to
// stay well under the 256KB EventBridge per-event limit even with 5 drafts.
// Dashboard SSE consumes this and renders the per-topic Approve UI.
export const DraftReadySchema = z.object({
  topic_id: z.string().regex(UlidRegex),
  capture_id: z.string().regex(UlidRegex),
  drafts: z.array(
    z.object({
      draft_id: z.string().uuid(),
      platform: ContentPlatformEnum,
      preview: z.string().max(400),
    }),
  ),
  emitted_at: z.string().datetime(),
});
export type DraftReady = z.infer<typeof DraftReadySchema>;

// --- CAP-09 Approve gate -----------------------------------------------
//
// Emitted by dashboard-api Approve route (per-platform, single-use). The
// publisher Lambda re-reads the matching content_publish_authorizations
// row, calls Postiz MCP, then stamps consumed_at + publish_result. The
// indirection enforces the single-use-token property of every Approve gate
// in KOS (mirrors Phase 4 EmailApprovedSchema).
//
// `schedule_time` semantics:
//   - null  → publish immediately (Postiz schedule=now)
//   - ISO   → publish at that future timestamp; Postiz schedules the post
export const ContentApprovedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  draft_id: z.string().uuid(),
  authorization_id: z.string().uuid(),
  schedule_time: z.string().datetime().nullable(),
  approved_at: z.string().datetime(),
});
export type ContentApproved = z.infer<typeof ContentApprovedSchema>;

// --- CAP-09 publish completed ------------------------------------------
//
// Emitted by publisher after Postiz MCP confirms the post is live (or, for
// scheduled posts, that it's queued). `postiz_post_id` is the opaque Postiz
// identifier; KOS stores it for the future "delete this scheduled post"
// pathway routed through mutation-executor.
export const ContentPublishedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  draft_id: z.string().uuid(),
  platform: ContentPlatformEnum,
  postiz_post_id: z.string(),
  published_at: z.string().datetime(),
});
export type ContentPublished = z.infer<typeof ContentPublishedSchema>;
