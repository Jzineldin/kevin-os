import { describe, it, expect } from 'vitest';
import {
  KOS_MEMORY_INDEX_DEFINITION,
  KOS_MEMORY_INDEX_NAME,
} from '../src/index-schema.js';

describe('Azure index schema', () => {
  it('has binaryQuantization compression at creation', () => {
    expect(KOS_MEMORY_INDEX_DEFINITION.vectorSearch.compressions[0].kind).toBe(
      'binaryQuantization',
    );
  });

  it('rescoreStorageMethod is preserveOriginals', () => {
    expect(
      KOS_MEMORY_INDEX_DEFINITION.vectorSearch.compressions[0].rescoringOptions
        .rescoreStorageMethod,
    ).toBe('preserveOriginals');
  });

  it('has an owner_id filterable field', () => {
    const f = KOS_MEMORY_INDEX_DEFINITION.fields.find(
      (x) => x.name === 'owner_id',
    );
    expect(f?.filterable).toBe(true);
  });

  it('content_vector.dimensions === 1024 (Phase 2 D-06 Cohere Embed Multilingual v3)', () => {
    const f = KOS_MEMORY_INDEX_DEFINITION.fields.find(
      (x) => x.name === 'content_vector',
    );
    // dimensions is only present on vector fields; narrow via cast.
    expect((f as { dimensions?: number } | undefined)?.dimensions).toBe(1024);
  });

  it('semantic config kos-semantic exists', () => {
    expect(KOS_MEMORY_INDEX_DEFINITION.semantic.configurations[0].name).toBe(
      'kos-semantic',
    );
  });

  it('index name is kos-memory-v1 (bump on breaking schema change)', () => {
    expect(KOS_MEMORY_INDEX_NAME).toBe('kos-memory-v1');
    expect(KOS_MEMORY_INDEX_DEFINITION.name).toBe('kos-memory-v1');
  });
});
