/**
 * @kos/azure-search query.ts tests — Phase 6 Plan 06-03 Task 1.
 *
 * Mocks `@azure/search-documents` SDK + `./client.js` + `./embed.js` so the
 * pure shaping logic (filter assembly, hit mapping, vector kNN config,
 * semantic reranker config) can be asserted without a live Azure call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock state — captured per-call so tests assert exactly what was sent.
const sdkCalls: Array<{ rawText: string; opts: unknown }> = [];

let mockResults: Array<{ document: Record<string, unknown>; score?: number; rerankerScore?: number }> = [];

vi.mock('../src/client.js', () => ({
  getAzureSearchClient: vi.fn(async () => ({
    search: async (rawText: string, opts: unknown) => {
      sdkCalls.push({ rawText, opts });
      return {
        results: (async function* () {
          for (const r of mockResults) yield r;
        })(),
      };
    },
  })),
}));

vi.mock('../src/embed.js', () => ({
  embedText: vi.fn(async () => Array(1024).fill(0.0123)),
}));

import { hybridQuery } from '../src/query.js';
import { embedText } from '../src/embed.js';

beforeEach(() => {
  sdkCalls.length = 0;
  mockResults = [];
  vi.clearAllMocks();
});

describe('hybridQuery — request shaping', () => {
  it('issues a single Azure search call carrying BM25 text + vector + semantic reranker config', async () => {
    mockResults = [];
    await hybridQuery({ rawText: 'Damien konvertibellån', entityIds: [], topK: 10 });
    expect(sdkCalls).toHaveLength(1);
    const { rawText, opts } = sdkCalls[0]!;
    // BM25 keyword input flows in as the first argument.
    expect(rawText).toBe('Damien konvertibellån');
    const o = opts as {
      top?: number;
      vectorSearchOptions?: { queries?: Array<{ kind: string; vector: unknown; fields: string[]; kNearestNeighborsCount: number }> };
      queryType?: string;
      semanticSearchOptions?: { configurationName?: string; captions?: { captionType?: string } };
    };
    // top=10 forwarded; vector kNN at 50 (RRF input ratio per Azure recommendation).
    expect(o.top).toBe(10);
    expect(o.vectorSearchOptions?.queries).toHaveLength(1);
    expect(o.vectorSearchOptions?.queries?.[0]?.kind).toBe('vector');
    expect(o.vectorSearchOptions?.queries?.[0]?.fields).toEqual(['content_vector']);
    expect(o.vectorSearchOptions?.queries?.[0]?.kNearestNeighborsCount).toBe(50);
    // Semantic reranker enabled via kos-semantic configuration.
    expect(o.queryType).toBe('semantic');
    expect(o.semanticSearchOptions?.configurationName).toBe('kos-semantic');
    expect(o.semanticSearchOptions?.captions?.captionType).toBe('extractive');
  });

  it('embeds the query text with input_type=search_query (Cohere v4 query embedding)', async () => {
    mockResults = [];
    await hybridQuery({ rawText: 'Tale Forge Skolpilot', entityIds: [], topK: 5 });
    expect(embedText).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Tale Forge Skolpilot', inputType: 'search_query' }),
    );
  });

  it('topK default is 10 when omitted; explicit override is forwarded', async () => {
    mockResults = [];
    await hybridQuery({ rawText: 'a', entityIds: [] });
    expect((sdkCalls[0]!.opts as { top?: number }).top).toBe(10);
    sdkCalls.length = 0;
    await hybridQuery({ rawText: 'b', entityIds: [], topK: 25 });
    expect((sdkCalls[0]!.opts as { top?: number }).top).toBe(25);
  });

  it('builds entity_ids OData filter when entityIds is non-empty', async () => {
    mockResults = [];
    await hybridQuery({
      rawText: 'q',
      entityIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
    });
    const filter = (sdkCalls[0]!.opts as { filter?: string }).filter;
    expect(filter).toContain('entity_ids');
    expect(filter).toContain("11111111-1111-1111-1111-111111111111");
    expect(filter).toContain("22222222-2222-2222-2222-222222222222");
  });

  it('omits filter when entityIds is empty', async () => {
    mockResults = [];
    await hybridQuery({ rawText: 'q', entityIds: [] });
    expect((sdkCalls[0]!.opts as { filter?: string }).filter).toBeUndefined();
  });

  it('returns hits=[] for empty rawText without calling Azure', async () => {
    const out = await hybridQuery({ rawText: '   ', entityIds: [] });
    expect(out.hits).toEqual([]);
    expect(sdkCalls).toHaveLength(0);
    expect(out.semantic_reranker_applied).toBe(false);
  });
});

describe('hybridQuery — result mapping', () => {
  it('maps Azure result documents into SearchHit shape (entity source)', async () => {
    mockResults = [
      {
        document: {
          id: 'entity:abc',
          source: 'entity',
          title: 'Damien Mathiot',
          snippet: 'Co-founder at Outbehaving · CTO',
          entity_ids: ['ent-1'],
          indexed_at: '2026-04-24T10:00:00Z',
        },
        score: 0.42,
        rerankerScore: 1.87,
      },
    ];
    const out = await hybridQuery({ rawText: 'Damien', entityIds: [] });
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]).toMatchObject({
      id: 'entity:abc',
      source: 'entity',
      title: 'Damien Mathiot',
      snippet: 'Co-founder at Outbehaving · CTO',
      score: 0.42,
      reranker_score: 1.87,
      entity_ids: ['ent-1'],
      indexed_at: '2026-04-24T10:00:00Z',
    });
  });

  it('handles missing rerankerScore (sets reranker_score=null)', async () => {
    mockResults = [
      {
        document: {
          id: 'project:xyz',
          source: 'project',
          title: 'Tale Forge',
          snippet: 'Swedish-first AI storytelling',
          entity_ids: [],
          indexed_at: '2026-04-23T12:00:00Z',
        },
        score: 0.31,
      },
    ];
    const out = await hybridQuery({ rawText: 'tale forge', entityIds: [] });
    expect(out.hits[0]?.reranker_score).toBeNull();
  });

  it('records elapsed_ms as a non-negative integer', async () => {
    mockResults = [];
    const out = await hybridQuery({ rawText: 'q', entityIds: [] });
    expect(out.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(out.elapsed_ms)).toBe(true);
  });

  it('flags semantic_reranker_applied=true on a non-empty query (semantic config sent)', async () => {
    mockResults = [];
    const out = await hybridQuery({ rawText: 'something', entityIds: [] });
    expect(out.semantic_reranker_applied).toBe(true);
  });
});

describe('IN-01: UUID validation guard (Plan 06-08)', () => {
  it('throws when an entityId is not a UUID', async () => {
    await expect(
      hybridQuery({ rawText: 'foo', entityIds: ['not-a-uuid'] }),
    ).rejects.toThrow(/not a UUID/);
  });

  it('throws with the offending value in the message', async () => {
    await expect(
      hybridQuery({ rawText: 'foo', entityIds: ['injection-attempt;DROP TABLE x'] }),
    ).rejects.toThrow(/injection-attempt/);
  });

  it('does not throw for valid UUIDs', async () => {
    // The harness's mock for getAzureSearchClient resolves; we only need to
    // assert the UUID guard does NOT raise.
    let validationThrew = false;
    try {
      await hybridQuery({
        rawText: 'foo',
        entityIds: ['11111111-1111-1111-1111-111111111111'],
      });
    } catch (e) {
      // Anything not matching /not a UUID/ is fine; we only want to assert
      // the guard itself didn't raise.
      if (/not a UUID/.test((e as Error).message)) {
        validationThrew = true;
      }
    }
    expect(validationThrew).toBe(false);
  });

  it('accepts empty entityIds (no-filter degraded path)', async () => {
    let validationThrew = false;
    try {
      await hybridQuery({ rawText: 'foo', entityIds: [] });
    } catch (e) {
      if (/not a UUID/.test((e as Error).message)) {
        validationThrew = true;
      }
    }
    expect(validationThrew).toBe(false);
  });
});
