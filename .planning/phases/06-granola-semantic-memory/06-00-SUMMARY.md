---
phase: 06-granola-semantic-memory
plan: 00
subsystem: scaffold
tags: [scaffold, phase-6, granola, context-loader, azure-search, dossier-cache, drizzle]

# Dependency graph
requires:
  - phase: 02-minimum-viable-loop
    provides: "@kos/contracts (events.ts barrel + capture/agent buses), services/_shared/{sentry,tracing}.ts wrappers, @kos/resolver embedBatch (Cohere v4)"
  - phase: 01-infrastructure-foundation
    provides: "@kos/db Drizzle schema + migration chain (0001-0011), packages/cdk KosLambda construct, EventBridge buses (kos.capture, kos.agent), Azure Search kos-memory-v1 index (1024-dim)"
provides:
  - "10 Phase 6 workspaces registered (8 services + 2 library packages)"
  - "@kos/contracts/context.ts with 5 Phase 6 Zod schemas (TranscriptAvailable, FullDossierRequested, EntityDossier, SearchHit, ContextBundle, KevinContextBlock, TranscriptExtraction)"
  - "Migration 0012: entity_dossiers_cached + entity_timeline MV + cache invalidation trigger + refresh_entity_timeline() SECURITY DEFINER + azure_indexer_cursor"
  - "Drizzle definitions: entityDossiersCached (composite PK) + azureIndexerCursor"
  - "3 deterministic test fixtures (granola/azure-search/vertex) re-exported from @kos/test-fixtures barrel"
  - "owner_id forward-compat invariant restored on azure_indexer_cursor (Locked Decision #13)"
affects: [phase-06 plans 01-06, phase-04 email-triage, phase-07 lifecycle, phase-08 outbound-content]

# Tech tracking
tech-stack:
  added:
    - "drizzle-orm primaryKey({ columns: [...] }) helper for composite PK"
  patterns:
    - "test fixtures match existing context.ts Zod schemas (single source of truth)"
    - "Drizzle MVs intentionally omitted — raw pool.query SQL for MV reads"
    - "idempotent ALTER TABLE column-add guards inside migrations for re-run safety"

key-files:
  created:
    - "packages/test-fixtures/src/granola.ts (fakeGranolaTranscript + GRANOLA_TRANSCRIPT_BODY)"
    - "packages/test-fixtures/src/azure-search.ts (fakeSearchHit + fakeSearchHits)"
    - "packages/test-fixtures/src/vertex.ts (fakeVertexCachedContent + fakeVertexResponse)"
  modified:
    - "packages/test-fixtures/src/index.ts (added 3 barrel re-exports)"
    - "packages/db/src/schema.ts (entityDossiersCached + azureIndexerCursor pgTable definitions)"
    - "packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql (added owner_id to azure_indexer_cursor + idempotent ADD COLUMN guard)"
    - ".planning/phases/06-granola-semantic-memory/deferred-items.md (logged 4 out-of-scope discoveries for next wave)"

key-decisions:
  - "Honored existing migration 0012 schema — did NOT rename to plan's idealized table names (entity_timeline_mv, transcripts_indexed, entity_dossiers_cached_invalidate_trg) because Phase 6 services already shipped against actual migration names"
  - "Test fixtures match existing TranscriptAvailable/SearchHit schema shapes (fields like notion_page_id, last_edited_time, reranker_score) instead of plan's idealized shapes"
  - "Materialized view entity_timeline NOT modeled in Drizzle (no first-class MV support); MV reads use raw pool.query SQL"
  - "Composite PK (entity_id, owner_id) on entity_dossiers_cached using primaryKey({ columns: [...] }) helper — matches migration line 29 literal"
  - "Auto-fix Rule 2 applied: added owner_id to azure_indexer_cursor (table was missing the Locked Decision #13 owner_id invariant)"

patterns-established:
  - "Migration schema deviation handling: when plan-spec drift conflicts with shipped code, honor the shipped code and document reasoning in summary"
  - "owner_id sweep test enforcement: schema test breakage on missing owner_id is the canonical signal for forward-compat violation"

