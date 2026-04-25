/**
 * Timeline cursor encode/decode round-trip tests + Phase 6 MV+overlay
 * SQL-shape assertions.
 *
 * Integration coverage (the actual SQL execution against entity_timeline +
 * mention_events) lives under e2e — it requires the live in-VPC RDS Proxy.
 * These pure unit tests lock:
 *   - the cursor wire format (so Vercel and Lambda never drift)
 *   - the SQL-shape of the MV+overlay query (so the D-26 grep predicate
 *     `entity_timeline_mv.*UNION ALL.*mention_events` always matches a
 *     close-enough variant — the shipped MV name is `entity_timeline`).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCursor, encodeCursor } from '../src/handlers/timeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANDLER_PATH = path.resolve(__dirname, '../src/handlers/timeline.ts');
const HANDLER_SOURCE = fs.readFileSync(HANDLER_PATH, 'utf8');

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

describe('timeline handler — Phase 6 MV+overlay SQL shape (D-26)', () => {
  it('SQL reads entity_timeline materialized view (MV path)', () => {
    expect(HANDLER_SOURCE).toContain('FROM entity_timeline');
  });

  it('SQL UNIONs the MV with mention_events live overlay', () => {
    // The plan's grep predicate is `entity_timeline_mv.*UNION ALL.*mention_events`.
    // The shipped MV name is entity_timeline; assert against a normalized
    // single-line version so the predicate matches across the multi-line CTE.
    const flat = HANDLER_SOURCE.replace(/\s+/g, ' ');
    expect(flat).toMatch(/entity_timeline.*UNION ALL.*mention_events/);
  });

  it('live overlay uses 10-minute interval (D-26)', () => {
    expect(HANDLER_SOURCE).toContain("now() - interval '10 minutes'");
  });

  it('live overlay dedups against MV via NOT IN subquery', () => {
    // Plan D-26 requires the live branch to filter out rows already present
    // in the MV. Spelling allowed: `id NOT IN (SELECT ... FROM mv ...)`.
    const flat = HANDLER_SOURCE.replace(/\s+/g, ' ');
    expect(flat).toMatch(/NOT IN \(SELECT[^)]*FROM mv/);
  });

  it('both branches enforce owner_id = OWNER_ID (cross-owner leak guard)', () => {
    const matches = HANDLER_SOURCE.match(/owner_id = \$\{OWNER_ID\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('result rows tagged with is_live_overlay boolean per branch', () => {
    expect(HANDLER_SOURCE).toContain('false AS is_live_overlay');
    expect(HANDLER_SOURCE).toContain('true AS is_live_overlay');
  });

  it('LIMIT 50 cap matches D-26 page size', () => {
    expect(HANDLER_SOURCE).toContain('LIMIT ${PAGE_SIZE}');
    expect(HANDLER_SOURCE).toContain('PAGE_SIZE = 50');
  });

  it('response body includes elapsed_ms server-timing budget marker', () => {
    expect(HANDLER_SOURCE).toContain('elapsed_ms');
    expect(HANDLER_SOURCE).toContain('server-timing');
  });
});
