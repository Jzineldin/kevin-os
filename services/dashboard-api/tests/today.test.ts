/**
 * Today-response contract shape test.
 *
 * Full live composition test (Notion + RDS in parallel) lives under e2e.
 * Here we only verify that the zod contract we validate *at exit* in
 * handlers/today.ts accepts an empty Phase-3 payload (brief=null,
 * meetings=[]) — if a future change breaks this shape, the Lambda will
 * start returning 500s to Vercel, and this test will light up first.
 */
import { describe, expect, it } from 'vitest';
import { TodayResponseSchema } from '@kos/contracts/dashboard';

describe('today response schema', () => {
  it('accepts an empty Phase-3 payload (brief=null, meetings=[])', () => {
    const empty = {
      brief: null,
      priorities: [],
      drafts: [],
      dropped: [],
      meetings: [],
    };
    expect(() => TodayResponseSchema.parse(empty)).not.toThrow();
  });

  it('accepts a realistic populated payload', () => {
    const populated = {
      brief: { body: 'Go ship Phase 3.', generated_at: '2026-04-23T08:00:00Z' },
      priorities: [
        {
          id: 'n-1',
          title: 'Ship dashboard',
          bolag: 'tale-forge',
          entity_id: null,
          entity_name: null,
        },
      ],
      drafts: [
        {
          id: 'i-1',
          entity: 'Damien',
          preview: 'Re: funding',
          from: 'damien@example.com',
          subject: 'Re: funding',
          received_at: '2026-04-23T07:30:00Z',
        },
      ],
      dropped: [
        {
          id: 'e-1',
          entity_id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
          entity: 'Christina',
          age_days: 8.2,
          bolag: 'tale-forge',
        },
      ],
      meetings: [],
    };
    expect(() => TodayResponseSchema.parse(populated)).not.toThrow();
  });

  it('rejects an unknown bolag', () => {
    const bad = {
      brief: null,
      priorities: [
        {
          id: 'n-1',
          title: 'x',
          bolag: 'unknown-co',
          entity_id: null,
          entity_name: null,
        },
      ],
      drafts: [],
      dropped: [],
      meetings: [],
    };
    expect(() => TodayResponseSchema.parse(bad)).toThrow();
  });

  // Phase 11 Plan 11-04: today response gains captures_today (UNION of
  // email_drafts + capture_text + capture_voice + mention_events for the
  // current Stockholm day) plus stat_tiles + channels strips. Wave 2
  // implements; Wave 0 ships the skipped placeholder.
  it.skip(
    'captures_today UNIONs email + capture_text + capture_voice + mention_events',
    async () => {
      // Wave 2 implements. Pattern mirrors email-drafts.test.ts:
      //   1. fakeDb.execute mock returning rows for each source table
      //   2. import handler after __clearRoutesForTest()
      //   3. assert response.captures_today contains rows from all 4 sources
      //   4. assert response shape parses against TodayResponseSchema
    },
  );
});
