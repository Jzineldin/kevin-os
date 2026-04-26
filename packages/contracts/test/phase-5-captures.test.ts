/**
 * Phase 5 Plan 05-00 Task 2 — Zod schema tests for the messaging-channels
 * captures + SystemAlert. Each test asserts a valid fixture parses AND a
 * structurally invalid one is rejected, locking the schema shape so
 * downstream Plans 05-01..05-07 can rely on it.
 */
import { describe, it, expect } from 'vitest';
import {
  CaptureReceivedChromeHighlightSchema,
  CaptureReceivedLinkedInDmSchema,
  CaptureReceivedWhatsappTextSchema,
  CaptureReceivedWhatsappVoiceSchema,
  CaptureReceivedDiscordTextSchema,
  CaptureReceivedSchema,
  SystemAlertSchema,
} from '../src/events.js';

const A_ULID = '01HZ0000000000000000000000';
const A_UUID = '11111111-2222-4333-8444-555555555555';
const NOW = '2026-04-25T07:00:00.000Z';

describe('CaptureReceivedChromeHighlightSchema', () => {
  it('accepts a minimal valid Chrome highlight capture', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'chrome' as const,
      kind: 'chrome_highlight' as const,
      text: 'Some highlighted paragraph from a blog post.',
      source_url: 'https://example.com/post',
      source_title: 'Example post',
      selected_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedChromeHighlightSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects payload with non-URL source_url', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'chrome',
      kind: 'chrome_highlight',
      text: 'x',
      source_url: 'not-a-url',
      selected_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedChromeHighlightSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedLinkedInDmSchema', () => {
  it('accepts a minimal valid LinkedIn DM capture', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'linkedin' as const,
      kind: 'linkedin_dm' as const,
      conversation_urn: 'urn:li:fs_conversation:2-AAAAAAAA',
      message_urn: 'urn:li:fs_event:(2-AAAAAAAA,5-BBBBBBBB)',
      from: { name: 'Damien Hateley', li_public_id: 'damien-hateley' },
      body: 'Yo Kevin — got 10 min for a call?',
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedLinkedInDmSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects payload with empty body', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'linkedin',
      kind: 'linkedin_dm',
      conversation_urn: 'urn:li:fs_conversation:x',
      message_urn: 'urn:li:fs_event:x',
      from: { name: 'X' },
      body: '',
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedLinkedInDmSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedWhatsappTextSchema', () => {
  it('accepts a minimal valid WhatsApp text capture', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'whatsapp' as const,
      kind: 'whatsapp_text' as const,
      jid: '46700000000@s.whatsapp.net',
      chat_jid: '46700000000@s.whatsapp.net',
      from_name: 'Damien',
      body: 'Hej Kevin',
      is_group: false,
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedWhatsappTextSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects payload missing is_group', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'whatsapp',
      kind: 'whatsapp_text',
      jid: 'x',
      chat_jid: 'x',
      body: 'hi',
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedWhatsappTextSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedWhatsappVoiceSchema', () => {
  it('accepts a minimal valid WhatsApp voice capture', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'whatsapp' as const,
      kind: 'whatsapp_voice' as const,
      jid: '46700000000@s.whatsapp.net',
      chat_jid: '46700000000@s.whatsapp.net',
      raw_ref: {
        s3_bucket: 'kos-blobs-eu-north-1',
        s3_key: 'audio/01HZ.opus',
        duration_sec: 17,
        mime_type: 'audio/ogg',
      },
      is_group: false,
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedWhatsappVoiceSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects payload with negative duration', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'whatsapp',
      kind: 'whatsapp_voice',
      jid: 'x',
      chat_jid: 'x',
      raw_ref: {
        s3_bucket: 'b',
        s3_key: 'k',
        duration_sec: -1,
        mime_type: 'audio/ogg',
      },
      is_group: false,
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedWhatsappVoiceSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedDiscordTextSchema', () => {
  it('accepts a minimal valid Discord text capture', () => {
    const valid = {
      capture_id: A_ULID,
      channel: 'discord' as const,
      kind: 'discord_text' as const,
      channel_id: '123456789012345678',
      message_id: '987654321098765432',
      author: { id: '111111111111111111', display: 'damien' },
      body: 'check the deck',
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedDiscordTextSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects payload with wrong channel literal', () => {
    const invalid = {
      capture_id: A_ULID,
      channel: 'whatsapp',
      kind: 'discord_text',
      channel_id: 'x',
      message_id: 'y',
      author: { id: 'a' },
      body: 'b',
      sent_at: NOW,
      received_at: NOW,
    };
    expect(CaptureReceivedDiscordTextSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CaptureReceivedSchema (extended discriminated union)', () => {
  it('routes a chrome_highlight payload to the chrome arm', () => {
    const ok = CaptureReceivedSchema.safeParse({
      capture_id: A_ULID,
      channel: 'chrome',
      kind: 'chrome_highlight',
      text: 'x',
      source_url: 'https://example.com',
      selected_at: NOW,
      received_at: NOW,
    });
    expect(ok.success).toBe(true);
  });

  it('routes a whatsapp_voice payload through the union', () => {
    const ok = CaptureReceivedSchema.safeParse({
      capture_id: A_ULID,
      channel: 'whatsapp',
      kind: 'whatsapp_voice',
      jid: 'x',
      chat_jid: 'x',
      raw_ref: {
        s3_bucket: 'b',
        s3_key: 'k',
        duration_sec: 1,
        mime_type: 'audio/ogg',
      },
      is_group: false,
      sent_at: NOW,
      received_at: NOW,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const ko = CaptureReceivedSchema.safeParse({
      capture_id: A_ULID,
      channel: 'chrome',
      kind: 'totally_made_up_kind',
      text: 'x',
      received_at: NOW,
    });
    expect(ko.success).toBe(false);
  });
});

describe('SystemAlertSchema', () => {
  it('accepts a minimal valid alert', () => {
    const valid = {
      source: 'linkedin' as const,
      severity: 'auth_fail' as const,
      message: 'LinkedIn polling returned 401; channel paused for 24h',
      owner_id: A_UUID,
      raised_at: NOW,
    };
    expect(SystemAlertSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown severity', () => {
    const invalid = {
      source: 'whatsapp',
      severity: 'meltdown',
      message: 'x',
      owner_id: A_UUID,
      raised_at: NOW,
    };
    expect(SystemAlertSchema.safeParse(invalid).success).toBe(false);
  });
});
