/**
 * Phase 11 D-05 — InboxItemSchema additive extension tests.
 *
 * The contract gains two NEW optional + nullable fields:
 *   - classification: 'urgent' | 'important' | 'informational' | 'junk'
 *   - email_status: 'pending_triage' | 'draft' | 'edited' | 'approved'
 *                 | 'skipped' | 'sent' | 'failed'
 *
 * Old clients that don't send these fields must continue to parse cleanly.
 * New clients sending them must round-trip correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  EmailClassificationSchema,
  EmailDraftStatusSchema,
  InboxItemSchema,
} from '../src/dashboard.js';

const A_UUID = '11111111-2222-4333-8444-555555555555';
const NOW = '2026-04-26T07:00:00.000Z';

describe('EmailClassificationSchema (Phase 11 D-05)', () => {
  it.each(['urgent', 'important', 'informational', 'junk'] as const)(
    'accepts %s',
    (value) => {
      expect(EmailClassificationSchema.parse(value)).toBe(value);
    },
  );

  it('rejects unknown classification', () => {
    expect(EmailClassificationSchema.safeParse('spam').success).toBe(false);
  });
});

describe('EmailDraftStatusSchema (Phase 11 D-05)', () => {
  it.each([
    'pending_triage',
    'draft',
    'edited',
    'approved',
    'skipped',
    'sent',
    'failed',
  ] as const)('accepts %s', (value) => {
    expect(EmailDraftStatusSchema.parse(value)).toBe(value);
  });

  it('rejects unknown status', () => {
    expect(EmailDraftStatusSchema.safeParse('queued').success).toBe(false);
  });
});

describe('InboxItemSchema (Phase 11 D-05)', () => {
  it('parses an item with classification + email_status', () => {
    const result = InboxItemSchema.parse({
      id: '1',
      kind: 'draft_reply',
      title: 't',
      preview: 'p',
      bolag: null,
      entity_id: null,
      merge_id: null,
      payload: {},
      created_at: NOW,
      classification: 'urgent',
      email_status: 'draft',
    });
    expect(result.classification).toBe('urgent');
    expect(result.email_status).toBe('draft');
  });

  it('parses an item without classification (legacy clients)', () => {
    const result = InboxItemSchema.parse({
      id: '1',
      kind: 'entity_routing',
      title: 't',
      preview: 'p',
      bolag: null,
      entity_id: A_UUID,
      merge_id: null,
      payload: {},
      created_at: NOW,
    });
    expect(result.classification).toBeUndefined();
    expect(result.email_status).toBeUndefined();
  });

  it('accepts classification=null (explicit null for non-email kinds)', () => {
    const result = InboxItemSchema.parse({
      id: '1',
      kind: 'entity_routing',
      title: 't',
      preview: 'p',
      bolag: null,
      entity_id: A_UUID,
      merge_id: null,
      payload: {},
      created_at: NOW,
      classification: null,
      email_status: null,
    });
    expect(result.classification).toBeNull();
    expect(result.email_status).toBeNull();
  });

  it('rejects unknown classification value', () => {
    const r = InboxItemSchema.safeParse({
      id: '1',
      kind: 'draft_reply',
      title: 't',
      preview: 'p',
      bolag: null,
      entity_id: null,
      merge_id: null,
      payload: {},
      created_at: NOW,
      classification: 'spam',
    });
    expect(r.success).toBe(false);
  });
});
