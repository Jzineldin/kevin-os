/**
 * Phase 7 Plan 07-04 Task 1 — queries.ts unit tests (TDD RED).
 *
 * Pure-SQL + DynamoDB unit tests for the cap-snapshot + quiet-hours
 * verification helpers. pg.Pool and DynamoDBDocumentClient are fully mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  loadCapSnapshots14Days,
  loadQuietHoursViolations14Days,
} from '../src/queries.js';

function makePool(scripted: Array<{ rows: any[]; rowCount?: number }>) {
  let i = 0;
  const query = vi.fn(async () => {
    const next = scripted[i++] ?? { rows: [], rowCount: 0 };
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  });
  return { query } as any;
}

function makeDdb(scripted: Array<{ Item?: { count?: number } } | Error>) {
  let i = 0;
  const send = vi.fn(async () => {
    const next = scripted[i++];
    if (next instanceof Error) throw next;
    return next ?? {};
  });
  return { send } as any;
}

describe('loadCapSnapshots14Days', () => {
  it('returns 14 day entries even when SQL returns only a subset (zero-pads missing days)', async () => {
    // SQL returns 3 days; we expect padding to fill 14 entries with pushOkCount=0.
    const today = new Date();
    const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10);
    const day0 = new Date(today);
    const day1 = new Date(today);
    day1.setUTCDate(day1.getUTCDate() - 1);
    const day2 = new Date(today);
    day2.setUTCDate(day2.getUTCDate() - 2);

    const pool = makePool([
      {
        rows: [
          { stockholm_date: yyyymmdd(day0), push_ok_count: '2' },
          { stockholm_date: yyyymmdd(day1), push_ok_count: '1' },
          { stockholm_date: yyyymmdd(day2), push_ok_count: '3' },
        ],
      },
    ]);
    const ddb = makeDdb([
      { Item: { count: 2 } },
      { Item: { count: 1 } },
      { Item: { count: 3 } },
      // 11 more days padded with empty DDB (no Item).
      ...Array.from({ length: 11 }, () => ({})),
    ]);

    const snaps = await loadCapSnapshots14Days(pool, ddb, 'cap-table', 'owner-1');

    expect(snaps).toHaveLength(14);
    // First three days carry SQL-derived counts; remaining are zero-padded.
    expect(snaps[0]?.pushOkCount).toBe(2);
    expect(snaps[1]?.pushOkCount).toBe(1);
    expect(snaps[2]?.pushOkCount).toBe(3);
    for (let i = 3; i < 14; i++) {
      expect(snaps[i]?.pushOkCount).toBe(0);
      expect(snaps[i]?.violation).toBe(false);
    }
    // SQL called once.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('marks violation=true when pushOkCount > 3 on any day', async () => {
    const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const pool = makePool([
      {
        rows: [
          // today=2 (ok), yesterday=4 (VIOLATION)
          { stockholm_date: yyyymmdd(today), push_ok_count: '2' },
          { stockholm_date: yyyymmdd(yesterday), push_ok_count: '4' },
        ],
      },
    ]);
    const ddb = makeDdb([
      { Item: { count: 2 } },
      { Item: { count: 4 } },
      ...Array.from({ length: 12 }, () => ({})),
    ]);

    const snaps = await loadCapSnapshots14Days(pool, ddb, 'cap-table', 'owner-1');

    const todaySnap = snaps.find((s) => s.stockholmDate === yyyymmdd(today));
    const yesterdaySnap = snaps.find((s) => s.stockholmDate === yyyymmdd(yesterday));

    expect(todaySnap?.violation).toBe(false);
    expect(yesterdaySnap?.violation).toBe(true);
    expect(yesterdaySnap?.pushOkCount).toBe(4);
    expect(yesterdaySnap?.capTableCount).toBe(4);
  });

  it('handles DynamoDB Get failure with capTableCount=null but still returns snapshots', async () => {
    const today = new Date();
    const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10);
    const pool = makePool([
      {
        rows: [{ stockholm_date: yyyymmdd(today), push_ok_count: '2' }],
      },
    ]);
    // DynamoDB throws.
    const ddb = makeDdb([
      ...Array.from({ length: 14 }, () => new Error('DynamoDB unavailable')),
    ]);

    const snaps = await loadCapSnapshots14Days(pool, ddb, 'cap-table', 'owner-1');
    expect(snaps).toHaveLength(14);
    // capTableCount should be null on every day (DDB failed).
    for (const s of snaps) {
      expect(s.capTableCount).toBeNull();
    }
    // pushOkCount is still derived from SQL.
    const todaySnap = snaps.find((s) => s.stockholmDate === yyyymmdd(today));
    expect(todaySnap?.pushOkCount).toBe(2);
  });
});

describe('loadQuietHoursViolations14Days', () => {
  it('returns rows where stockholm_hour ∈ [20, 8) (and SQL filter present)', async () => {
    const at1 = new Date('2026-04-22T20:30:00.000Z'); // Stockholm 22:30
    const at2 = new Date('2026-04-23T05:30:00.000Z'); // Stockholm 07:30
    const pool = makePool([
      {
        rows: [
          { started_at: at1, capture_id: 'cap-1', stockholm_hour: 22 },
          { started_at: at2, capture_id: 'cap-2', stockholm_hour: 7 },
        ],
      },
    ]);

    const violations = await loadQuietHoursViolations14Days(pool, 'owner-1');
    expect(violations).toHaveLength(2);
    expect(violations[0]).toEqual({
      at: at1.toISOString(),
      stockholmHour: 22,
      capture_id: 'cap-1',
    });
    expect(violations[1]?.stockholmHour).toBe(7);

    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/agent_runs/);
    expect(sql).toMatch(/push-telegram/);
    expect(sql).toMatch(/Europe\/Stockholm/);
    expect(sql).toMatch(/>= 20|< 8/);
  });

  it('returns [] when no quiet-hours pushes happened in last 14 days', async () => {
    const pool = makePool([{ rows: [], rowCount: 0 }]);
    const violations = await loadQuietHoursViolations14Days(pool, 'owner-1');
    expect(violations).toEqual([]);
  });
});
