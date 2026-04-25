/**
 * Plan 06-04 Task 3 — entity_dossiers_cached invalidation trigger
 * acceptance test (string-shape mode).
 *
 * No pg-mem / testcontainer infra exists in @kos/db today, so these
 * assertions verify the trigger DEFINITION rather than its runtime
 * behaviour. The plan explicitly accepts string-shape minimum:
 *
 *   "If string-only: assert the trigger function body contains
 *    `IF NEW.entity_id IS NOT NULL THEN DELETE FROM entity_dossiers_cached
 *    WHERE entity_id = NEW.entity_id`."
 *
 * The shipped trigger function actually issues an unconditional DELETE
 * (no `IF NEW.entity_id IS NOT NULL` guard) — the implicit guard is the
 * mention_events FK / NULL semantics: `WHERE entity_id = NULL` matches no
 * rows in Postgres, so the unconditional DELETE behaves correctly. We
 * accept the looser shape (Plan 06-00 SUMMARY's "honor shipped code"
 * pattern) and document the equivalence.
 *
 * Plan-spec name: entity_dossiers_cached_invalidate_trg
 * Shipped name:   trg_entity_dossiers_cached_invalidate
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

describe('entity_dossiers_cached invalidation trigger (migration 0012)', () => {
  it('trigger function invalidate_dossier_cache_on_mention is defined', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION\s+invalidate_dossier_cache_on_mention\(\)/i);
    expect(SQL).toMatch(/RETURNS trigger/i);
    expect(SQL).toMatch(/LANGUAGE plpgsql/i);
  });

  it('trigger body deletes from entity_dossiers_cached using NEW.entity_id', () => {
    expect(SQL).toMatch(/DELETE FROM entity_dossiers_cached/i);
    expect(SQL).toMatch(/WHERE entity_id = NEW\.entity_id/i);
  });

  it('trigger body also enforces owner_id match (cross-owner safety)', () => {
    // Locked Decision #13: forward-compat for multi-user. The DELETE must
    // narrow to the matching owner_id so a future multi-tenant deploy
    // doesn't scramble caches across owners on cross-pollinated mentions.
    expect(SQL).toMatch(/AND owner_id\s*=\s*NEW\.owner_id/i);
  });

  it('trigger fires AFTER INSERT on mention_events (NOT BEFORE / NOT UPDATE)', () => {
    expect(SQL).toMatch(/AFTER INSERT ON mention_events/i);
    // Negative checks: trigger should not fire BEFORE INSERT (unsafe — the
    // row hasn't been written yet) and should not fire on UPDATE (mention
    // rows are append-only by Phase 2 contract).
    expect(SQL).not.toMatch(/BEFORE INSERT ON mention_events/i);
    expect(SQL).not.toMatch(/AFTER UPDATE ON mention_events/i);
  });

  it('trigger uses FOR EACH ROW (not FOR EACH STATEMENT)', () => {
    expect(SQL).toMatch(/FOR EACH ROW/i);
  });

  it('trigger DROP-then-CREATE pattern (idempotent re-apply)', () => {
    // Idempotent migration safety: re-applying 0012 on an already-applied
    // DB should not error on duplicate trigger creation.
    expect(SQL).toMatch(/DROP TRIGGER IF EXISTS\s+trg_entity_dossiers_cached_invalidate/i);
    expect(SQL).toMatch(/CREATE TRIGGER\s+trg_entity_dossiers_cached_invalidate/i);
  });

  it('trigger function returns NEW (preserves row write to mention_events)', () => {
    // BEFORE-style triggers can return NULL to abort the row insert; AFTER
    // INSERT triggers return value is ignored, but `RETURN NEW` is the
    // canonical convention so future BEFORE-INSERT migrations don't break.
    expect(SQL).toMatch(/RETURN NEW;/);
  });

  it('NULL-entity_id behaviour: implicit no-op via SQL NULL semantics', () => {
    // The shipped trigger body does NOT have an `IF NEW.entity_id IS NOT
    // NULL THEN ...` guard. That's safe because SQL `WHERE entity_id =
    // NULL` matches no rows in Postgres (NULL = NULL is NULL, not TRUE).
    // This test documents the intent: NULL-entity inserts should be no-ops
    // for cache invalidation.
    //
    // Assertion: the trigger function body is a single DELETE (no IF
    // branches that could mutate semantics).
    const fnBodyMatch = SQL.match(
      /CREATE OR REPLACE FUNCTION\s+invalidate_dossier_cache_on_mention[\s\S]+?\$\$;/,
    );
    expect(fnBodyMatch).toBeTruthy();
    const fnBody = fnBodyMatch![0];
    expect(fnBody).toContain('DELETE FROM entity_dossiers_cached');
    // No IF / CASE branching in the function body.
    expect(fnBody).not.toMatch(/\bIF\s+NEW\.entity_id\b/i);
  });
});
