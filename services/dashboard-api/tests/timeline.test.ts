/**
 * Timeline cursor encode/decode round-trip tests.
 *
 * Integration coverage (UNION ALL query against mention_events + agent_runs)
 * lives under e2e — it requires the live in-VPC RDS Proxy. These pure
 * unit tests lock the cursor wire format so Vercel and Lambda never drift.
 */
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/handlers/timeline.js';

describe('timeline cursor', () => {
  it('round-trips an ISO datetime + UUID pair', () => {
    const ts = '2026-04-23T12:34:56.789Z';
    const id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
    const encoded = encodeCursor(ts, id);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ ts, id });
  });

  it('returns null for an undefined cursor', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('returns null for a garbage cursor', () => {
    expect(decodeCursor('not-base64-@@@')).toBeNull();
  });

  it('returns null for a base64 string without a colon separator', () => {
    const encoded = Buffer.from('nope', 'utf8').toString('base64');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null when the ts portion is not parseable as a date', () => {
    const encoded = Buffer.from('banana:some-id', 'utf8').toString('base64');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('wraps emails and other colons in the id suffix losslessly', () => {
    // IDs should be uuids but the format also tolerates other strings.
    const encoded = encodeCursor('2026-04-23T00:00:00Z', 'abc:def');
    expect(decodeCursor(encoded)).toEqual({ ts: '2026-04-23T00:00:00Z', id: 'abc:def' });
  });
});
