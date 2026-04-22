import { describe, it, expect } from 'vitest';
import { isQuietHour, stockholmDateKey } from '../src/quiet-hours.js';

/**
 * Quiet-hours tests cover:
 *   - boundary hours (07:59, 08:00, 19:59, 20:00 Stockholm)
 *   - DST transitions (CET winter ↔ CEST summer)
 *   - date-key derivation across Stockholm midnight
 *
 * We construct UTC instants that correspond to the intended Stockholm wall
 * time, then assert on `isQuietHour`/`stockholmDateKey` (which format via
 * `sv-SE` + `timeZone: 'Europe/Stockholm'`, letting ICU handle DST).
 *
 * Offset reference:
 *   - Winter (CET)  = UTC+1 — effective ~last-Sun-Oct … last-Sun-Mar
 *   - Summer (CEST) = UTC+2 — effective ~last-Sun-Mar … last-Sun-Oct
 */

/** Build a Date from an ISO string describing a UTC instant. */
function utc(iso: string): Date {
  return new Date(iso);
}

describe('isQuietHour (Stockholm boundaries)', () => {
  it('Stockholm 07:59 winter (CET, UTC+1) → quiet', () => {
    // 07:59 CET = 06:59 UTC
    expect(isQuietHour(utc('2026-01-15T06:59:00Z'))).toBe(true);
  });

  it('Stockholm 08:00 winter → NOT quiet', () => {
    // 08:00 CET = 07:00 UTC
    expect(isQuietHour(utc('2026-01-15T07:00:00Z'))).toBe(false);
  });

  it('Stockholm 19:59 winter → NOT quiet', () => {
    // 19:59 CET = 18:59 UTC
    expect(isQuietHour(utc('2026-01-15T18:59:00Z'))).toBe(false);
  });

  it('Stockholm 20:00 winter → quiet', () => {
    // 20:00 CET = 19:00 UTC
    expect(isQuietHour(utc('2026-01-15T19:00:00Z'))).toBe(true);
  });

  it('Stockholm 22:00 winter → quiet', () => {
    // 22:00 CET = 21:00 UTC
    expect(isQuietHour(utc('2026-01-15T21:00:00Z'))).toBe(true);
  });

  it('Stockholm 10:00 winter → NOT quiet', () => {
    // 10:00 CET = 09:00 UTC
    expect(isQuietHour(utc('2026-01-15T09:00:00Z'))).toBe(false);
  });
});

describe('isQuietHour — DST transitions', () => {
  it('DST autumn fall-back: Stockholm 02:30 CET (winter) → quiet', () => {
    // November = CET (UTC+1). 02:30 CET = 01:30 UTC. Deep night → quiet.
    expect(isQuietHour(utc('2026-11-05T01:30:00Z'))).toBe(true);
  });

  it('DST spring-forward: Stockholm 08:00 CEST (summer) → NOT quiet', () => {
    // July = CEST (UTC+2). 08:00 CEST = 06:00 UTC.
    expect(isQuietHour(utc('2026-07-15T06:00:00Z'))).toBe(false);
  });

  it('DST spring-forward: Stockholm 07:59 CEST → quiet', () => {
    // 07:59 CEST = 05:59 UTC
    expect(isQuietHour(utc('2026-07-15T05:59:00Z'))).toBe(true);
  });

  it('DST summer: Stockholm 20:00 CEST → quiet', () => {
    // 20:00 CEST = 18:00 UTC
    expect(isQuietHour(utc('2026-07-15T18:00:00Z'))).toBe(true);
  });
});

describe('stockholmDateKey', () => {
  it('returns YYYY-MM-DD for a mid-afternoon instant', () => {
    // 14:00 CET = 13:00 UTC
    expect(stockholmDateKey(utc('2026-04-22T13:00:00Z'))).toBe('2026-04-22');
  });

  it('crosses midnight: 23:30 Stockholm → previous day; 00:30 → next day', () => {
    // Winter: 23:30 CET = 22:30 UTC on the SAME civil date in Stockholm
    expect(stockholmDateKey(utc('2026-01-15T22:30:00Z'))).toBe('2026-01-15');
    // 00:30 CET = 23:30 UTC (previous UTC day) — Stockholm date is NEXT day
    expect(stockholmDateKey(utc('2026-01-15T23:30:00Z'))).toBe('2026-01-16');
  });

  it('summer (CEST): 00:30 Stockholm = 22:30 UTC previous day', () => {
    // 00:30 CEST = 22:30 UTC previous day
    expect(stockholmDateKey(utc('2026-07-14T22:30:00Z'))).toBe('2026-07-15');
  });
});
