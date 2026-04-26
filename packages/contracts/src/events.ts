import { z } from 'zod';

// EventBridge detail shapes. Populated incrementally — Phase 1 creates the file
// + barrel. Phase 2 adds CaptureReceivedEventDetail,
// NotionWriteConfirmedEventDetail, etc.
// The five bus names are load-bearing across 10 phases — do not rename.
export const BUS_NAMES = {
  CAPTURE: 'kos.capture',
  TRIAGE: 'kos.triage',
  AGENT: 'kos.agent',
  OUTPUT: 'kos.output',
  SYSTEM: 'kos.system',
} as const;
export type BusName = (typeof BUS_NAMES)[keyof typeof BUS_NAMES];

export const EventMetadataSchema = z.object({
  captureId: z.string().ulid(),
  ownerId: z.string().uuid(),
  occurredAt: z.string().datetime(),
});
export type EventMetadata = z.infer<typeof EventMetadataSchema>;

// --- Phase 2 / Plan 02-01: CAP-01 Telegram ingress ------------------------
//
// `kos.capture` / `capture.received` — Phase 2 Telegram (text + voice variants).
// Voice detail carries raw_ref (S3) and no transcript; transcribe-complete
// later emits `capture.voice.transcribed` with the text (Plan 02-02). See
// .planning/phases/02-minimum-viable-loop/02-CONTEXT.md D-01, D-02, D-04.

// ULID shape (26 chars, Crockford base32 alphabet excluding I L O U).
const UlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// 2026-04-24: widened to accept dashboard-originated captures (channel:
// 'dashboard'). Dashboard captures don't have a Telegram message to tie
// sender/chat/message IDs to, so those fields are optional. Telegram
// captures continue to populate both (runtime enforcement in triage +
// voice-capture handlers where the reply-ack path depends on them).
export const CaptureReceivedTextSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.enum(['telegram', 'dashboard']),
  kind: z.literal('text'),
  text: z.string().min(1).max(8000),
  sender: z
    .object({
      id: z.number().int(),
      display: z.string().optional(),
    })
    .optional(),
  received_at: z.string().datetime(),
  telegram: z
    .object({
      chat_id: z.number().int(),
      message_id: z.number().int(),
    })
    .optional(),
  // Dashboard-originated captures pass through a free-form `source` tag
  // (e.g. 'dashboard' from services/dashboard-api capture handler).
  source: z.string().optional(),
});

export const CaptureReceivedVoiceSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('telegram'),
  kind: z.literal('voice'),
  raw_ref: z.object({
    s3_bucket: z.string(),
    s3_key: z.string(),
    duration_sec: z.number().int().min(0),
    mime_type: z.string(),
  }),
  sender: z.object({
    id: z.number().int(),
    display: z.string().optional(),
  }),
  received_at: z.string().datetime(),
  telegram: z.object({
    chat_id: z.number().int(),
    message_id: z.number().int(),
  }),
});

// --- Phase 5 / Plan 05-00: CAP-04 Chrome highlight ----------------------
//
// Chrome extension content script captures Kevin's right-click selection on
// any web page and POSTs it to the chrome-webhook Lambda. `source_url` is
// the location.href at selection time; `source_title` mirrors document.title
// so the inbox can render a human label without re-fetching the page.
// `selected_at` is the client clock; `received_at` is the Lambda's clock —
// both are kept so timezone / drift bugs are surfaceable post-hoc.
export const CaptureReceivedChromeHighlightSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('chrome'),
  kind: z.literal('chrome_highlight'),
  text: z.string().min(1).max(50_000),
  source_url: z.string().url(),
  source_title: z.string().optional(),
  selected_at: z.string().datetime(),
  received_at: z.string().datetime(),
});

