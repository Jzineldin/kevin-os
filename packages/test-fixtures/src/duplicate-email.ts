/**
 * Phase 4 Plan 04-00 Task 5 — duplicate-email idempotency fixture.
 *
 * Two structurally-identical CaptureReceivedEmailInbox payloads (same
 * Message-ID, From, Subject, body) — Gate 3 ships both through the
 * email-triage Lambda and asserts that exactly ONE row exists in
 * email_drafts after both events are processed. The (account_id,
 * message_id) UNIQUE constraint in migration 0016 enforces this at the SQL
 * layer; the test verifies the constraint is correctly wired and that
 * email-triage's INSERT ... ON CONFLICT DO NOTHING path is hit.
 *
 * `differentMessageId` is the negative control — same body, different
 * Message-ID, asserting the dedupe key is the Message-ID and NOT the body
 * content.
 */

const BASE_RECEIVED_AT = '2026-04-25T07:00:00.000Z';
const BASE_BODY =
  'Hi Kevin,\n\nQuick check on the Almi follow-up — are we good for Friday?\n\n/Anders';

function makeFixture(messageId: string, captureId: string): {
  capture_id: string;
  channel: 'email-inbox';
  kind: 'email_inbox';
  email: {
    account_id: string;
    message_id: string;
    from: string;
    to: string[];
    subject: string;
    body_text: string;
    received_at: string;
  };
  received_at: string;
} {
  return {
    capture_id: captureId,
    channel: 'email-inbox',
    kind: 'email_inbox',
    email: {
      account_id: 'kevin-taleforge',
      message_id: messageId,
      from: 'Anders Almi <anders@almi.example>',
      to: ['kevin@tale-forge.app'],
      subject: 'Re: Almi follow-up',
      body_text: BASE_BODY,
      received_at: BASE_RECEIVED_AT,
    },
    received_at: BASE_RECEIVED_AT,
  };
}

/**
 * Two identical-by-Message-ID events. email-triage MUST insert exactly one
 * row in `email_drafts` after both are processed.
 */
export const DUPLICATE_EMAIL_FIXTURES = [
  makeFixture('<almi-1@almi.example>', '01HZ0000000000000000000DU1'),
  makeFixture('<almi-1@almi.example>', '01HZ0000000000000000000DU2'),
] as const;

/**
 * Negative control: same body, different Message-ID. email-triage MUST
 * insert TWO rows (the unique constraint key is account_id+message_id, NOT
 * body content).
 */
export const DUPLICATE_EMAIL_DIFFERENT_MESSAGE_ID = makeFixture(
  '<almi-2@almi.example>',
  '01HZ0000000000000000000DU3',
);
