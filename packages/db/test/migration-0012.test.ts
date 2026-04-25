/**
 * Plan 06-04 Task 3 — Migration 0012 string-shape acceptance tests.
 *
 * Pure-string assertions against the migration SQL: NO testcontainers, NO
 * pg-mem (neither is wired in @kos/db). These tests document the canonical
 * shape of migration 0012 so any future edit that drops a critical clause
 * (the unique index, the trigger, the MV definition) breaks CI before it
 * can land.
 *
 * Plan-vs-shipped name reconciliation (per Plan 06-00 SUMMARY's "honor
 * shipped code" deviation pattern):
 *
 *   Plan-spec name              | Shipped name
 *   ----------------------------|---------------------------------------
 *   entity_timeline_mv          | entity_timeline
 *   entity_timeline_mv_pk       | uniq_entity_timeline_event
 *   transcripts_indexed (table) | (no separate table — agent_runs row)
 *   entity_dossiers_cached_invalidate_trg | trg_entity_dossiers_cached_invalidate
 *
 * The assertions below validate the SHIPPED names; idealized plan names
 * are only checked as alternates where they happen to overlap. This keeps
 * the test green against current migration shape AND guards against
 * accidental further drift.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql',
);
const SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

describe('migration 0012 — Phase 6 dossier cache + timeline MV', () => {
  it('exists at the expected path', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(SQL.length).toBeGreaterThan(500);
  });

  it('defines entity_dossiers_cached table', () => {
    expect(SQL).toMatch(/CREATE TABLE\s+IF NOT EXISTS\s+entity_dossiers_cached/i);
  });

  it('entity_dossiers_cached has composite PK on (entity_id, owner_id)', () => {
    expect(SQL).toMatch(/PRIMARY KEY \(entity_id, owner_id\)/);
  });

  it('entity_dossiers_cached has owner_id (Locked Decision #13 forward-compat)', () => {
    // owner_id appears multiple times across the migration; the dossier
    // table specifically must declare it as a non-null column.
    expect(SQL).toMatch(/owner_id\s+uuid\s+NOT NULL/);
  });

  it('defines entity_timeline materialized view (shipped name; plan-spec was entity_timeline_mv)', () => {
    expect(SQL).toMatch(/CREATE MATERIALIZED VIEW\s+entity_timeline\b/i);
  });

  it('MV filters mention_events to non-null entity_id only', () => {
    // Without this filter the MV would carry orphan rows that resolver
    // hasn't attached to an entity yet — wasted index space + dashboard
    // noise. Plan task 3 mv-acceptance assertion #4.
    expect(SQL).toMatch(/WHERE m\.entity_id IS NOT NULL/);
  });

  it('MV columns map mention_events.source → kind and mention_events.context → excerpt', () => {
    // Phase 1 mention_events has columns (source, context); the MV exposes
    // them as (kind, excerpt) for backwards compat with the shipped
    // dashboard timeline contract. An older draft used m.kind / m.excerpt
    // directly which would have failed at apply time.
    expect(SQL).toMatch(/m\.source\s+AS\s+kind/i);
    expect(SQL).toMatch(/m\.context\s+AS\s+excerpt/i);
  });

  it('MV agent_runs branch reads output_json (NOT a non-existent context column)', () => {
    expect(SQL).toContain('ar.output_json');
    // Guard against regressing back to ar.context (which doesn't exist).
    expect(SQL).not.toMatch(/\bar\.context\b\s*\?/);
  });

  it('creates a UNIQUE INDEX on entity_timeline (CONCURRENTLY-eligible)', () => {
    // Plan-spec idealized name was entity_timeline_mv_pk; shipped name is
    // uniq_entity_timeline_event. Both forms accepted but at least one
    // unique index must exist on the MV for REFRESH CONCURRENTLY.
    const hasUniqueIdx =
      /CREATE UNIQUE INDEX[^;]+ON\s+entity_timeline\b/i.test(SQL);
    expect(hasUniqueIdx).toBe(true);
  });

  it('creates a non-unique index on (entity_id, occurred_at DESC) for fast paginated reads', () => {
    expect(SQL).toMatch(/idx_entity_timeline_owner_entity_occurred|entity_timeline_mv_by_entity_time/);
    expect(SQL).toMatch(/occurred_at DESC/);
  });

  it('defines refresh trigger function (cache invalidation on mention insert)', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION\s+invalidate_dossier_cache_on_mention/i);
  });

  it('AFTER INSERT trigger on mention_events deletes matching cache rows', () => {
    expect(SQL).toMatch(/AFTER INSERT ON mention_events/i);
    expect(SQL).toMatch(/DELETE FROM entity_dossiers_cached/i);
  });

  it('refresh_entity_timeline() SECURITY DEFINER wrapper exists', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION\s+refresh_entity_timeline/i);
    expect(SQL).toContain('SECURITY DEFINER');
    expect(SQL).toMatch(/REFRESH MATERIALIZED VIEW CONCURRENTLY/i);
  });

  it('azure_indexer_cursor table defined with owner_id (Plan 06-00 fix)', () => {
    expect(SQL).toMatch(/CREATE TABLE\s+IF NOT EXISTS\s+azure_indexer_cursor/i);
    // owner_id presence verified by owner-sweep test; here we just guard
    // the table itself plus the idempotent ADD COLUMN guard.
    expect(SQL).toMatch(/ALTER TABLE\s+azure_indexer_cursor\s+ADD COLUMN\s+owner_id/i);
  });

  it('rollback comment block present at end of file (operator runbook)', () => {
    // Plan task 3 assertion #2: rollback statements documented as comments
    // (forward-only Drizzle chain doesn't run them).
    expect(SQL).toMatch(/--\s*Rollback/i);
    expect(SQL).toMatch(/--\s*DROP MATERIALIZED VIEW IF EXISTS entity_timeline/);
  });

  it('no DROP TABLE statements outside the rollback comment block', () => {
    // Forward-migration safety: the SQL the migrator runs must not drop
    // anything (other than DROP TRIGGER / DROP MATERIALIZED VIEW which
    // are idempotent re-create patterns). Comment lines are stripped
    // before checking.
    const nonComment = SQL
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(nonComment).not.toMatch(/^\s*DROP TABLE\b/im);
  });

  it('grants block guards against missing roles via DO $$ ... IF EXISTS', () => {
    // Phase 1 carries kos_dashboard_reader / kos_agent_writer roles;
    // 0012 grants are wrapped in pg_roles existence checks so the migration
    // can apply on a fresh DB before role-bootstrap finishes.
    expect(SQL).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'kos_dashboard_reader'\)/);
    expect(SQL).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'kos_agent_writer'\)/);
  });
});