// --- Phase 5 / Plan 05-00: CAP-05 LinkedIn DM ---------------------------
//
// Chrome extension's LinkedIn content script polls Voyager `conversations`
// + thread events endpoints, parses URN envelopes, and POSTs each new
// message to the linkedin-webhook Lambda. `conversation_urn` and
// `message_urn` are the Voyager identifiers used for idempotent dedupe;
// `from.li_public_id` is the URL-slug ("damien-hateley") if present in the
// miniProfile payload (some events ship miniProfile without it).
export const CaptureReceivedLinkedInDmSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('linkedin'),
  kind: z.literal('linkedin_dm'),
  conversation_urn: z.string(),
  message_urn: z.string(),
  from: z.object({
    name: z.string(),
    li_public_id: z.string().optional(),
  }),
  body: z.string().min(1).max(50_000),
  sent_at: z.string().datetime(),
  received_at: z.string().datetime(),
});

// --- Phase 5 / Plan 05-00: CAP-06 WhatsApp incoming ---------------------
//
// Baileys Fargate container streams every observed WhatsApp message to the
// baileys-sidecar Lambda Function URL. `jid` is the sender's WhatsApp JID
// (e.g., `46700000000@s.whatsapp.net`); `chat_jid` is the conversation JID
// — identical to `jid` for 1:1 chats, distinct (`-XXX@g.us`) for groups.
// `from_name` is the WhatsApp `pushName` if available — never trusted, only
// surfaced for human disambiguation in the dashboard.
export const CaptureReceivedWhatsappTextSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('whatsapp'),
  kind: z.literal('whatsapp_text'),
  jid: z.string(),
  chat_jid: z.string(),
  from_name: z.string().optional(),
  body: z.string().min(1).max(50_000),
  is_group: z.boolean(),
  sent_at: z.string().datetime(),
  received_at: z.string().datetime(),
});

// WhatsApp voice notes flow through the same Lambda; the audio is
// uploaded to S3 (eu-north-1) by the sidecar before this event is emitted,
// so downstream transcribe-starter (Phase 2 plan 02-02) can pick the audio
// up via the existing `audio/*` PutObject trigger.
export const CaptureReceivedWhatsappVoiceSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('whatsapp'),
  kind: z.literal('whatsapp_voice'),
  jid: z.string(),
  chat_jid: z.string(),
  from_name: z.string().optional(),
  raw_ref: z.object({
    s3_bucket: z.string(),
    s3_key: z.string(),
    duration_sec: z.number().int().min(0),
    mime_type: z.string(),
  }),
  is_group: z.boolean(),
  sent_at: z.string().datetime(),
  received_at: z.string().datetime(),
});

// --- Phase 5 / Plan 05-00: CAP-10 Discord text --------------------------
//
// Discord fallback poller (Plan 05-06) emits one event per new text message
// in any watched channel. `channel_id` and `message_id` are Discord
// snowflakes; the `author.id` is the snowflake of the message author. The
// poller is best-effort and idempotent — replays of the same `(channel_id,
// message_id)` pair must not double-route (idempotency enforced upstream
// by triage's existing capture-id dedupe).
export const CaptureReceivedDiscordTextSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('discord'),
  kind: z.literal('discord_text'),
  channel_id: z.string(),
  message_id: z.string(),
  author: z.object({
    id: z.string(),
    display: z.string().optional(),
  }),
  body: z.string().min(1).max(50_000),
  sent_at: z.string().datetime(),
  received_at: z.string().datetime(),
});

// Phase 5 extends the Phase-2-authored discriminated union by appending the
// five new capture kinds. Phase 2 / Phase 4 consumers (triage, voice-capture,
// email-triage) parse the relevant single schema directly; this union is the
// dashboard's single source of truth for all capture shapes.
export const CaptureReceivedSchema = z.discriminatedUnion('kind', [
  CaptureReceivedTextSchema,
  CaptureReceivedVoiceSchema,
  CaptureReceivedChromeHighlightSchema,
  CaptureReceivedLinkedInDmSchema,
  CaptureReceivedWhatsappTextSchema,
  CaptureReceivedWhatsappVoiceSchema,
  CaptureReceivedDiscordTextSchema,
]);

export const CaptureVoiceTranscribedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('telegram'),
  kind: z.literal('voice'),
  text: z.string(),
  raw_ref: z.object({
    s3_bucket: z.string(),
    s3_key: z.string(),
    duration_sec: z.number().int().min(0),
    mime_type: z.string(),
  }),
  sender: z.object({
    id: z.number().int(),
    display: z.string().optional(),
  }),
  received_at: z.string().datetime(),
  transcribed_at: z.string().datetime(),
  telegram: z.object({
    chat_id: z.number().int(),
    message_id: z.number().int(),
  }),
  vocab_name: z.literal('kos-sv-se-v1'),
});

export type CaptureReceivedText = z.infer<typeof CaptureReceivedTextSchema>;
export type CaptureReceivedVoice = z.infer<typeof CaptureReceivedVoiceSchema>;
export type CaptureReceived = z.infer<typeof CaptureReceivedSchema>;
export type CaptureVoiceTranscribed = z.infer<typeof CaptureVoiceTranscribedSchema>;

// --- Phase 2 / Plan 02-04: AGT-01 triage + AGT-02 voice-capture ----------
//
// `kos.triage` / `triage.routed` — emitted by the triage Lambda (AGT-01).
// FINAL wide schema authored once here in Plan 02-04 Task 1 (Step A); both
// triage and voice-capture handlers populate / consume the same shape.
//
// `source_text` carries the original capture text (≤8000 chars) so
// voice-capture doesn't have to re-fetch from S3 / DB. `sender` + `telegram`
// are forwarded so voice-capture can emit the final `output.push` ack as a
// reply to the original Telegram message (is_reply=true; see Plan 02-06).
//
// EventBridge per-event Detail limit is 256KB; this schema (worst case) is
// well under 12KB.

// 2026-04-24: `channel`, `sender`, `telegram` made optional for
// dashboard-sourced captures (no Telegram message to reply to).
// voice-capture conditionally emits the output.push Telegram ack only
// when telegram.chat_id is present.
export const TriageRoutedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  source_kind: z.enum(['text', 'voice']),
  source_text: z.string().max(8000),
  channel: z.enum(['telegram', 'dashboard']).optional(),
  route: z.enum(['voice-capture', 'inbox-review', 'drop']),
  detected_type: z.enum(['task', 'meeting', 'note', 'question', 'other']).optional(),
  urgency: z.enum(['low', 'med', 'high', 'none']).optional(),
  // Truncate verbose reasons to 500 chars rather than rejecting the entire
  // capture. Dropping a real voice memo because the LLM was wordy is far worse
  // than logging a long reason.
  reason: z.string().transform((s) => (s.length > 500 ? s.slice(0, 500) : s)),
  sender: z
    .object({
      id: z.number().int(),
      display: z.string().optional(),
    })
    .optional(),
  telegram: z
    .object({
      chat_id: z.number().int(),
      message_id: z.number().int(),
    })
    .optional(),
  routed_at: z.string().datetime(),
});
export type TriageRouted = z.infer<typeof TriageRoutedSchema>;

// `kos.agent` / `entity.mention.detected` — emitted by voice-capture Lambda
// (AGT-02), one per detected entity. Consumed by Plan 02-05 entity-resolver
// (AGT-03 / ENT-09).
export const EntityMentionDetectedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  mention_text: z.string().min(1).max(200),
  context_snippet: z.string().max(500),
  candidate_type: z.enum(['Person', 'Project', 'Org', 'Other']),
  // Phase 6 Plan 06-02 (AGT-06): added 'granola-transcript' so the
  // transcript-extractor Lambda can publish detected mentions through the
  // existing entity-resolver pipeline without a parallel event taxonomy.
  source: z.enum([
    'telegram-text',
    'telegram-voice',
    'dashboard-text',
    'granola-transcript',
  ]),
  occurred_at: z.string().datetime(),
  notion_command_center_page_id: z.string().optional(),
});
export type EntityMentionDetected = z.infer<typeof EntityMentionDetectedSchema>;

