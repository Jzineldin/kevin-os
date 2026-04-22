import { describe, it, expect, vi } from 'vitest';
import { findCandidates, hasProjectCooccurrence } from '../src/candidates.js';

const mkPool = (rows: unknown[]) =>
  ({ query: vi.fn().mockResolvedValue({ rows }) }) as never;

describe('findCandidates', () => {
  const emb = new Array(1024).fill(0);

  it('returns empty array on empty mention', async () => {
    const pool = mkPool([]);
    const res = await findCandidates(pool, { mention: '', ownerId: 'owner', embedding: emb });
    expect(res).toEqual([]);
    expect((pool as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('rejects embedding ≠ 1024 dims', async () => {
    const pool = mkPool([]);
    await expect(
      findCandidates(pool, { mention: 'x', ownerId: 'o', embedding: [0] }),
    ).rejects.toThrow(/1024/);
  });

  it('lowercases mention and passes ownerId + vector literal as params', async () => {
    const pool = mkPool([]);
    await findCandidates(pool, { mention: 'Damien', ownerId: 'o1', embedding: emb });
    const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> };
    const call = mockPool.query.mock.calls[0]!;
    const sql = call[0] as string;
    const params = call[1] as string[];
    expect(sql).toContain('similarity');
    expect(params[0]).toBe('damien');
    expect(params[1]).toBe('o1');
    expect(params[2]).toMatch(/^\[0(,0)+\]$/);
  });

  it('maps SQL rows into Candidate shape and computes stage correctly', async () => {
    const pool = mkPool([
      {
        id: 'e1',
        name: 'Damien Lovell',
        aliases: ['Damien'],
        linked_projects: ['proj-a'],
        type: 'Person',
        role: null,
        org: null,
        last_touch: null,
        trigram_score: 0.833,
        cosine_score: 0.7,
        hybrid_score: 0.7399,
      },
      {
        id: 'e2',
        name: 'Other',
        aliases: [],
        linked_projects: [],
        type: 'Person',
        role: null,
        org: null,
        last_touch: null,
        trigram_score: 0.2,
        cosine_score: 0.1,
        hybrid_score: 0.13,
      },
    ]);
    const res = await findCandidates(pool, { mention: 'Damian', ownerId: 'o', embedding: emb });
    expect(res[0]!.name).toBe('Damien Lovell');
    expect(res[0]!.stage).toBe('inbox'); // 0.7399 < 0.75 → inbox; explicit boundary test
    expect(res[1]!.stage).toBe('inbox');
  });
});

describe('hasProjectCooccurrence', () => {
  it('returns true when overlap exists', () => {
    const c = { linkedProjects: ['a', 'b'] } as never;
    expect(hasProjectCooccurrence(c, ['b', 'c'])).toBe(true);
  });
  it('returns false when no overlap', () => {
    const c = { linkedProjects: ['a'] } as never;
    expect(hasProjectCooccurrence(c, ['b'])).toBe(false);
  });
  it('returns false when captureProjectIds is empty', () => {
    const c = { linkedProjects: ['a'] } as never;
    expect(hasProjectCooccurrence(c, [])).toBe(false);
  });
});
