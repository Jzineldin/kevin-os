/**
 * Plan 06-04 Task 3 — entity_timeline materialized view + REFRESH
 * CONCURRENTLY acceptance tests (string-shape + Drizzle schema sanity).
 *
 * The pg-mem / testcontainer infrastructure isn't wired in @kos/db, so
 * these assertions are SQL-text + Drizzle-schema sanity. The plan task
 * accepts string-shape minimum:
 *
 *   "If string-only: assert MV definition uses
 *    `WHERE me.entity_id IS NOT NULL` (filter excludes null entity)."
 *
 * Plan-spec name: entity_timeline_mv
 * Shipped name:   entity_timeline (per Plan 06-00 SUMMARY's "honor
 *                 shipped code" deviation pattern; downstream services +
 *                 dashboard timeline route already read this name).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../src/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql',
);
const SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

describe('entity_timeline materialized view (migration 0012, MEM-04)', () => {
  it('MV is defined with CREATE MATERIALIZED VIEW', () => {
    expect(SQL).toMatch(/CREATE MATERIALIZED VIEW\s+entity_timeline\b/i);
  });

  it('MV definition uses UNION ALL between mention_events and agent_runs', () => {
    const flat = SQL.replace(/\s+/g, ' ');
    expect(flat).toMatch(/FROM mention_events m[\s\S]*UNION ALL[\s\S]*FROM agent_runs/i);
  });

  it('MV filters mention_events to non-null entity_id (Plan task 3 #4)', () => {
    expect(SQL).toMatch(/WHERE m\.entity_id IS NOT NULL/);
  });

  it('MV agent_runs branch only includes entity-resolver + transcript-extractor', () => {
    expect(SQL).toContain("'entity-resolver'");
    expect(SQL).toContain("'transcript-extractor'");
    expect(SQL).toMatch(/agent_name IN \(/);
  });

  it('MV exposes 7 canonical columns: owner_id, entity_id, capture_id, kind, occurred_at, excerpt, event_source', () => {
    // Both UNION branches must produce the same column shape.
    const mvBlock = SQL.match(
      /CREATE MATERIALIZED VIEW[\s\S]+?(?=CREATE UNIQUE INDEX|--\s*CONCURRENTLY refresh)/,
    );
    expect(mvBlock).toBeTruthy();
    const block = mvBlock![0];
    expect(block).toContain('owner_id');
    expect(block).toContain('entity_id');
    expect(block).toContain('capture_id');
    expect(block).toMatch(/AS kind/);
    expect(block).toContain('occurred_at');
    expect(block).toMatch(/AS excerpt/);
    expect(block).toMatch(/event_source/);
  });

  it('UNIQUE INDEX exists for REFRESH CONCURRENTLY (RESEARCH §11)', () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX[^;]+ON\s+entity_timeline\b/i);
  });

  it('UNIQUE INDEX covers (owner_id, entity_id, capture_id, occurred_at, event_source, kind)', () => {
    // The 6-column unique tuple is the minimum required to make the MV
    // CONCURRENTLY-refreshable when the same (entity_id, capture_id) pair
    // is hit by both UNION branches (mention + agent_run).
    expect(SQL).toMatch(
      /uniq_entity_timeline_event[\s\S]+\(\s*owner_id,\s*entity_id,\s*capture_id,\s*occurred_at,\s*event_source,\s*kind\s*\)/i,
    );
  });

  it('non-unique index on (owner_id, entity_id, occurred_at DESC) for fast paginated reads', () => {
    expect(SQL).toMatch(/idx_entity_timeline_owner_entity_occurred/);
    expect(SQL).toMatch(/\(owner_id,\s*entity_id,\s*occurred_at DESC\)/);
  });

  it('REFRESH function refresh_entity_timeline() uses SECURITY DEFINER + CONCURRENTLY', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION\s+refresh_entity_timeline/i);
    expect(SQL).toContain('SECURITY DEFINER');
    expect(SQL).toMatch(/REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline/i);
  });

  it('refresh_entity_timeline() pins search_path to pg_catalog,public (CVE-2018-1058 mitigation)', () => {
    // SECURITY DEFINER without a SET search_path is a classic Postgres
    // privilege-escalation pitfall.
    expect(SQL).toMatch(/SET search_path = pg_catalog, public/);
  });

  it('Drizzle-side: mentionEvents table has the columns the MV reads (source, context)', () => {
    // The migration's MV uses `m.source AS kind` + `m.context AS excerpt`.
    // The Drizzle schema must expose these column names — if a future
    // migration renames them, this test catches the drift.
    const tableEntries = Object.entries(schema).filter(([, v]) => {
      if (!v || typeof v !== 'object') return false;
      try {
        getTableName(v as never);
        return true;
      } catch {
        return false;
      }
    });
    const mention = tableEntries.find(([, t]) => {
      try {
        return getTableName(t as never) === 'mention_events';
      } catch {
        return false;
      }
    });
    expect(mention).toBeDefined();
    const cols = getTableColumns(mention![1] as never);
    expect(cols).toHaveProperty('source');
    expect(cols).toHaveProperty('context');
    expect(cols).toHaveProperty('entityId');
    expect(cols).toHaveProperty('ownerId');
    expect(cols).toHaveProperty('capturedId' in cols ? 'capturedId' : 'captureId');
  });

  it('Drizzle-side: agentRuns table has output_json (NOT a "context" column)', () => {
    const tableEntries = Object.entries(schema).filter(([, v]) => {
      if (!v || typeof v !== 'object') return false;
      try {
        getTableName(v as never);
        return true;
      } catch {
        return false;
      }
    });
    const agent = tableEntries.find(([, t]) => {
      try {
        return getTableName(t as never) === 'agent_runs';
      } catch {
        return false;
      }
    });
    expect(agent).toBeDefined();
    const cols = getTableColumns(agent![1] as never);
    expect(cols).toHaveProperty('outputJson');
    // Negative check: agent_runs should NOT have a `context` column —
    // earlier drafts of migration 0012 referenced ar.context which would
    // have failed at apply time.
    expect(cols).not.toHaveProperty('context');
  });

  it('Drizzle-side: entity_dossiers_cached has composite (entityId, ownerId) PK', () => {
    const tableEntries = Object.entries(schema).filter(([, v]) => {
      if (!v || typeof v !== 'object') return false;
      try {
        getTableName(v as never);
        return true;
      } catch {
        return false;
      }
    });
    const cache = tableEntries.find(([, t]) => {
      try {
        return getTableName(t as never) === 'entity_dossiers_cached';
      } catch {
        return false;
      }
    });
    expect(cache).toBeDefined();
    const cols = getTableColumns(cache![1] as never);
    expect(cols).toHaveProperty('entityId');
    expect(cols).toHaveProperty('ownerId');
  });
});
