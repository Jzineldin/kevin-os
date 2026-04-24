/**
 * @kos/azure-search upsert.ts tests — Phase 6 Plan 06-03 Task 1.
 *
 * Mocks `@azure/search-documents` SDK + `./client.js` + `./embed.js`.
 * Asserts:
 *   - empty input → no SDK call.
 *   - happy path → embed each doc + mergeOrUploadDocuments called once.
 *   - per-doc error surfaced into errors[].
 *   - vectors are 1024-dim floats per Cohere v4 contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdkCalls: Array<{ docs: unknown[] }> = [];
let mockResults: Array<{ key: string; succeeded: boolean; errorMessage?: string }> = [];

vi.mock('../src/client.js', () => ({
  getAzureSearchClient: vi.fn(async () => ({
    mergeOrUploadDocuments: async (docs: unknown[]) => {
      sdkCalls.push({ docs });
      return { results: mockResults };
    },
  })),
}));

vi.mock('../src/embed.js', () => ({
  embedText: vi.fn(async () => Array(1024).fill(0.5)),
}));

import { upsertDocuments } from '../src/upsert.js';
import { embedText } from '../src/embed.js';

beforeEach(() => {
  sdkCalls.length = 0;
  mockResults = [];
  vi.clearAllMocks();
});

describe('upsertDocuments', () => {
  it('empty input → no SDK call, returns zero counts', async () => {
    const out = await upsertDocuments({ documents: [] });
    expect(out).toEqual({ succeeded: 0, failed: 0, errors: [] });
    expect(sdkCalls).toHaveLength(0);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('embeds every document with input_type=search_document then issues one mergeOrUpload call', async () => {
    mockResults = [
      { key: 'entity:a', succeeded: true },
      { key: 'entity:b', succeeded: true },
    ];
    const out = await upsertDocuments({
      documents: [
        {
          id: 'entity:a',
          source: 'entity',
          title: 'A',
          snippet: 'a snippet',
          content_for_embedding: 'A | Person | Stockholm',
          entity_ids: ['ent-a'],
          indexed_at: '2026-04-24T10:00:00Z',
        },
        {
          id: 'entity:b',
          source: 'entity',
          title: 'B',
          snippet: 'b snippet',
          content_for_embedding: 'B | Person | Malmo',
          entity_ids: ['ent-b'],
          indexed_at: '2026-04-24T10:01:00Z',
        },
      ],
    });
    expect(embedText).toHaveBeenCalledTimes(2);
    expect(embedText).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: 'search_document', text: 'A | Person | Stockholm' }),
    );
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]!.docs).toHaveLength(2);
    expect(out).toEqual({ succeeded: 2, failed: 0, errors: [] });
  });

  it('attaches a 1024-dim content_vector to every uploaded document', async () => {
    mockResults = [{ key: 'project:x', succeeded: true }];
    await upsertDocuments({
      documents: [
        {
          id: 'project:x',
          source: 'project',
          title: 'Project X',
          snippet: 'snippet',
          content_for_embedding: 'project x body',
          entity_ids: [],
          indexed_at: '2026-04-24T10:00:00Z',
        },
      ],
    });
    const sentDocs = sdkCalls[0]!.docs as Array<{ content_vector: number[] }>;
    expect(sentDocs[0]?.content_vector).toHaveLength(1024);
    // every entry is a finite number (Cohere v4 returns floats)
    expect(sentDocs[0]?.content_vector.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('per-doc failure → entry surfaced into errors[] with `key: errorMessage`', async () => {
    mockResults = [
      { key: 'entity:ok', succeeded: true },
      { key: 'entity:bad', succeeded: false, errorMessage: 'document key invalid' },
    ];
    const out = await upsertDocuments({
      documents: [
        {
          id: 'entity:ok',
          source: 'entity',
          title: 'ok',
          snippet: '',
          content_for_embedding: 'ok',
          entity_ids: [],
          indexed_at: '2026-04-24T10:00:00Z',
        },
        {
          id: 'entity:bad',
          source: 'entity',
          title: 'bad',
          snippet: '',
          content_for_embedding: 'bad',
          entity_ids: [],
          indexed_at: '2026-04-24T10:00:00Z',
        },
      ],
    });
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.errors).toEqual(['entity:bad: document key invalid']);
  });

  it('per-doc failure with no errorMessage → no string entry in errors[]', async () => {
    mockResults = [{ key: 'project:silent', succeeded: false }];
    const out = await upsertDocuments({
      documents: [
        {
          id: 'project:silent',
          source: 'project',
          title: 'silent',
          snippet: '',
          content_for_embedding: 'silent',
          entity_ids: [],
          indexed_at: '2026-04-24T10:00:00Z',
        },
      ],
    });
    expect(out.failed).toBe(1);
    expect(out.errors).toEqual([]);
  });
});
