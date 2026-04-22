import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import { entityIndex } from '../src/schema.js';
import { KEVIN_OWNER_ID } from '../src/owner.js';

// Drizzle PgTable exposes a sentinel Symbol via `is(x, PgTable)` but keeping
// the check lightweight: every exported table object has a `getSQL` method and
// reports its name via getTableName.
const tableExports = Object.entries(schema).filter(([, v]) => {
  if (!v || typeof v !== 'object') return false;
  try {
    getTableName(v as never);
    return true;
  } catch {
    return false;
  }
});

describe('schema: owner_id sweep', () => {
  it('exports at least 8 tables (7 original + kevin_context)', () => {
    expect(tableExports.length).toBeGreaterThanOrEqual(8);
  });

  it('every exported table has an owner_id column', () => {
    for (const [name, table] of tableExports) {
      const cols = getTableColumns(table as never);
      expect(cols, `table ${name} is missing owner_id`).toHaveProperty('ownerId');
    }
  });

  it('KEVIN_OWNER_ID is a valid RFC 4122 v4 UUID (hex-only)', () => {
    expect(KEVIN_OWNER_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('KEVIN_OWNER_ID contains no "kevn" substring (catch placeholder regressions)', () => {
    expect(KEVIN_OWNER_ID.toLowerCase()).not.toContain('kevn');
  });
});

describe('schema: Phase 2 migration 0003', () => {
  it('entity_index.embedding is 1024-dim (Cohere Embed Multilingual v3)', () => {
    const cols = getTableColumns(entityIndex);
    // drizzle pgvector column exposes the dimensions via the column config
    const embeddingCol = cols.embedding as unknown as { dimensions?: number };
    expect(embeddingCol.dimensions).toBe(1024);
  });

  it('entity_index has embedding_model text column (D-05 provenance)', () => {
    const cols = getTableColumns(entityIndex);
    expect(cols).toHaveProperty('embeddingModel');
  });
});
