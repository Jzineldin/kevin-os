/**
 * cache.test.ts — entity_dossiers_cached read/write/invalidate + last_touch_hash.
 *
 * Phase 6 Plan 06-05 Task 1.
 *
 * Uses an in-memory mock pg pool that records SQL invocations and returns
 * canned rows. Avoids spinning up a real Postgres for unit-test scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeLastTouchHash,
  readDossierCache,
  writeDossierCache,
  invalidateDossierCache,
} from '../src/cache.js';
import type { ContextBundle } from '@kos/contracts/context';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function mockPool(rows: unknown[] = []): MockPool {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  };
}

const OWNER = '00000000-0000-0000-0000-000000000001';
const ENTITY_A = '11111111-1111-1111-1111-111111111111';
const ENTITY_B = '22222222-2222-2222-2222-222222222222';

describe('computeLastTouchHash', () => {
  it('returns a deterministic 16-char hex prefix for the same input', () => {
    const a = computeLastTouchHash({ name: 'Damien', last_touch: '2026-04-20', recent_mention_count: 3 });
    const b = computeLastTouchHash({ name: 'Damien', last_touch: '2026-04-20', recent_mention_count: 3 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it('differs when last_touch changes', () => {
    const a = computeLastTouchHash({ name: 'Damien', last_touch: '2026-04-20', recent_mention_count: 3 });
    const b = computeLastTouchHash({ name: 'Damien', last_touch: '2026-04-21', recent_mention_count: 3 });
    expect(a).not.toBe(b);
  });

  it('differs when recent_mention_count changes', () => {
    const a = computeLastTouchHash({ name: 'Damien', last_touch: '2026-04-20', recent_mention_count: 3 });
    const b = computeLastTouchHash({ name: 'Damien', last_touch: '2026-04-20', recent_mention_count: 4 });
    expect(a).not.toBe(b);
  });

  it('handles null last_touch', () => {
    const h = computeLastTouchHash({ name: 'Damien', last_touch: null, recent_mention_count: 0 });
    expect(h).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('readDossierCache', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns empty Map when entityIds is empty (no SQL fired)', async () => {
    const pool = mockPool();
    const map = await readDossierCache({ pool: pool as never, ownerId: OWNER, entityIds: [] });
    expect(map.size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns Map keyed by entity_id when rows are present', async () => {
    const row = {
      entity_id: ENTITY_A,
      owner_id: OWNER,
      last_touch_hash: 'abc',
      bundle: { fake: 'bundle' },
      created_at: new Date(),
      expires_at: new Date(Date.now() + 3600_000),
    };
    const pool = mockPool([row]);
    const map = await readDossierCache({
      pool: pool as never,
      ownerId: OWNER,
      entityIds: [ENTITY_A],
    });
    expect(map.size).toBe(1);
    expect(map.get(ENTITY_A)?.last_touch_hash).toBe('abc');
  });

  it('issues parameterised query with owner_id + entity_id ANY-array filter + expires_at > now()', async () => {
    const pool = mockPool();
    await readDossierCache({
      pool: pool as never,
      ownerId: OWNER,
      entityIds: [ENTITY_A, ENTITY_B],
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool.query.mock.calls[0]!;
    const sql = call[0] as string;
    const params = call[1] as unknown[];
    expect(sql).toContain('FROM entity_dossiers_cached');
    expect(sql).toContain('owner_id = $1');
    expect(sql).toContain('entity_id = ANY($2::uuid[])');
    expect(sql).toContain('expires_at > now()');
    expect(params).toEqual([OWNER, [ENTITY_A, ENTITY_B]]);
  });
});

describe('writeDossierCache', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('UPSERTs with ON CONFLICT (entity_id, owner_id) DO UPDATE', async () => {
    const pool = mockPool();
    const bundle: ContextBundle = {
      kevin_context: {
        current_priorities: '',
        active_deals: '',
        whos_who: '',
        blocked_on: '',
        recent_decisions: '',
        open_questions: '',
        last_updated: null,
      },
      entity_dossiers: [],
      recent_mentions: [],
      semantic_chunks: [],
      linked_projects: [],
      assembled_markdown: '',
      elapsed_ms: 0,
      cache_hit: false,
      partial: false,
      partial_reasons: [],
    };
    await writeDossierCache({
      pool: pool as never,
      ownerId: OWNER,
      entityId: ENTITY_A,
      lastTouchHash: 'hash-1',
      bundle,
      ttlSeconds: 600,
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool.query.mock.calls[0]!;
    const sql = call[0] as string;
    const params = call[1] as unknown[];
    expect(sql).toContain('INSERT INTO entity_dossiers_cached');
    expect(sql).toContain('ON CONFLICT (entity_id, owner_id) DO UPDATE');
    expect(params[0]).toBe(ENTITY_A);
    expect(params[1]).toBe(OWNER);
    expect(params[2]).toBe('hash-1');
    expect(typeof params[3]).toBe('string'); // JSON-serialised bundle
    expect(params[4]).toBe(600);
  });

  it('defaults TTL to 3600 seconds (1h belt) when ttlSeconds omitted', async () => {
    const pool = mockPool();
    await writeDossierCache({
      pool: pool as never,
      ownerId: OWNER,
      entityId: ENTITY_A,
      lastTouchHash: 'hash-1',
      bundle: {} as ContextBundle,
    });
    const call = pool.query.mock.calls[0]!;
    const params = call[1] as unknown[];
    expect(params[4]).toBe(3600);
  });
});

describe('invalidateDossierCache', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('no-ops on empty entityIds', async () => {
    const pool = mockPool();
    await invalidateDossierCache({ pool: pool as never, ownerId: OWNER, entityIds: [] });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('issues DELETE keyed by owner_id + entity_id ANY-array', async () => {
    const pool = mockPool();
    await invalidateDossierCache({
      pool: pool as never,
      ownerId: OWNER,
      entityIds: [ENTITY_A, ENTITY_B],
    });
    const call = pool.query.mock.calls[0]!;
    const sql = call[0] as string;
    const params = call[1] as unknown[];
    expect(sql).toContain('DELETE FROM entity_dossiers_cached');
    expect(sql).toContain('owner_id = $1');
    expect(sql).toContain('entity_id = ANY($2::uuid[])');
    expect(params).toEqual([OWNER, [ENTITY_A, ENTITY_B]]);
  });
});
