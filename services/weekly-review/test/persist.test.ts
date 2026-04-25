/**
 * Phase 7 Plan 07-02 Task 2 — weekly-review persist.ts unit tests.
 *
 * Adds:
 *   - loadWeekRecapHint: 4-row UNION ALL aggregating mention_events,
 *     email_drafts, morning_briefs, day_closes counts over last 7 days.
 *   - No top3_membership writes (WeeklyReviewSchema has no top_three).
 *
 * pg.Pool is fully mocked. Test 2 is structural — verify the writer surface
 * does not export a top3_membership writer.
 */
import { describe, it, expect, vi } from 'vitest';
import * as persist from '../src/persist.js';
import { loadWeekRecapHint } from '../src/persist.js';

function makePool(scripted: Array<{ rows: any[]; rowCount?: number }>) {
  let i = 0;
  const query = vi.fn(async () => {
    const next = scripted[i++] ?? { rows: [], rowCount: 0 };
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  });
  return { query } as any;
}

describe('loadWeekRecapHint', () => {
  it('returns aggregated 4-row counts (mentions, emails, morning_briefs, day_closes)', async () => {
    const pool = makePool([
      {
        rows: [
          { kind: 'mentions', n: 142 },
          { kind: 'emails', n: 87 },
          { kind: 'morning_briefs', n: 5 },
          { kind: 'day_closes', n: 5 },
        ],
      },
    ]);
    const out = await loadWeekRecapHint(pool, 'o-1', '2026-04-19', '2026-04-26');
    expect(out).toHaveLength(4);
    expect(out.find((r) => r.kind === 'mentions')?.n).toBe(142);
    expect(out.find((r) => r.kind === 'emails')?.n).toBe(87);
    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/mention_events/);
    expect(sql).toMatch(/email_drafts/);
    expect(sql).toMatch(/morning-brief|morning_briefs?/i);
    expect(sql).toMatch(/day-close|day_closes?/i);
  });

  it('returns [] gracefully when email_drafts table is missing (Phase-4 degrade)', async () => {
    // Simulate "relation email_drafts does not exist".
    const error = Object.assign(new Error('relation "email_drafts" does not exist'), {
      code: '42P01',
    });
    const pool = {
      query: vi.fn(async () => {
        throw error;
      }),
    } as any;
    const out = await loadWeekRecapHint(pool, 'o-1', '2026-04-19', '2026-04-26');
    expect(out).toEqual([]);
  });
});

describe('writeTop3Membership absent', () => {
  it('weekly-review persist module does not export writeTop3Membership (no top_three field)', () => {
    // WeeklyReviewSchema (D-05) has no top_three; the persist module should
    // not provide a top3_membership writer for weekly-review.
    expect((persist as Record<string, unknown>).writeTop3Membership).toBeUndefined();
  });
});
