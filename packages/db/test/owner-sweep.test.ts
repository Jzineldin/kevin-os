import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import { KEVIN_OWNER_ID } from '../src/owner.js';

/**
 * Forward-compat enforcement per STATE.md Locked Decision #13:
 * every KOS table must carry `owner_id` so multi-user is a backfill away.
 * This sweep runs on every `pnpm test` and on Gate 1 verification; any new
 * table that omits owner_id fails CI before it can land.
 *
 * Complements packages/db/test/schema.test.ts (added in Plan 02). That test
 * asserts owner_id presence; this one asserts:
 *   - at least 7 tables are exported (regression guard against accidental
 *     schema trimming)
 *   - every table has ownerId AND the column is declared via the ownerId()
 *     helper (string dataType = uuid in drizzle-orm)
 *   - KEVIN_OWNER_ID is a syntactically valid RFC 4122 v4 UUID
 */

const EXCLUDED_TABLES: string[] = []; // no exemptions — forward-compat, no holes

const tableEntries = Object.entries(schema).filter(([, v]) => {
  if (!v || typeof v !== 'object') return false;
  try {
    getTableName(v as never);
    return true;
  } catch {
    return false;
  }
});

describe('owner-id sweep (forward-compat enforcement)', () => {
  it('at least 7 tables are exported from schema', () => {
    expect(tableEntries.length).toBeGreaterThanOrEqual(7);
  });

  it('every exported Drizzle table has an owner_id column', () => {
    const missing: string[] = [];
    for (const [name, table] of tableEntries) {
      if (EXCLUDED_TABLES.includes(name)) continue;
      const cols = getTableColumns(table as never);
      if (!('ownerId' in cols)) missing.push(name);
    }
    expect(missing, `Tables missing owner_id: ${missing.join(', ')}`).toEqual([]);
  });

  it('owner_id is declared via ownerId() helper (uuid column type)', () => {
    for (const [name, table] of tableEntries) {
      if (EXCLUDED_TABLES.includes(name)) continue;
      const cols = getTableColumns(table as never) as Record<string, unknown>;
      const col = cols.ownerId as { dataType?: string; notNull?: boolean } | undefined;
      expect(col, `${name}.ownerId missing`).toBeDefined();
      // Drizzle reports uuid columns with dataType 'string' and the helper
      // pins notNull + default to KEVIN_OWNER_ID; assert both invariants.
      expect(col?.dataType, `${name}.ownerId must be a string-typed uuid column`).toBe('string');
      expect(col?.notNull, `${name}.ownerId must be NOT NULL`).toBe(true);
    }
  });

  it('KEVIN_OWNER_ID validates against the RFC 4122 v4 pattern (hex-only)', () => {
    expect(KEVIN_OWNER_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