requirements-completed:
  - CAP-08
  - AGT-04
  - AGT-06
  - MEM-03
  - MEM-04
  - AUTO-05
  - INF-10

# Metrics
duration: 11min
completed: 2026-04-24
started: 2026-04-24T21:24:14Z
---

# Phase 6 Plan 0: Wave 0 Scaffold Summary

**Test fixtures + Drizzle defs gap-fill on top of pre-existing Phase 6 scaffold; owner_id forward-compat invariant restored on azure_indexer_cursor.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-04-24T21:24:14Z
- **Completed:** 2026-04-24T21:35:00Z
- **Tasks:** 3 (Task 1 already complete from prior commits; Tasks 2 + 3 executed)
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- Closed the only remaining gap in Wave 0 scaffolding: 3 deterministic test fixtures (granola, azure-search, vertex) for downstream Phase 6 plans 01-05.
- Added missing Drizzle definitions for `entity_dossiers_cached` (composite PK) and `azure_indexer_cursor` so the schema is introspectable by drizzle-kit + downstream tooling.
- Auto-fixed a Locked-Decision #13 violation: `azure_indexer_cursor` was missing `owner_id` entirely (both in migration 0012 and any Drizzle def). Added the column + idempotent `ALTER TABLE ADD COLUMN` guard for already-applied environments.
- All three target workspaces (`@kos/contracts`, `@kos/test-fixtures`, `@kos/db`) pass tests; runtime Zod parse-check confirms fixtures are spec-compliant.

## Task Commits

Each task was committed atomically with `--no-verify` (worktree mode):

1. **Task 1: Workspace scaffolding (10 directories)** — _no commit needed_; all directories already exist on the parent branch (commits `1b8bf24`, `eee4efa`, `5945587` from prior overnight session). Verified all `package.json` + `tsconfig.json` + `vitest.config.ts` + stub `src/handler.ts` files in place; pnpm install resolves; per-workspace test passes.
2. **Task 2: Phase 6 contracts + test fixtures** — `9f1d5fa` (feat): contracts/context.ts already complete from `1b8bf24`; this commit adds the 3 missing test-fixture modules + barrel re-exports.
3. **Task 3: Migration 0012 + schema.ts updates** — `85962a5` (feat): adds Drizzle definitions for `entityDossiersCached` + `azureIndexerCursor` matching the existing migration shape; adds `owner_id` column to `azure_indexer_cursor` for Locked Decision #13 compliance.

## Files Created/Modified

### Created (3)

- `packages/test-fixtures/src/granola.ts` — `fakeGranolaTranscript({ overrides? })` returning a `TranscriptAvailable` event detail with a 5-paragraph synthetic Swedish-English meeting transcript body (~1300 chars after tightening) mentioning Damien, Almi Invest, konvertibellån, Tale Forge per 06-CONTEXT active threads. `GRANOLA_TRANSCRIPT_BODY` exported for downstream extractor tests.
- `packages/test-fixtures/src/azure-search.ts` — `fakeSearchHit({ overrides? })` + `fakeSearchHits(n)` returning deterministic `SearchHit` objects with descending score order and rotating source enum for ranking-assertion tests.
- `packages/test-fixtures/src/vertex.ts` — `fakeVertexCachedContent({ overrides? })` + `fakeVertexResponse({ overrides? })` matching `@google-cloud/vertexai` v1.x shapes (`cachedContents/<id>` resource name; `generateContent` candidates[].content.parts[]).

### Modified (3)

- `packages/test-fixtures/src/index.ts` — added 3 barrel re-exports (`./granola.js`, `./azure-search.js`, `./vertex.js`); existing bedrock/notion/telegram exports untouched.
- `packages/db/src/schema.ts` — appended `entityDossiersCached` (composite PK via `primaryKey({ columns: [t.entityId, t.ownerId] })`) and `azureIndexerCursor` (with `ownerId()` helper) Drizzle definitions; imported `primaryKey` from `drizzle-orm/pg-core`.
- `packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql` — added `owner_id uuid NOT NULL DEFAULT` to `azure_indexer_cursor` table definition + idempotent `DO $$ … ALTER TABLE … ADD COLUMN … $$` guard for environments where 0012 was applied without owner_id.

