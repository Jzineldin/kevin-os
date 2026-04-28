/**
 * Phase 7 Plan 07-00 Task 2 — Zod schema tests for the brief tool_use
 * contracts. These schemas are the load-bearing tool input shapes Sonnet 4.6
 * returns to morning-brief / day-close / weekly-review Lambdas. Each Lambda
 * validates the tool_use input against the matching schema and renders to
 * Notion + Telegram via services/_shared/brief-renderer.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  BriefAgentRunOutputSchema,
  BriefCommonFieldsSchema,
  DayCloseBriefSchema,
  MorningBriefSchema,
  WeeklyReviewSchema,
} from '../src/brief.js';

const A_UUID = '11111111-2222-4333-8444-555555555555';
const A_ULID = '01HZ0000000000000000000000';

describe('MorningBriefSchema', () => {
  it('accepts a minimal valid payload (empty calendars + drafts + dropped allowed)', () => {
    const payload = {
      prose_summary: 'Today is calm. Three threads need attention.',
      top_three: [
        { title: 'Almi follow-up', entity_ids: [A_UUID], urgency: 'high' as const },
      ],
      dropped_threads: [],
      calendar_today: [],
      calendar_tomorrow: [],
      drafts_ready: [],
    };
    const parsed = MorningBriefSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('rejects prose_summary > 600 chars', () => {
    const payload = {
      prose_summary: 'x'.repeat(601),
      top_three: [],
      dropped_threads: [],
    };
    const parsed = MorningBriefSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });

  it('rejects top_three with 4 items (max 3)', () => {
    const payload = {
      prose_summary: 'ok',
      top_three: Array.from({ length: 4 }, () => ({
        title: 't',
        entity_ids: [A_UUID],
        urgency: 'med' as const,
      })),
      dropped_threads: [],
    };
    const parsed = MorningBriefSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});

describe('DayCloseBriefSchema', () => {
  it('parses with the required slipped_items + recent_decisions + active_threads_delta arrays (empty allowed)', () => {
    const payload = {
      prose_summary: 'Day closed cleanly.',
      top_three: [],
      dropped_threads: [],
      slipped_items: [],
      recent_decisions: [],
      active_threads_delta: [],
    };
    const parsed = DayCloseBriefSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });
});

describe('WeeklyReviewSchema', () => {
  it('does NOT require top_three and rejects prose_summary > 1000', () => {
    const tooLong = {
      prose_summary: 'x'.repeat(1001),
      week_recap: [],
      next_week_candidates: [],
      active_threads_snapshot: [],
    };
    expect(WeeklyReviewSchema.safeParse(tooLong).success).toBe(false);

    const valid = {
      prose_summary: 'Solid week. Almi advanced; Tale Forge shipped iOS build.',
      week_recap: ['Almi term sheet drafted', 'Tale Forge TestFlight passed'],
      next_week_candidates: [{ title: 'Investor follow-up', why: 'Q3 close imminent' }],
      active_threads_snapshot: [
        { thread: 'Almi loan', where: 'almi' as const, status: 'awaiting decision' },
      ],
    };
    const parsed = WeeklyReviewSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    // Confirm WeeklyReview has no top_three field surface in the typed schema.
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).top_three).toBeUndefined();
    }
  });
});

describe('BriefAgentRunOutputSchema', () => {
  it('parses a morning-brief envelope with nested MorningBriefSchema data', () => {
    const envelope = {
      brief_kind: 'morning-brief' as const,
      brief_capture_id: A_ULID,
      rendered_at: '2026-04-25T07:00:00.000Z',
      data: {
        prose_summary: 'Calm morning.',
        top_three: [],
        dropped_threads: [],
        calendar_today: [],
        calendar_tomorrow: [],
        drafts_ready: [],
      },
    };
    const parsed = BriefAgentRunOutputSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('rejects brief_capture_id that is not a valid ULID', () => {
    const envelope = {
      brief_kind: 'weekly-review' as const,
      brief_capture_id: 'not-a-ulid',
      rendered_at: '2026-04-25T19:00:00.000Z',
      data: {
        prose_summary: 'Week summary.',
        week_recap: [],
        next_week_candidates: [],
        active_threads_snapshot: [],
      },
    };
    const parsed = BriefAgentRunOutputSchema.safeParse(envelope);
    expect(parsed.success).toBe(false);
  });
});

describe('BriefCommonFieldsSchema', () => {
  it('exists as a discrete schema (extended by morning + day-close)', () => {
    const ok = BriefCommonFieldsSchema.safeParse({
      prose_summary: 'small',
      top_three: [],
      dropped_threads: [],
    });
    expect(ok.success).toBe(true);
  });
});

describe('FlexibleDatetimeSchema coercion (fix 2026-04-28)', () => {
  // Regression: Morning-brief Lambda observed the LLM emitting
  // date-only strings for dropped_threads.last_mentioned_at which
  // failed strict datetime() validation and triggered the safe-
  // fallback empty brief.

  it('accepts ISO-8601 datetime as-is', () => {
    const parsed = MorningBriefSchema.safeParse({
      prose_summary: 'x',
      top_three: [],
      dropped_threads: [
        { title: 'Test', entity_ids: [], last_mentioned_at: '2026-04-28T10:00:00.000Z' },
      ],
      calendar_today: [],
      calendar_tomorrow: [],
      drafts_ready: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dropped_threads[0]!.last_mentioned_at).toBe('2026-04-28T10:00:00.000Z');
    }
  });

  it('accepts date-only string and normalizes to midnight UTC', () => {
    const parsed = MorningBriefSchema.safeParse({
      prose_summary: 'x',
      top_three: [],
      dropped_threads: [
        { title: 'Test', entity_ids: [], last_mentioned_at: '2026-04-28' },
      ],
      calendar_today: [],
      calendar_tomorrow: [],
      drafts_ready: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dropped_threads[0]!.last_mentioned_at).toBe('2026-04-28T00:00:00.000Z');
    }
  });

  it('accepts space-separated datetime and normalizes to ISO-8601', () => {
    const parsed = MorningBriefSchema.safeParse({
      prose_summary: 'x',
      top_three: [],
      dropped_threads: [],
      calendar_today: [
        { start: '2026-04-28 10:00:00Z', title: 'Meeting' },
      ],
      calendar_tomorrow: [],
      drafts_ready: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.calendar_today[0]!.start).toMatch(/^2026-04-28T10:00:00/);
    }
  });

  it('rejects genuinely unparseable strings', () => {
    const parsed = MorningBriefSchema.safeParse({
      prose_summary: 'x',
      top_three: [],
      dropped_threads: [
        { title: 'Test', entity_ids: [], last_mentioned_at: 'not-a-date' },
      ],
      calendar_today: [],
      calendar_tomorrow: [],
      drafts_ready: [],
    });
    expect(parsed.success).toBe(false);
  });
});
