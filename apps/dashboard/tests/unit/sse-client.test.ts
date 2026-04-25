/**
 * sse-client — pure helpers for the browser SseProvider (Plan 03-07 Task 2).
 *
 * These are the bits we can test without a DOM:
 *   - nextBackoff grows exponentially but caps at BACKOFF_MAX (60s, R-12).
 *   - parseMessage accepts a JSON-encoded SseEvent and rejects garbage.
 *
 * SseProvider's subscribe/unsubscribe + EventSource lifecycle are covered
 * by sse-provider.test.tsx (needs jsdom + EventSource stub).
 */
import { describe, it, expect } from 'vitest';

import {
  BACKOFF_MIN,
  BACKOFF_MAX,
  nextBackoff,
  parseMessage,
} from '@/lib/sse-client';

describe('nextBackoff', () => {
  it('starts at BACKOFF_MIN when doubled from half', () => {
    expect(BACKOFF_MIN).toBeGreaterThan(0);
    expect(BACKOFF_MAX).toBe(60_000);
  });

  it('doubles on each call up to the 60s cap', () => {
    const sequence: number[] = [];
    let v = BACKOFF_MIN;
    for (let i = 0; i < 12; i++) {
      sequence.push(v);
      v = nextBackoff(v);
    }
    // First value is the starting floor.
    expect(sequence[0]).toBe(BACKOFF_MIN);
    // Every value must be <= the cap.
    for (const s of sequence) expect(s).toBeLessThanOrEqual(BACKOFF_MAX);
    // Eventually hits the cap and stays there.
    expect(sequence[sequence.length - 1]).toBe(BACKOFF_MAX);
  });

  it('caps at 60_000 regardless of how large the previous value is', () => {
    expect(nextBackoff(BACKOFF_MAX)).toBe(BACKOFF_MAX);
    expect(nextBackoff(BACKOFF_MAX * 10)).toBe(BACKOFF_MAX);
  });
});

describe('parseMessage', () => {
  it('returns the parsed SseEvent for valid JSON matching the schema', () => {
    const iso = '2026-04-23T12:00:00.000Z';
    const raw = JSON.stringify({ kind: 'inbox_item', id: 'inb_abc', ts: iso });
    const ev = parseMessage(raw);
    expect(ev).not.toBeNull();
    expect(ev?.kind).toBe('inbox_item');
    expect(ev?.id).toBe('inb_abc');
  });

  it('returns null on invalid JSON', () => {
    expect(parseMessage('not-json')).toBeNull();
    expect(parseMessage('')).toBeNull();
  });

  it('returns null when the payload does not match SseEventSchema', () => {
    // Missing required `ts`.
    expect(parseMessage(JSON.stringify({ kind: 'inbox_item', id: 'x' }))).toBeNull();
    // Unknown `kind`.
    expect(
      parseMessage(
        JSON.stringify({ kind: 'unknown_kind', id: 'x', ts: '2026-04-23T00:00:00Z' }),
      ),
    ).toBeNull();
  });
});
