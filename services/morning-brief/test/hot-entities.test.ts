/**
 * Phase 7 Plan 07-01 Task 2 — hot-entities query unit tests.
 *
 * Mocks pg.Pool. Verifies the SQL shape (last-N-hours window, GROUP BY,
 * ORDER BY count DESC, LIMIT) without hitting a real database.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadHotEntities } from '../src/hot-entities.js';

function makePool(rows: Array<{ entity_id: string; name: string; mention_count: number | string }>) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { query } as unknown as Parameters<typeof loadHotEntities>[0];
}

describe('loadHotEntities', () => {
  it('returns empty [] when no mention_events in window', async () => {
    const pool = makePool([]);
    const out = await loadHotEntities(pool, 'owner-1', 48, 10);
    expect(out).toEqual([]);
  });

  it('orders by mention_count DESC and respects limit', async () => {
    const pool = makePool([
      { entity_id: 'e-1', name: 'Damien', mention_count: '12' },
      { entity_id: 'e-2', name: 'Christina', mention_count: '7' },
      { entity_id: 'e-3', name: 'Almi', mention_count: '3' },
    ]);
    const out = await loadHotEntities(pool, 'owner-1', 48, 10);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ entity_id: 'e-1', name: 'Damien', mention_count: 12 });
    // SQL passed correct bind params (owner, hoursBack, limit).
    const { query } = pool as unknown as { query: ReturnType<typeof vi.fn> };
    expect(query).toHaveBeenCalledTimes(1);
    const callArgs = query.mock.calls[0]!;
    const sql = callArgs[0] as string;
    expect(sql).toMatch(/mention_events/);
    expect(sql).toMatch(/GROUP BY/i);
    expect(sql).toMatch(/ORDER BY count\(\*\) DESC/i);
    expect(callArgs[1]).toEqual(['owner-1', 48, 10]);
  });
});