// --- Phase 2 / Plan 02-05: AGT-03 entity-resolver ------------------------
//
// `kos.agent` / `mention.resolved` — emitted by entity-resolver Lambda
// (AGT-03) after each entity.mention.detected is processed. Carries the
// 3-stage outcome (auto-merge, llm-disambig, inbox) for downstream
// observability + Plan 02-11 e2e assertions.
export const MentionResolvedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  mention_text: z.string(),
  stage: z.enum(['auto-merge', 'llm-disambig', 'inbox']),
  outcome: z.enum(['matched', 'inbox-new', 'inbox-appended', 'approved-inbox', 'unknown']),
  matched_entity_id: z.string().uuid().optional(),
  inbox_page_id: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
  resolved_at: z.string().datetime(),
});
export type MentionResolved = z.infer<typeof MentionResolvedSchema>;

// --- Phase 2 / Plan 02-06: OUT-01 push-telegram -------------------------
//
// `kos.output` / `output.push` — emitted by agent Lambdas (voice-capture
// synchronous ack with is_reply=true; Phase 7 morning-brief/daily-close with
// is_reply=false). Consumed by push-telegram (Plan 02-06) via an EventBridge
// rule on the kos.output bus. Telegram sendMessage `text` field is capped at
// 4096 chars (Telegram Bot API hard limit — longer text requires splitting
// before PutEvents).
//
// `is_reply=true` carries the §13 Pitfall-6 contract: Kevin-initiated replies
// bypass BOTH the 3/day notification cap AND the Stockholm 20:00-08:00 quiet
// hours suppression. Only direct-response agents (voice-capture) may set
// is_reply=true; scheduled pushes (morning brief, urgent drafts, etc.) MUST
// leave it unset / false. See push-telegram/src/cap.ts for the enforcement.
export const OutputPushSchema = z.object({
  capture_id: z.string().regex(UlidRegex).optional(),
  body: z.string().min(1).max(4096), // Telegram sendMessage text limit
  is_reply: z.boolean().optional(),
  telegram: z
    .object({
      chat_id: z.number().int(),
      reply_to_message_id: z.number().int().optional(),
    })
    .optional(),
});
export type OutputPush = z.infer<typeof OutputPushSchema>;

// --- Phase 5 / Plan 05-00: capture type exports + SystemAlert -----------
//
// Inferred TS types for the five Phase 5 capture schemas declared above.
// Kept at the bottom of the file (not next to the schemas) because the
// discriminated union must be defined before consumers can `z.infer` it
// without circularity warnings.

export type CaptureReceivedChromeHighlight = z.infer<
  typeof CaptureReceivedChromeHighlightSchema
>;
export type CaptureReceivedLinkedInDm = z.infer<
  typeof CaptureReceivedLinkedInDmSchema
>;
export type CaptureReceivedWhatsappText = z.infer<
  typeof CaptureReceivedWhatsappTextSchema
>;
export type CaptureReceivedWhatsappVoice = z.infer<
  typeof CaptureReceivedWhatsappVoiceSchema
>;
export type CaptureReceivedDiscordText = z.infer<
  typeof CaptureReceivedDiscordTextSchema
>;

// `kos.system / system.alert` — emitted by capture-side webhooks
// (chrome-webhook, linkedin-webhook, baileys-sidecar, baileys-fargate,
// emailengine-webhook, dashboard-api) when something operationally
// noteworthy happens. NOT a capture — never routed through triage.
//
// Severity levels:
//   - info             : healthy lifecycle events (account paired, etc.)
//   - warn             : recoverable issues (transient network failures)
//   - error            : non-recoverable; may require operator action
//   - auth_fail        : LinkedIn 401 / WhatsApp banned / Bearer mismatch
//   - unusual_activity : rate spike, unexpected sender pattern, abuse signal
//
// Consumed by dashboard-api which surfaces unacked rows in the alerts panel
// (no Telegram, no notification cap — alerts are pull, not push, per the
// ADHD-compatibility constraint in CLAUDE.md).
export const SystemAlertSchema = z.object({
  source: z.enum([
    'chrome',
    'linkedin',
    'whatsapp',
    'discord',
    'baileys',
    'emailengine',
    'system',
  ]),
  severity: z.enum(['info', 'warn', 'error', 'auth_fail', 'unusual_activity']),
  message: z.string().min(1).max(1000),
  owner_id: z.string().uuid(),
  raised_at: z.string().datetime(),
});
export type SystemAlert = z.infer<typeof SystemAlertSchema>;
