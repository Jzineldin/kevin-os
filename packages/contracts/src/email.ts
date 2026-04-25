/**
 * Phase 4 / Plans 04-01..04-05 — email pipeline + iOS Shortcut capture
 * EventBridge + RDS schemas.
 *
 * Six exported Zod schemas:
 *   - CaptureReceivedIosSchema           CAP-02 (iOS Shortcut voice)
 *   - CaptureReceivedEmailForwardSchema  CAP-03 (forward@ SES inbound)
 *   - CaptureReceivedEmailInboxSchema    CAP-07 (EmailEngine push)
 *   - DraftReadySchema                   AGT-05 emit (kos.output)
 *   - EmailApprovedSchema                dashboard-api Approve emit (kos.output)
 *   - InboxDeadLetterSchema              services/_shared/with-timeout-retry on
 *                                        final failure (kos.output)
 *
 * The `CaptureReceived*` schemas are independent (NOT folded into the
 * Phase 2 `CaptureReceivedSchema` discriminatedUnion) because their `kind`
 * values (`voice`, `email_forward`, `email_inbox`) intersect with the
 * Phase 2 set in non-trivial ways and Phase 2 consumers (triage,
 * voice-capture) do NOT route email. Phase 4 consumers parse the relevant
 * single schema directly.
 */
import { z } from 'zod';

// ULID shape (26 chars, Crockford base32 alphabet excluding I L O U).
// Mirrors the regex in events.ts; redeclared here so this file is
// self-contained at the schema level (events.ts does not export it).
const UlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// --- CAP-02 iOS Shortcut voice capture ----------------------------------
//
// iOS Shortcut POSTs an HMAC-signed payload to the ios-webhook Lambda
// Function URL. The Lambda uploads the audio to S3 and emits this event
// to `kos.capture` for the Phase 2 transcribe pipeline (Plan 02-02) to
// pick up. `received_at` is set by the Lambda at ingress; `ios.signature_timestamp`
// is the client-side timestamp included in the HMAC payload (replay window check).
export const CaptureReceivedIosSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('ios-shortcut'),
  kind: z.literal('voice'),
  raw_ref: z.object({
    s3_bucket: z.string(),
    s3_key: z.string(),
    mime_type: z.string(),
    duration_sec: z.number().int().min(0).optional(),
  }),
  received_at: z.string().datetime(),
  ios: z.object({
    signature_timestamp: z.string(),
  }),
});
export type CaptureReceivedIos = z.infer<typeof CaptureReceivedIosSchema>;

// --- CAP-03 forward@kos.tale-forge.app SES inbound ----------------------
//
// SES delivers raw RFC 5322 MIME to the inbound S3 bucket; ses-inbound
// parses with mailparser, then emits this event. `s3_ref.region` is
// forced to 'eu-west-1' because that's the only SES inbound-supported
// region we use (D-13 — eu-north-1 doesn't host SES inbound).
export const CaptureReceivedEmailForwardSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('email-forward'),
  kind: z.literal('email_forward'),
  email: z.object({
    message_id: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    subject: z.string(),
    body_text: z.string(),
    body_html: z.string().optional(),
    s3_ref: z.object({
      bucket: z.string(),
      key: z.string(),
      region: z.literal('eu-west-1'),
    }),
    received_at: z.string().datetime(),
  }),
  received_at: z.string().datetime(),
});
export type CaptureReceivedEmailForward = z.infer<
  typeof CaptureReceivedEmailForwardSchema
>;

// --- CAP-07 EmailEngine push (IMAP IDLE) --------------------------------
//
// EmailEngine watches Kevin's two real inboxes (kevin@elzarka, kevin@tale-forge)
// via IMAP IDLE on Fargate; on a new message it POSTs a `messageNew` webhook
// to emailengine-webhook, which emits this event. `account_id` is the
// EmailEngine-internal account name and is used by email-triage to load the
// matching Kevin Context (work vs personal voice).
export const CaptureReceivedEmailInboxSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  channel: z.literal('email-inbox'),
  kind: z.literal('email_inbox'),
  email: z.object({
    account_id: z.string(),
    message_id: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    subject: z.string(),
    body_text: z.string(),
    body_html: z.string().optional(),
    received_at: z.string().datetime(),
    imap_uid: z.number().int().optional(),
  }),
  received_at: z.string().datetime(),
});
export type CaptureReceivedEmailInbox = z.infer<
  typeof CaptureReceivedEmailInboxSchema
>;

// --- AGT-05 draft.ready (emitted by email-triage) -----------------------
//
// `preview` is bounded at 400 chars to keep EventBridge detail payloads
// well below the 256KB hard limit even with classification + sender +
// subject populated.
export const DraftReadySchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  draft_id: z.string().uuid(),
  classification: z.enum(['urgent', 'important', 'informational', 'junk']),
  sender: z.string(),
  subject: z.string(),
  preview: z.string().max(400),
  reply_to: z.string(),
  emitted_at: z.string().datetime(),
});
export type DraftReady = z.infer<typeof DraftReadySchema>;

// --- email.approved (emitted by dashboard-api Approve route) ------------
//
// `authorization_id` references the row inserted into
// email_send_authorizations by the dashboard-api Approve handler. The
// email-sender Lambda re-reads that row, performs SES SendRawEmail, then
// stamps consumed_at + send_result. This indirection enforces the
// single-use-token property of the Approve gate (D-23).
export const EmailApprovedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  draft_id: z.string().uuid(),
  authorization_id: z.string().uuid(),
  approved_at: z.string().datetime(),
});
export type EmailApproved = z.infer<typeof EmailApprovedSchema>;

// --- inbox.dead_letter (emitted by withTimeoutAndRetry) -----------------
//
// On final failure of any agent tool call, withTimeoutAndRetry writes a
// row to `agent_dead_letter` AND emits this event so the dashboard can
// surface the failure in real time (D-24). `preview` is bounded at 400
// chars matching DraftReadySchema for parser/UI uniformity.
export const InboxDeadLetterSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  tool_name: z.string(),
  error_class: z.string(),
  preview: z.string().max(400),
  occurred_at: z.string().datetime(),
});
export type InboxDeadLetter = z.infer<typeof InboxDeadLetterSchema>;