### Pre-existing (verified intact)

All 10 workspace directories from Plan 06-00 Task 1 verified present at the resetbase commit `52d29e8`:

- `services/granola-poller/` (handler.ts, db.ts, package.json, tsconfig.json, vitest.config.ts)
- `services/transcript-extractor/` (handler.ts, notion.ts, persist.ts)
- `services/azure-search-indexer-{entities,projects,transcripts,daily-brief}/` (handler.ts + common.ts)
- `services/entity-timeline-refresher/` (handler.ts)
- `services/dossier-loader/` (handler.ts, aggregate.ts, persist.ts, vertex.ts)
- `packages/context-loader/` (index.ts barrel + cache.ts, kevin.ts, loadContext.ts, markdown.ts)
- `packages/azure-search/` (index.ts barrel + client.ts, embed.ts, query.ts, upsert.ts)

## Verification

- `pnpm --filter @kos/db test` → 10 passed (10/10) including `owner-sweep.test.ts` forward-compat sweep + `schema.test.ts` owner_id presence enforcement.
- `pnpm --filter @kos/db typecheck` → clean (no diagnostics).
- `pnpm --filter @kos/test-fixtures test` → passWithNoTests OK.
- `pnpm --filter @kos/test-fixtures typecheck` → clean.
- `pnpm --filter @kos/contracts test` → passWithNoTests OK.
- Runtime parse-check via tsx: all 3 fixture modules produce values that parse against their corresponding Zod schemas (TranscriptAvailable, SearchHit). 6 OK assertions including overrides + bulk fixture array length + `cachedContents/[a-z0-9]+` regex shape.
- Migration 0012 sanity check: 8/8 expected sections present (`entity_dossiers_cached`, `idx_*_expires`, `invalidate_dossier_cache_on_mention`, `trg_entity_dossiers_cached_invalidate`, `entity_timeline` MV, `uniq_entity_timeline_event`, `refresh_entity_timeline`, `azure_indexer_cursor`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Critical Functionality] owner_id missing on azure_indexer_cursor**
- **Found during:** Task 3 verify step (`pnpm --filter @kos/db test`).
- **Issue:** `packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql` defined `azure_indexer_cursor` without an `owner_id` column. The repo's `owner-sweep.test.ts` enforces "owner_id on every Drizzle table" per Locked Decision #13 (single-user → multi-user forward-compat). After adding the Drizzle definition, the test failed with `azureIndexerCursor: missing owner_id`.
- **Fix:** Added `owner_id uuid NOT NULL DEFAULT '<KEVIN_OWNER_ID>'::uuid` to the migration's CREATE TABLE statement + an idempotent `ALTER TABLE ADD COLUMN` guard for environments where 0012 was already applied. Mirrored the column on the Drizzle table via `ownerId()` helper.
- **Files modified:** `packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql`, `packages/db/src/schema.ts`.
- **Commit:** `85962a5`.

### Plan-vs-actual schema deviations (deliberate, NOT auto-fixed)

The original Plan 06-00 spec describes idealized table/MV/trigger names that diverge from the actual migration shipped during the prior overnight session. Plan 06-00 was authored before any execution; subsequent plans (06-01, 06-02, 06-03, 06-04, 06-05) shipped against the actual names. To avoid breaking working downstream services, I honored the shipped names and documented the deltas:

| Plan-spec name (Plan 06-00) | Actual shipped name (in tree) | Why honor actual |
|------------------------------|-------------------------------|------------------|
| `entity_timeline_mv` | `entity_timeline` | Used by `services/entity-timeline-refresher/src/handler.ts` + Phase 3 dashboard timeline route; rename would require coordinated multi-Lambda + dashboard route migration |
| `entity_timeline_mv_pk` | `uniq_entity_timeline_event` | Same — coupled with refresh CONCURRENTLY semantics |
| `transcripts_indexed` (per-transcript audit table) | (no separate table; uses `agent_runs WHERE agent_name='transcript-extractor'`) | `azure-search-indexer-transcripts` reads agent_runs context, not a dedicated index table; transcripts_indexed would be unused and add maintenance burden |
| `entity_dossiers_cached_invalidate_trg` | `trg_entity_dossiers_cached_invalidate` | Naming convention difference only; trigger is functionally identical |
| `notion_indexer_cursor` seed for `db_kind='transkripten'` | (none seeded; granola-poller uses different cursor schema entirely — `db_name` + `last_edited_time`) | Pre-existing schema mismatch in granola-poller (uses `db_name` instead of `db_kind`; uses `last_edited_time` instead of `last_cursor_at`); seeding in 0012 wouldn't help. Logged to deferred-items.md as a Phase 6 wave-1 concern. |

**Test fixture shape deviation:** Plan 06-00 Task 2 specified `fakeGranolaTranscript()` returning fields like `recorded_at`, `attendees`, `notion_url`. The actual `TranscriptAvailableSchema` in `packages/contracts/src/context.ts` uses `last_edited_time`, `notion_page_id`, `transcript_id`, `raw_length`, `source: 'granola'`. Fixtures were built to match the **shipped** schema so they Zod-parse without errors.

## Out-of-scope discoveries (logged to deferred-items.md)

Pre-existing issues observed but NOT fixed (out of scope per execute-plan.md scope boundary):

- `services/_shared/tracing.ts` imports 5 OpenTelemetry/Langfuse modules not declared as deps in azure-search-indexer-* / dossier-loader / entity-timeline-refresher service `package.json` files; typecheck fails with TS2307 in those workspaces. Tests still pass (vitest doesn't follow the import); typechecking is the failure mode.
- `packages/azure-search/src/client.ts` lines 26 + 32: TS2344 type errors. Pre-existing.
- `services/azure-search-indexer-entities/src/handler.ts:51`: cursor type mismatch (Date vs string). Pre-existing.
- `apps/dashboard/tests/unit/dashboard-api.test.ts` 4 test failures: `KOS_DASHBOARD_BEARER_TOKEN not set on runtime`. Pre-existing baseline failure unrelated to Phase 6.

## Operator runbook items (carried forward)

No new operator items added by Plan 06-00. Phase 6's existing deferred-items.md operator runbook (GCP project + Vertex SA + Notion Transkripten DB discovery) remains the authoritative pre-deploy checklist for plans 06-01 through 06-05.

## Threat Flags

None — Plan 06-00 is pure scaffolding (workspace structure + type definitions + test fixtures + DB schema). No new attack surface introduced. The existing `<threat_model>` register from Plan 06-00 frontmatter (T-06-SCAFFOLD-01 / T-06-CONTRACT-01 / T-06-MIGRATION-01 / T-06-MIGRATION-02 / T-06-FIXTURES-01) all retain their planned dispositions.

## Self-Check: PASSED

**Files claimed created (3):**
- `packages/test-fixtures/src/granola.ts` — FOUND
- `packages/test-fixtures/src/azure-search.ts` — FOUND
- `packages/test-fixtures/src/vertex.ts` — FOUND

**Files claimed modified (3):**
- `packages/test-fixtures/src/index.ts` — FOUND (3 new barrel exports verified)
- `packages/db/src/schema.ts` — FOUND (entityDossiersCached + azureIndexerCursor + primaryKey import verified)
- `packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql` — FOUND (owner_id column + idempotent ADD COLUMN guard verified)

**Commits claimed:**
- `9f1d5fa` (feat 06-00 fixtures) — FOUND in `git log`
- `85962a5` (feat 06-00 Drizzle defs) — FOUND in `git log`

All claims verified. SUMMARY ready for orchestrator merge.
