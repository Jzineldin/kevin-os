/**
 * Plan 02-08 Task 2 — notion-indexer entities-embedding tests.
 *
 * Verifies the entity_index embedding-population path added to upsert.ts:
 *   1. First sync (embed_hash IS NULL) → embedBatch called once + UPDATE
 *      writes {embedding, embedding_model='cohere.embed-multilingual-v3',
 *      embed_hash=sha256(text)}
 *   2. Re-sync with identical text (embed_hash matches) → embedBatch NOT
 *      called (Pitfall: Denial of Wallet) and no UPDATE issued
 *   3. embedBatch throws → upsert continues; no exception propagates;
 *      warn is logged; embedding stays unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { embedEntityIfNeeded, type DbExec } from '../src/upsert';

// Mock @kos/resolver before importing the function under test
vi.mock('@kos/resolver', () => ({
  EMBED_MODEL_ID: 'cohere.embed-multilingual-v3',
  buildEntityEmbedText: (e: any) =>
    [e.name, (e.aliases ?? []).join(', '), e.role ?? '', e.org ?? '', e.relationship ?? '', e.seedContext ?? '']
      .filter((s: string) => s.length > 0)
      .join(' | '),
  embedBatch: vi.fn(),
}));

import { embedBatch } from '@kos/resolver';

type QueryCall = { text: string; values?: unknown[] };

function makeFakeDb(opts: { storedHash?: string | null } = {}): DbExec & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (/SELECT embed_hash FROM entity_index/i.test(text)) {
        return {
          rowCount: 1,
          rows: [{ embed_hash: opts.storedHash ?? null }],
        };
      }
      if (/UPDATE entity_index/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

const ENTITY = {
  name: 'Damien Hateley',
  aliases: ['Damien'],
  seedContext: 'Outbehaving cofounder',
  role: 'CTO',
  org: 'Outbehaving',
  relationship: 'cofounder',
};

const EXPECTED_TEXT = 'Damien Hateley | Damien | CTO | Outbehaving | cofounder | Outbehaving cofounder';
const EXPECTED_HASH = createHash('sha256').update(EXPECTED_TEXT).digest('hex');

describe('embedEntityIfNeeded — Plan 02-08 Task 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first sync (embed_hash NULL) → embedBatch called + UPDATE writes vector + model + hash', async () => {
    const db = makeFakeDb({ storedHash: null });
    const fakeVec = new Array(1024).fill(0.001);
    (embedBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([fakeVec]);

    await embedEntityIfNeeded(db, 'page-1', ENTITY);

    // embedBatch called once with the D-08 text
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect((embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([EXPECTED_TEXT]);
    expect((embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('search_document');

    // UPDATE issued with the right model + hash
    const updates = db.calls.filter((c) => /UPDATE entity_index/i.test(c.text));
    expect(updates.length).toBe(1);
    const vals = updates[0]!.values as unknown[];
    // [vecLiteral, model, hash, page_id]
    expect(typeof vals[0]).toBe('string');
    expect(vals[0]).toContain('[0.001');
    expect(vals[1]).toBe('cohere.embed-multilingual-v3');
    expect(vals[2]).toBe(EXPECTED_HASH);
    expect(vals[3]).toBe('page-1');
  });

  it('re-sync with identical text (embed_hash matches) → embedBatch NOT called; NO update issued', async () => {
    const db = makeFakeDb({ storedHash: EXPECTED_HASH });

    await embedEntityIfNeeded(db, 'page-1', ENTITY);

    expect(embedBatch).not.toHaveBeenCalled();
    const updates = db.calls.filter((c) => /UPDATE entity_index/i.test(c.text));
    expect(updates.length).toBe(0);
  });

  it('embedBatch throws → upsert completes silently; warn logged; no UPDATE', async () => {
    const db = makeFakeDb({ storedHash: null });
    (embedBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Bedrock throttled'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Must NOT throw — the upsert path swallows embedding errors.
    await expect(embedEntityIfNeeded(db, 'page-1', ENTITY)).resolves.toBeUndefined();

    expect(embedBatch).toHaveBeenCalledTimes(1);
    const updates = db.calls.filter((c) => /UPDATE entity_index/i.test(c.text));
    expect(updates.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = String((warnSpy.mock.calls[0] ?? [])[0] ?? '');
    expect(warnArg).toContain('page-1');

    warnSpy.mockRestore();
  });
});
