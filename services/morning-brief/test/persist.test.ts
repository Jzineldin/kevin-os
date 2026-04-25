/**
 * Phase 7 Plan 07-01 Task 2 — persist.ts unit tests.
 *
 * Covers the agent_runs idempotency claim, top3_membership fan-out write,
 * and the dropped_threads_v / email_drafts read shapes.
 *
 * pg.Pool is fully mocked — these are pure-SQL unit tests.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  insertAgentRunStarted,
  writeTop3Membership,
  loadDroppedThreads,
  loadDraftsReady,
} from '../src/persist.js';

function makePool(scripted: Array<{ rows: any[]; rowCount?: number }>) {
  let i = 0;
  const query = vi.fn(async () => {
    const next = scripted[i++] ?? { rows: [], rowCount: 0 };
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  });
  return { query } as any;
}

describe('insertAgentRunStarted', () => {
  it('returns true on first call (no prior row), then false on duplicate (prior ok row)', async () => {
    // Sequence: SELECT prior → empty (claim succeeds, INSERT happens).
    const firstPool = makePool([
      { rows: [], rowCount: 0 }, // prior ok row check
      { rows: [{ id: 'run-1' }], rowCount: 1 }, // INSERT returning id
    ]);
    const r1 = await insertAgentRunStarted(firstPool, {
      captureId: 'cap-1',
      ownerId: 'o-1',
      agentName: 'morning-brief',
    });
    expect(r1).toBe(true);
    expect(firstPool.query).toHaveBeenCalledTimes(2);

    // Second pool: prior row already exists.
    const secondPool = makePool([
      { rows: [{ id: 'run-1' }], rowCount: 1 }, // prior ok row exists
    ]);
    const r2 = await insertAgentRunStarted(secondPool, {
      captureId: 'cap-1',
      ownerId: 'o-1',
      agentName: 'morning-brief',
    });
    expect(r2).toBe(false);
    expect(secondPool.query).toHaveBeenCalledTimes(1);
  });
});

describe('writeTop3Membership', () => {
  it('writes N rows where N = sum of top_three[i].entity_ids.length pairs', async () => {
    const pool = makePool([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    await writeTop3Membership(pool, {
      ownerId: 'o-1',
      captureId: 'cap-1',
      briefDateStockholm: '2026-04-25',
      briefKind: 'morning-brief',
      topThree: [
        { title: 'A', entity_ids: ['e-1', 'e-2'], urgency: 'high' },
        { title: 'B', entity_ids: ['e-3'], urgency: 'med' },
      ],
    });
    // 2 + 1 = 3 rows total.
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('inserts brief_date as Stockholm-local date (passes through unchanged)', async () => {
    const pool = makePool([{ rows: [], rowCount: 1 }]);
    await writeTop3Membership(pool, {
      ownerId: 'o-1',
      captureId: 'cap-1',
      briefDateStockholm: '2026-04-25',
      briefKind: 'morning-brief',
      topThree: [{ title: 'A', entity_ids: ['e-1'], urgency: 'high' }],
    });
    const args = pool.query.mock.calls[0];
    expect(args[1]).toContain('2026-04-25');
  });
});

describe('loadDroppedThreads', () => {
  it('SELECTs from dropped_threads_v and maps to expected shape', async () => {
    const lastTime = new Date('2026-04-22T08:00:00.000Z');
    const pool = makePool([
      {
        rows: [
          {
            entity_id: 'e-1',
            title: 'Almi follow-up',
            last_mentioned_at: lastTime,
          },
          {
            entity_id: 'e-2',
            title: 'TaleForge investor',
            last_mentioned_at: null,
          },
        ],
      },
    ]);
    const out = await loadDroppedThreads(pool, 'o-1');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: 'Almi follow-up',
      entity_ids: ['e-1'],
      last_mentioned_at: lastTime.toISOString(),
    });
    expect(out[1]!.last_mentioned_at).toBeNull();
    const sql = pool.query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/dropped_threads_v/);
  });
});

describe('loadDraftsReady', () => {
  it('returns [] when email_drafts table missing (graceful Phase 4 degradation)', async () => {
    // Simulate "relation email_drafts does not exist" by throwing a pg error
    // with code 42P01.
    const error = Object.assign(new Error('relation "email_drafts" does not exist'), {
      code: '42P01',
    });
    const pool = {
      query: vi.fn(async () => {
        throw error;
      }),
    } as any;
    const out = await loadDraftsReady(pool, 'o-1', 10);
    expect(out).toEqual([]);
  });

  it('maps rows when email_drafts is present', async () => {
    const pool = makePool([
      {
        rows: [
          {
            draft_id: '11111111-2222-4333-8444-555555555555',
            from: 'damien@almi.se',
            subject: 'Convertible loan',
            classification: 'urgent',
          },
        ],
      },
    ]);
    const out = await loadDraftsReady(pool, 'o-1', 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.classification).toBe('urgent');
  });
});
