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

export const CaptureReceivedTextSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('telegram'),
  kind: z.literal('text'),
  text: z.string().min(1).max(8000),
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

export const CaptureReceivedSchema = z.discriminatedUnion('kind', [
  CaptureReceivedTextSchema,
  CaptureReceivedVoiceSchema,
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

export const TriageRoutedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  source_kind: z.enum(['text', 'voice']),
  source_text: z.string().max(8000),
  route: z.enum(['voice-capture', 'inbox-review', 'drop']),
  detected_type: z.enum(['task', 'meeting', 'note', 'question']).optional(),
  urgency: z.enum(['low', 'med', 'high']).optional(),
  reason: z.string().max(200),
  sender: z.object({
    id: z.number().int(),
    display: z.string().optional(),
  }),
  telegram: z.object({
    chat_id: z.number().int(),
    message_id: z.number().int(),
  }),
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
  source: z.enum(['telegram-text', 'telegram-voice']),
  occurred_at: z.string().datetime(),
  notion_command_center_page_id: z.string().optional(),
});
export type EntityMentionDetected = z.infer<typeof EntityMentionDetectedSchema>;
