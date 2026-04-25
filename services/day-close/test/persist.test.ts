/**
 * Phase 7 Plan 07-02 Task 1 — day-close persist.ts unit tests.
 *
 * Adds:
 *   - loadSlippedItemsForToday: reads top3_membership rows for today's morning
 *     brief that have NULL acted_on_at.
 *   - loadDecisionsHint: best-effort regex over recent mention_events.context.
 *
 * pg.Pool is fully mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  loadSlippedItemsForToday,
  loadDecisionsHint,
} from '../src/persist.js';

function makePool(scripted: Array<{ rows: any[]; rowCount?: number }>) {
  let i = 0;
  const query = vi.fn(async () => {
    const next = scripted[i++] ?? { rows: [], rowCount: 0 };
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  });
  return { query } as any;
}

describe('loadSlippedItemsForToday', () => {
  it('selects rows from top3_membership for morning-brief on today, acted_on_at NULL', async () => {
    const pool = makePool([
      {
        rows: [
          { entity_id: 'e-1', title: 'Almi follow-up', urgency: 'high' },
          { entity_id: 'e-2', title: 'TaleForge investor', urgency: 'med' },
        ],
      },
    ]);
    const out = await loadSlippedItemsForToday(pool, 'o-1', '2026-04-25');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      entity_id: 'e-1',
      title: 'Almi follow-up',
      urgency: 'high',
    });
    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/top3_membership/);
    expect(sql).toMatch(/morning-brief/);
    expect(sql).toMatch(/acted_on_at\s+IS\s+NULL/i);
  });

  it('returns [] when no slipped items', async () => {
    const pool = makePool([{ rows: [], rowCount: 0 }]);
    const out = await loadSlippedItemsForToday(pool, 'o-1', '2026-04-25');
    expect(out).toEqual([]);
  });
});

describe('loadDecisionsHint', () => {
  it('queries mention_events filtered by /decided|approved|signed|agreed/i regex over last 12h', async () => {
    const occurred = new Date('2026-04-25T09:32:00Z');
    const pool = makePool([
      {
        rows: [
          { occurred_at: occurred, context: 'Approved Almi convertible terms' },
          { occurred_at: occurred, context: 'Decided to push TaleForge launch by 1w' },
        ],
      },
    ]);
    const out = await loadDecisionsHint(pool, 'o-1');
    expect(out).toHaveLength(2);
    expect(out[0]!.context).toMatch(/Approved/i);
    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/mention_events/);
    expect(sql).toMatch(/12 hours|interval/i);
    expect(sql).toMatch(/decided|approved|agreed|signed/i);
  });

  it('returns [] gracefully when relation missing or query empty', async () => {
    const pool = makePool([{ rows: [], rowCount: 0 }]);
    const out = await loadDecisionsHint(pool, 'o-1');
    expect(out).toEqual([]);
  });
});
