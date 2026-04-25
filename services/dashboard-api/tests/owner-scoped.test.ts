import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { inboxIndex, entityIndex } from '@kos/db/schema';
import { OWNER_ID, ownerScoped } from '../src/owner-scoped.js';
import { KEVIN_OWNER_ID } from '@kos/db';

describe('owner-scoped', () => {
  it('exports the repo-canonical KEVIN_OWNER_ID', () => {
    expect(OWNER_ID).toBe(KEVIN_OWNER_ID);
    expect(OWNER_ID).toBe('7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c');
  });

  it('compiles to SQL containing owner_id predicate on inbox_index', () => {
    const dialect = new PgDialect();
    const sql = ownerScoped(inboxIndex, eq(inboxIndex.status, 'pending'));
    const compiled = dialect.sqlToQuery(sql);
    expect(compiled.sql).toMatch(/"owner_id"\s*=\s*\$\d+/);
    // Params include the canonical owner_id.
    expect(compiled.params).toContain(KEVIN_OWNER_ID);
  });

  it('compiles to SQL containing owner_id predicate on entity_index', () => {
    const dialect = new PgDialect();
    const sql = ownerScoped(entityIndex, eq(entityIndex.id, '00000000-0000-0000-0000-000000000000'));
    const compiled = dialect.sqlToQuery(sql);
    expect(compiled.sql).toMatch(/"owner_id"/);
    expect(compiled.params).toContain(KEVIN_OWNER_ID);
  });

  it('returns a standalone owner predicate when no extras given', () => {
    const dialect = new PgDialect();
    const sql = ownerScoped(inboxIndex);
    const compiled = dialect.sqlToQuery(sql);
    expect(compiled.sql).toMatch(/"owner_id"\s*=\s*\$1/);
    expect(compiled.params[0]).toBe(KEVIN_OWNER_ID);
  });
});
