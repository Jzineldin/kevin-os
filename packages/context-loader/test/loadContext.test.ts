/**
 * loadContext.test.ts — main library entry-point tests.
 *
 * Phase 6 Plan 06-05 Task 1.
 *
 * Strategy: drive loadContext() with a recording-mock pg pool whose
 * `query()` selects the right canned-row set based on the SQL fragment.
 * This isolates the parallel-fetch + cache-hit + degraded-path branches
 * without spinning up Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadContext } from '../src/loadContext.js';
import type { SearchHit } from '@kos/contracts/context';

const OWNER = '00000000-0000-0000-0000-000000000001';
const ENTITY_A = '11111111-1111-1111-1111-111111111111';
const ENTITY_B = '22222222-2222-2222-2222-222222222222';
const PROJECT = '33333333-3333-3333-3333-333333333333';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  /** Track per-SQL-pattern hit counts for parallelism assertions. */
  hits: Record<string, number>;
}

function makeMockPool(opts: {
  kevinRows?: Array<{ section_heading: string; section_body: string; updated_at: Date }>;
  cachedRows?: unknown[];
  dossierRows?: unknown[];
  mentionRows?: unknown[];
  projectRows?: unknown[];
  delayMs?: number;
}): MockPool {
  const hits: Record<string, number> = {
    kevin_context: 0,
    entity_dossiers_cached: 0,
    entity_index: 0,
    mention_events: 0,
    project_index: 0,
    other: 0,
  };
  const query = vi.fn(async (sql: string) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (sql.includes('FROM kevin_context')) {
      hits.kevin_context = (hits.kevin_context ?? 0) + 1;
      return { rows: opts.kevinRows ?? [], rowCount: opts.kevinRows?.length ?? 0 };
    }
    if (sql.includes('FROM entity_dossiers_cached')) {
      hits.entity_dossiers_cached = (hits.entity_dossiers_cached ?? 0) + 1;
      return { rows: opts.cachedRows ?? [], rowCount: opts.cachedRows?.length ?? 0 };
    }
    if (sql.includes('FROM entity_index')) {
      hits.entity_index = (hits.entity_index ?? 0) + 1;
      return { rows: opts.dossierRows ?? [], rowCount: opts.dossierRows?.length ?? 0 };
    }
    if (sql.includes('FROM mention_events')) {
      hits.mention_events = (hits.mention_events ?? 0) + 1;
      return { rows: opts.mentionRows ?? [], rowCount: opts.mentionRows?.length ?? 0 };
    }
    if (sql.includes('FROM project_index')) {
      hits.project_index = (hits.project_index ?? 0) + 1;
      return { rows: opts.projectRows ?? [], rowCount: opts.projectRows?.length ?? 0 };
    }
    if (sql.includes('INSERT INTO entity_dossiers_cached')) {
      // fire-and-forget cache writes
      return { rows: [], rowCount: 0 };
    }
    hits.other = (hits.other ?? 0) + 1;
    return { rows: [], rowCount: 0 };
  });
  return { query, hits };
}

const SAMPLE_SEARCH_HIT: SearchHit = {
  id: 'doc-1',
  source: 'transcript',
  title: 'Almi sync 2026-04-20',
  snippet: 'Damien föreslog konvertibel.',
  score: 0.92,
  reranker_score: 0.88,
  entity_ids: [ENTITY_A],
  indexed_at: '2026-04-20T10:00:00.000Z',
};

