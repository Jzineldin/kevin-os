/**
 * Phase 4 Plan 04-00 Task 2 — Zod schema tests for the email pipeline +
 * iOS Shortcut capture contracts. Each test asserts a valid fixture parses
 * AND a structurally invalid one is rejected, locking the schema shape so
 * downstream Plans 04-01..04-05 can rely on it.
 */
import { describe, it, expect } from 'vitest';
import {
  CaptureReceivedIosSchema,
  CaptureReceivedEmailForwardSchema,
  CaptureReceivedEmailInboxSchema,
  DraftReadySchema,
  EmailApprovedSchema,
  InboxDeadLetterSchema,
} from '../src/email.js';

const A_ULID = '01HZ0000000000000000000000';
const A_UUID = '11111111-2222-4333-8444-555555555555';
const NOW = '2026-04-25T07:00:00.000Z';

describe('CaptureReceivedIosSchema', () => {
  it('accepts a minimal valid iOS Shortcut capture', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'ios-shortcut' as const,
      kind: 'voice' as const,
      raw_ref: {
        s3_bucket: 'kos-audio-eu-north-1',
        s3_key: 'ios/2026/04/25/abc.m4a',
        mime_type: 'audio/m4a',
        duration_sec: 12,
      },
      received_at: NOW,
      ios: { signature_timestamp: '1714028400' },
    };
    expect(CaptureReceivedIosSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a payload with the wrong channel literal', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'telegram',
      kind: 'voice',
      raw_ref: {
        s3_bucket: 'kos-audio-eu-north-1',
        s3_key: 'ios/x.m4a',
        mime_type: 'audio/m4a',
      },
      received_at: NOW,
      ios: { signature_timestamp: '1714028400' },
    };
    expect(CaptureReceivedIosSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a payload missing ios.signature_timestamp', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'ios-shortcut',
      kind: 'voice',
      raw_ref: {
        s3_bucket: 'kos-audio-eu-north-1',
        s3_key: 'ios/x.m4a',
        mime_type: 'audio/m4a',
      },
      received_at: NOW,
      ios: {},
    };
    expect(CaptureReceivedIosSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedEmailForwardSchema', () => {
  it('accepts a forwarded-email capture with eu-west-1 SES bucket', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'email-forward' as const,
      kind: 'email_forward' as const,
      email: {
        message_id: '<abc@example.com>',
        from: 'Kevin <kevin@elzarka.se>',
        to: ['forward@kos.tale-forge.app'],
        subject: 'Fwd: Almi avtal',
        body_text: 'Forwarded body',
        s3_ref: {
          bucket: 'kos-ses-inbound-eu-west-1',
          key: 'inbound/2026/04/25/raw',
          region: 'eu-west-1' as const,
        },
        received_at: NOW,
      },
      received_at: NOW,
    };
    expect(CaptureReceivedEmailForwardSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a payload with a non-eu-west-1 s3_ref.region', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'email-forward',
      kind: 'email_forward',
      email: {
        message_id: '<abc@example.com>',
        from: 'k@x',
        to: ['f@x'],
        subject: 's',
        body_text: 'b',
        s3_ref: { bucket: 'b', key: 'k', region: 'eu-north-1' },
        received_at: NOW,
      },
      received_at: NOW,
    };
    expect(CaptureReceivedEmailForwardSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedEmailInboxSchema', () => {
  it('accepts an EmailEngine push capture with imap_uid', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'email-inbox' as const,
      kind: 'email_inbox' as const,
      email: {
        account_id: 'kevin-taleforge',
        message_id: '<abc@example.com>',
        from: 'partner@example.com',
        to: ['kevin@tale-forge.app'],
        subject: 'Re: pricing',
        body_text: 'reply',
        received_at: NOW,
        imap_uid: 42,
      },
      received_at: NOW,
    };
    expect(CaptureReceivedEmailInboxSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a payload with a non-ULID capture_id', () => {
    const invalid = {
      capture_id: 'not-a-ulid',
      channel: 'email-inbox',
      kind: 'email_inbox',
      email: {
        account_id: 'kevin-taleforge',
        message_id: 'm',
        from: 'a',
        to: ['b'],
        subject: 's',
        body_text: 'b',
        received_at: NOW,
      },
      received_at: NOW,
    };
    expect(CaptureReceivedEmailInboxSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('DraftReadySchema', () => {
  it('accepts a draft.ready event', () => {
    const valid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      classification: 'important' as const,
      sender: 'partner@example.com',
      subject: 'Re: pricing',
      preview: 'short preview',
      reply_to: 'kevin@tale-forge.app',
      emitted_at: NOW,
    };
    expect(DraftReadySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects preview > 400 chars', () => {
    const invalid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      classification: 'important',
      sender: 's',
      subject: 'su',
      preview: 'x'.repeat(401),
      reply_to: 'r',
      emitted_at: NOW,
    };
    expect(DraftReadySchema.safeParse(invalid).success).toBe(false);
  });
});

describe('EmailApprovedSchema', () => {
  it('accepts an email.approved event', () => {
    const valid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      authorization_id: A_UUID,
      approved_at: NOW,
    };
    expect(EmailApprovedSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a payload with a non-UUID authorization_id', () => {
    const invalid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      authorization_id: 'not-a-uuid',
      approved_at: NOW,
    };
    expect(EmailApprovedSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('InboxDeadLetterSchema', () => {
  it('accepts an inbox.dead_letter event', () => {
    const valid = {
      capture_id: A_ULID,
      tool_name: 'email-triage:bedrock-haiku',
      error_class: 'ThrottlingException',
      preview: 'failed after 3 attempts',
      occurred_at: NOW,
    };
    expect(InboxDeadLetterSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects preview > 400 chars', () => {
    const invalid = {
      capture_id: A_ULID,
      tool_name: 't',
      error_class: 'X',
      preview: 'x'.repeat(401),
      occurred_at: NOW,
    };
    expect(InboxDeadLetterSchema.safeParse(invalid).success).toBe(false);
  });
});
