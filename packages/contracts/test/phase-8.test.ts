/**
 * Phase 8 Plan 08-00 Task 2 — Zod schema tests for outbound content +
 * mutation + calendar + document-version contracts. Each test asserts a
 * valid fixture parses AND a structurally invalid one is rejected, locking
 * the schema shape so downstream Plans 08-01..08-05 can rely on it.
 *
 * Note: this file imports from explicit subpaths to avoid the
 * DraftReadySchema barrel collision documented in src/index.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  ContentPlatformEnum,
  ContentTopicSubmittedSchema,
  ContentDraftSchema,
  DraftReadySchema as ContentDraftReadySchema,
  ContentApprovedSchema,
  ContentPublishedSchema,
} from '../src/content.js';
import {
  PendingMutationProposedSchema,
  PendingMutationApprovedSchema,
  PendingMutationExecutedSchema,
} from '../src/mutation.js';
import { CalendarEventSchema } from '../src/calendar.js';
import { DocumentVersionSchema } from '../src/document-version.js';

const A_ULID = '01HZ0000000000000000000000';
const A_UUID = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(64);
const SHA_PARENT = 'b'.repeat(64);
const NOW = '2026-04-25T07:00:00.000Z';

describe('ContentTopicSubmittedSchema', () => {
  it('Test 1: accepts a valid topic with 5 platforms', () => {
    const valid = {
      topic_id: A_ULID,
      capture_id: A_ULID,
      topic_text: 'Wrote a thread about ADHD founder routines',
      platforms: [
        'instagram',
        'linkedin',
        'tiktok',
        'reddit',
        'newsletter',
      ] as Array<typeof ContentPlatformEnum._type>,
      submitted_at: NOW,
    };
    expect(ContentTopicSubmittedSchema.safeParse(valid).success).toBe(true);
  });

  it('Test 2: rejects empty platforms array', () => {
    const invalid = {
      topic_id: A_ULID,
      capture_id: A_ULID,
      topic_text: 'foo',
      platforms: [],
      submitted_at: NOW,
    };
    expect(ContentTopicSubmittedSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('ContentDraftSchema', () => {
  it('Test 3: accepts all 9 statuses', () => {
    const statuses = [
      'draft',
      'edited',
      'approved',
      'skipped',
      'scheduled',
      'published',
      'cancelled',
      'failed',
    ] as const;
    for (const status of statuses) {
      const valid = {
        draft_id: A_UUID,
        topic_id: A_ULID,
        platform: 'linkedin' as const,
        content: 'A LinkedIn-tuned draft.',
        status,
        created_at: NOW,
      };
      expect(ContentDraftSchema.safeParse(valid).success).toBe(true);
    }
    // 8 statuses defined; an unknown status must reject.
    const invalid = {
      draft_id: A_UUID,
      topic_id: A_ULID,
      platform: 'linkedin' as const,
      content: 'x',
      status: 'pending_triage',
      created_at: NOW,
    };
    expect(ContentDraftSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('ContentDraftReadySchema (Phase 8 content draft.ready)', () => {
  it('Test 4: serialises topic_id + drafts array + emitted_at', () => {
    const valid = {
      topic_id: A_ULID,
      capture_id: A_ULID,
      drafts: [
        { draft_id: A_UUID, platform: 'instagram' as const, preview: 'IG preview' },
        { draft_id: A_UUID, platform: 'linkedin' as const, preview: 'LI preview' },
      ],
      emitted_at: NOW,
    };
    expect(ContentDraftReadySchema.safeParse(valid).success).toBe(true);

    const tooLong = {
      topic_id: A_ULID,
      capture_id: A_ULID,
      drafts: [
        {
          draft_id: A_UUID,
          platform: 'instagram' as const,
          preview: 'x'.repeat(401),
        },
      ],
      emitted_at: NOW,
    };
    expect(ContentDraftReadySchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('ContentApprovedSchema', () => {
  it('Test 5: accepts null schedule_time (immediate publish) and rejects bad UUID', () => {
    const valid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      authorization_id: A_UUID,
      schedule_time: null,
      approved_at: NOW,
    };
    expect(ContentApprovedSchema.safeParse(valid).success).toBe(true);

    const invalid = {
      capture_id: A_ULID,
      draft_id: 'not-a-uuid',
      authorization_id: A_UUID,
      schedule_time: null,
      approved_at: NOW,
    };
    expect(ContentApprovedSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('ContentPublishedSchema', () => {
  it('Test 6: requires postiz_post_id', () => {
    const valid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      platform: 'tiktok' as const,
      postiz_post_id: 'pst_abc123',
      published_at: NOW,
    };
    expect(ContentPublishedSchema.safeParse(valid).success).toBe(true);

    const invalid = {
      capture_id: A_ULID,
      draft_id: A_UUID,
      platform: 'tiktok',
      published_at: NOW,
    };
    expect(ContentPublishedSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('PendingMutationProposedSchema', () => {
  const baseTarget = {
    kind: 'meeting' as const,
    id: 'gcal-evt-001',
    display: 'Damien sync — Friday 11:00',
  };

  it('Test 7: accepts all 6 mutation_types', () => {
    const types = [
      'cancel_meeting',
      'delete_task',
      'archive_doc',
      'cancel_content_draft',
      'cancel_email_draft',
      'reschedule_meeting',
    ] as const;
    for (const mutation_type of types) {
      const valid = {
        mutation_id: A_UUID,
        capture_id: A_ULID,
        mutation_type,
        target_ref: baseTarget,
        confidence: 0.9,
        reasoning: 'Kevin said "ta bort mötet"',
        proposed_at: NOW,
      };
      expect(PendingMutationProposedSchema.safeParse(valid).success).toBe(true);
    }
  });

  it('Test 8: rejects confidence > 1', () => {
    const invalid = {
      mutation_id: A_UUID,
      capture_id: A_ULID,
      mutation_type: 'cancel_meeting' as const,
      target_ref: baseTarget,
      confidence: 1.5,
      reasoning: 'r',
      proposed_at: NOW,
    };
    expect(PendingMutationProposedSchema.safeParse(invalid).success).toBe(false);
  });

  it('Test 9: accepts up to 5 alternatives, rejects 6+', () => {
    const alt = {
      target_ref: { kind: 'meeting', id: 'x', display: 'x' },
      confidence: 0.5,
    };
    const validFive = {
      mutation_id: A_UUID,
      capture_id: A_ULID,
      mutation_type: 'cancel_meeting' as const,
      target_ref: baseTarget,
      confidence: 0.7,
      reasoning: 'r',
      proposed_at: NOW,
      alternatives: [alt, alt, alt, alt, alt],
    };
    expect(PendingMutationProposedSchema.safeParse(validFive).success).toBe(true);

    const invalidSix = { ...validFive, alternatives: [alt, alt, alt, alt, alt, alt] };
    expect(PendingMutationProposedSchema.safeParse(invalidSix).success).toBe(false);
  });
});

describe('PendingMutationApprovedSchema', () => {
  it('Test 10: optional selected_target_ref', () => {
    const withoutSel = {
      capture_id: A_ULID,
      mutation_id: A_UUID,
      authorization_id: A_UUID,
      approved_at: NOW,
    };
    expect(PendingMutationApprovedSchema.safeParse(withoutSel).success).toBe(true);

    const withSel = {
      ...withoutSel,
      selected_target_ref: { kind: 'meeting', id: 'gcal-evt-002', display: 'Almi' },
    };
    expect(PendingMutationApprovedSchema.safeParse(withSel).success).toBe(true);
  });
});

describe('PendingMutationExecutedSchema', () => {
  it('Test 11: accepts all 4 results', () => {
    const results = ['archived', 'rescheduled', 'no_op', 'failed'] as const;
    for (const result of results) {
      const valid = {
        capture_id: A_ULID,
        mutation_id: A_UUID,
        result,
        error: result === 'failed' ? 'pg: connection reset' : null,
        executed_at: NOW,
      };
      expect(PendingMutationExecutedSchema.safeParse(valid).success).toBe(true);
    }

    const invalid = {
      capture_id: A_ULID,
      mutation_id: A_UUID,
      result: 'who-knows',
      error: null,
      executed_at: NOW,
    };
    expect(PendingMutationExecutedSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('CalendarEventSchema', () => {
  it('Test 12: accepts is_all_day + ignored_by_kevin defaults', () => {
    const valid = {
      event_id: 'gcal-evt-001',
      account: 'kevin-elzarka' as const,
      calendar_id: 'primary',
      summary: 'Damien sync',
      description: null,
      location: null,
      start_utc: NOW,
      end_utc: NOW,
      timezone: 'Europe/Stockholm',
      // omit attendees_json — schema default
      updated_at: NOW,
      is_all_day: false,
      // omit ignored_by_kevin — schema default
    };
    const parsed = CalendarEventSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.attendees_json).toEqual([]);
      expect(parsed.data.ignored_by_kevin).toBe(false);
    }

    const invalid = {
      ...valid,
      account: 'someone-else',
    };
    expect(CalendarEventSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('DocumentVersionSchema', () => {
  it('Test 13: requires sha256 exactly 64 chars', () => {
    const valid = {
      id: A_UUID,
      recipient_email: 'christina@almi.se',
      doc_name: 'avtal.pdf',
      sha256: SHA,
      s3_bucket: 'kos-docs-eu-north-1',
      s3_key: 'docs/2026/04/25/avtal-v3.pdf',
      version_n: 3,
      parent_sha256: SHA_PARENT,
      diff_summary: '4.2 ESOP clause added',
      sent_at: NOW,
      capture_id: A_ULID,
    };
    expect(DocumentVersionSchema.safeParse(valid).success).toBe(true);

    const invalidShort = { ...valid, sha256: 'a'.repeat(63) };
    expect(DocumentVersionSchema.safeParse(invalidShort).success).toBe(false);
    const invalidLong = { ...valid, sha256: 'a'.repeat(65) };
    expect(DocumentVersionSchema.safeParse(invalidLong).success).toBe(false);
  });

  it('Test 14: accepts parent_sha256 null for v1', () => {
    const validV1 = {
      id: A_UUID,
      recipient_email: 'christina@almi.se',
      doc_name: 'avtal.pdf',
      sha256: SHA,
      s3_bucket: 'kos-docs-eu-north-1',
      s3_key: 'docs/2026/04/25/avtal-v1.pdf',
      version_n: 1,
      parent_sha256: null,
      diff_summary: null,
      sent_at: NOW,
      capture_id: A_ULID,
    };
    expect(DocumentVersionSchema.safeParse(validV1).success).toBe(true);
  });
});