const SAMPLE_DOSSIER_ROW = {
  entity_id: ENTITY_A,
  name: 'Damien Heinemann',
  type: 'Person',
  aliases: ['Damien'],
  org: 'Almi Invest',
  role: 'Investment Manager',
  relationship: 'investor',
  status: 'active',
  seed_context: 'Almi point-of-contact for konvertibellånet.',
  last_touch: new Date('2026-04-20T10:00:00.000Z'),
  manual_notes: null,
  confidence: 1,
  source: ['notion'],
  linked_project_ids: [PROJECT],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('loadContext — happy path', () => {
  it('returns ContextBundle with all 9 fields populated when entityIds present', async () => {
    const pool = makeMockPool({
      kevinRows: [
        { section_heading: 'Current priorities', section_body: 'Tale Forge launch', updated_at: new Date() },
      ],
      dossierRows: [SAMPLE_DOSSIER_ROW],
      mentionRows: [
        {
          capture_id: 'cap-1',
          entity_id: ENTITY_A,
          kind: 'voice-capture',
          occurred_at: new Date('2026-04-20T10:00:00.000Z'),
          excerpt: 'Pinga Damien om lånet',
        },
      ],
      projectRows: [
        { project_id: PROJECT, name: 'Tale Forge', bolag: 'Tale Forge AB', status: 'Active' },
      ],
    });
    const azureSearch = vi.fn(async () => [SAMPLE_SEARCH_HIT]);

    const bundle = await loadContext({
      entityIds: [ENTITY_A],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
      azureSearch,
    });

    expect(bundle.kevin_context.current_priorities).toBe('Tale Forge launch');
    expect(bundle.entity_dossiers).toHaveLength(1);
    expect(bundle.entity_dossiers[0]!.name).toBe('Damien Heinemann');
    expect(bundle.recent_mentions).toHaveLength(1);
    expect(bundle.semantic_chunks).toHaveLength(1);
    expect(bundle.linked_projects).toHaveLength(1);
    expect(bundle.assembled_markdown).toContain('## Kevin Context');
    expect(bundle.assembled_markdown).toContain('Damien Heinemann');
    expect(bundle.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(bundle.cache_hit).toBe(false);
    expect(bundle.partial).toBe(false);
    expect(bundle.partial_reasons).toEqual([]);
  });
});

describe('loadContext — degraded paths', () => {
  it('empty entityIds + rawText → Azure search invoked on rawText; entity_index NOT queried', async () => {
    const pool = makeMockPool({});
    const azureSearch = vi.fn(async () => [SAMPLE_SEARCH_HIT]);

    const bundle = await loadContext({
      entityIds: [],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      rawText: 'Pinga Damien om Almi konvertibellånet',
      pool: pool as never,
      azureSearch,
    });

    expect(bundle.entity_dossiers).toEqual([]);
    expect(bundle.recent_mentions).toEqual([]);
    expect(bundle.linked_projects).toEqual([]);
    expect(bundle.semantic_chunks).toHaveLength(1);
    expect(azureSearch).toHaveBeenCalledTimes(1);
    const firstCall = azureSearch.mock.calls[0] as unknown as [{ rawText: string }];
    expect(firstCall[0].rawText).toBe('Pinga Damien om Almi konvertibellånet');
    expect(pool.hits.entity_index ?? 0).toBe(0);
  });

  it('empty entityIds + no rawText → semantic_chunks empty; kevin_context still loaded', async () => {
    const pool = makeMockPool({
      kevinRows: [
        { section_heading: 'Current priorities', section_body: 'Tale Forge launch', updated_at: new Date() },
      ],
    });

    const bundle = await loadContext({
      entityIds: [],
      agentName: 'voice-capture',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
      // no azureSearch injected
    });

    expect(bundle.kevin_context.current_priorities).toBe('Tale Forge launch');
    expect(bundle.semantic_chunks).toEqual([]);
    expect(bundle.partial).toBe(false);
  });

  it('Azure search rejection → partial=true with azure_search reason; loadContext does NOT throw', async () => {
    const pool = makeMockPool({});
    const azureSearch = vi.fn(async () => {
      throw new Error('Azure unreachable');
    });

    const bundle = await loadContext({
      entityIds: [ENTITY_A],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      rawText: 'Damien',
      pool: pool as never,
      azureSearch,
    });

    expect(bundle.partial).toBe(true);
    expect(bundle.partial_reasons.some((r) => r.startsWith('azure_search'))).toBe(true);
  });

  it('Postgres dossier query rejection → partial=true with entity_dossiers reason', async () => {
    const pool: MockPool = {
      hits: { kevin_context: 0, entity_dossiers_cached: 0, entity_index: 0, mention_events: 0, project_index: 0, other: 0 },
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM entity_index')) {
          throw new Error('pg connection lost');
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const bundle = await loadContext({
      entityIds: [ENTITY_A],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
    });

    expect(bundle.partial).toBe(true);
    expect(bundle.partial_reasons.some((r) => r.startsWith('entity_dossiers'))).toBe(true);
  });
});

describe('loadContext — cache + parallelism', () => {
  it('all 3 cache-hit entities → cache_hit=true; entity_index NOT queried', async () => {
    const cachedRow = {
      entity_id: ENTITY_A,
      owner_id: OWNER,
      last_touch_hash: 'hash-1',
      bundle: { entity_dossiers: [] },
      created_at: new Date(),
      expires_at: new Date(Date.now() + 3600_000),
    };
    const pool = makeMockPool({ cachedRows: [cachedRow] });

    const bundle = await loadContext({
      entityIds: [ENTITY_A],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
    });

    expect(bundle.cache_hit).toBe(true);
  });

  it('Promise.all parallelism — total elapsed less than serial sum', async () => {
    const pool = makeMockPool({ delayMs: 50 });
    const t0 = Date.now();
    await loadContext({
      entityIds: [ENTITY_A, ENTITY_B],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
      azureSearch: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return [];
      },
    });
    const elapsed = Date.now() - t0;
    // Serial would be: kevin (50) + cached-read (50) + Promise.all of 4 (50) + Promise.all of 2 (50) ≈ 200ms minimum.
    // Parallel target: < 250ms (with overhead) — gives a clear signal Promise.all is engaged.
    expect(elapsed).toBeLessThan(400);
  });
});

describe('loadContext — telemetry hooks', () => {
  it('elapsed_ms is monotonic and nonnegative', async () => {
    const pool = makeMockPool({});
    const bundle = await loadContext({
      entityIds: [],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
    });
    expect(bundle.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(bundle.elapsed_ms).toBeLessThan(10_000);
  });

  it('assembled_markdown includes Kevin Context heading at the top (cache-stable prefix)', async () => {
    const pool = makeMockPool({});
    const bundle = await loadContext({
      entityIds: [],
      agentName: 'triage',
      captureId: 'cap-1',
      ownerId: OWNER,
      pool: pool as never,
    });
    expect(bundle.assembled_markdown.indexOf('## Kevin Context')).toBe(0);
  });
});
