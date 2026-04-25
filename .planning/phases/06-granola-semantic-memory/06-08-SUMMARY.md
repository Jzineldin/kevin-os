---
phase: 06-granola-semantic-memory
plan: 08
subsystem: memory-and-context
status: complete
mode: gap_closure
gap_source: .planning/phases/06-granola-semantic-memory/06-REVIEW.md
gap_target: REVIEW INFO findings hardening (IN-01, IN-02, IN-04, IN-05, IN-06; IN-03 explicitly skipped per REVIEW.md)
tags:
  - phase-6-gap
  - review-hardening
  - info-findings
requires:
  - 06-REVIEW.md INFO findings IN-01..IN-06
  - 06-REVIEW-FIX.md WR-04 (which already landed GEMINI_FULL_DOSSIER_TTL_SECONDS)
provides:
  - UUID validation guard at hybridQuery entry (IN-01)
  - PG-version-resilient interval arithmetic in writeDossierCache (IN-02, both call sites)
  - Local EBEvent interface in dossier-loader (IN-04, eliminates aws-lambda type import landmine)
  - Crockford ULID alphabet in trigger-full-dossier.mjs (IN-05, generated IDs now pass downstream regex)
  - GEMINI_FULL_DOSSIER_TTL_SECONDS verified present (IN-06, no-op verify)
affects:
  - packages/azure-search/src/query.ts
  - packages/azure-search/test/query.test.ts
  - packages/context-loader/src/cache.ts
  - services/dossier-loader/src/persist.ts
  - services/dossier-loader/src/handler.ts
  - scripts/trigger-full-dossier.mjs
tech-stack:
  added: []
  patterns:
    - module-level UUID_RE regex guard before string interpolation into search filters
    - make_interval(secs => $5::int) for explicit-cast interval arithmetic
    - local EBEvent interface mirroring peer Phase 6 Lambdas (transcript-extractor pattern)
    - Crockford base-32 ULID generator (matches scripts/verify-extractor-events.mjs verbatim)
key-files:
  created: []
  modified:
    - packages/azure-search/src/query.ts
    - packages/azure-search/test/query.test.ts
    - packages/context-loader/src/cache.ts
    - services/dossier-loader/src/persist.ts
    - services/dossier-loader/src/handler.ts
    - scripts/trigger-full-dossier.mjs
decisions:
  - IN-03 (rejectUnauthorized:false on RDS pools) explicitly skipped per REVIEW.md "No action required for Phase 6"
  - IN-06 verified-only — GEMINI_FULL_DOSSIER_TTL_SECONDS already hoisted via 06-REVIEW-FIX.md WR-04 fix; no edit needed
  - Pre-existing typecheck errors in @kos/azure-search and @kos/service-dossier-loader (unrelated rootDir + missing OTel package types) left out of scope per Plan-06-08 scope boundary
  - Pre-existing dossier-loader vertex.test.ts failure (asserts old "CORPUS START" string after WR-02 swapped to <corpus>) left out of scope — pre-dates this plan
metrics:
  duration_minutes: 5
  completed_date: 2026-04-25
  task_count: 4
  file_count: 6
  commits: 4
---

# Phase 6 Plan 08: REVIEW INFO Findings Hardening Summary

Closed 5 of 6 INFO-severity findings from `06-REVIEW.md` (IN-01, IN-02, IN-04, IN-05; IN-06 verified already-closed). IN-03 explicitly skipped per the review note "No action required for Phase 6". Defense-in-depth hardening — none of these block production, but they eliminate latent bugs around UUID injection, future Postgres operator-resolution tightening, an aws-lambda type import landmine, and a Crockford ULID alphabet regression that would have made operator-issued capture_ids fail downstream schema validation.

## Tasks completed

| Task | Finding | Commit | Files |
| ---- | ------- | ------ | ----- |
| 1 | IN-01 UUID validation guard in hybridQuery | `c6760d4` | packages/azure-search/src/query.ts, packages/azure-search/test/query.test.ts |
| 2 | IN-02 make_interval(secs => $5::int) in both writeDossierCache call sites | `0e72961` | packages/context-loader/src/cache.ts, services/dossier-loader/src/persist.ts |
| 3 | IN-04 drop aws-lambda type import + IN-06 verify GEMINI_FULL_DOSSIER_TTL_SECONDS | `32224c6` | services/dossier-loader/src/handler.ts |
| 4 | IN-05 Crockford ULID alphabet in trigger-full-dossier.mjs | `9b42cbf` | scripts/trigger-full-dossier.mjs |

## Findings closed

### IN-01 — UUID validation in hybridQuery
- **Issue:** `entity_ids/any(id: search.in(id, '${entityIds.join(',')}'))` interpolates entity IDs directly into the OData filter without escaping. Today every caller passes DB UUIDs, but a future regression vector existed.
- **Fix:** Added module-level `UUID_RE = /^[0-9a-f-]{36}$/i`; loop over `entityIds` at function entry and throw with offending value before constructing the filter.
- **Tests:** Added 4 new tests in a `IN-01: UUID validation guard (Plan 06-08)` describe block — non-UUID rejected, error contains the offending value, valid UUIDs pass, empty array passes.
- **Acceptance:** all 14 query.test.ts tests pass (10 original + 4 new), full @kos/azure-search suite (19 tests) green.

### IN-02 — make_interval for dossier cache TTL
- **Issue:** `now() + ($5 || ' seconds')::interval` relies on implicit int→text coercion via the `anyelement || text` operator path. PG-version-fragile.
- **Fix:** Replaced with `now() + make_interval(secs => $5::int)` in BOTH `packages/context-loader/src/cache.ts` and `services/dossier-loader/src/persist.ts`. Same JS argument binding (`ttlSeconds` as JS number); explicit `$5::int` cast; `make_interval` returns interval; addition with `now()` returns timestamptz. Type-clean.
- **Acceptance:** @kos/context-loader (30 tests) and @kos/db (48 tests, including dossier-cache-trigger.test.ts) all pass.

### IN-04 — drop aws-lambda type import
- **Issue:** `import type { EventBridgeEvent } from 'aws-lambda'` in `services/dossier-loader/src/handler.ts` — peer Phase 6 Lambdas (transcript-extractor, granola-poller, entity-timeline-refresher) all avoid this import to keep the package free of `@types/aws-lambda` hoisting dependencies.
- **Fix:** Deleted the import; added a local `interface EBEvent { source?: string; 'detail-type'?: string; detail: unknown; time?: string }` mirroring the transcript-extractor pattern at lines 104-109. Updated handler signature from `EventBridgeEvent<'context.full_dossier_requested', unknown>` to `EBEvent`. Body code (`event.detail` flowing through `FullDossierRequestedSchema.parse(...)`) unchanged — `EBEvent.detail: unknown` is shape-compatible.
- **Acceptance:** handler.test.ts (4 tests) all pass.

### IN-05 — Crockford ULID alphabet in trigger-full-dossier.mjs
- **Issue:** Old impl used `Date.now().toString(32).toUpperCase()` which produces `0-9A-V` — INVALID per Crockford spec (which excludes `I/L/O/U` but REQUIRES `W/X/Y/Z`). Downstream `EntityMentionDetectedSchema` regex `/^[0-9A-HJKMNP-TV-Z]{26}$/` would reject IDs from the old implementation, making the operator-issued dossier-loader trigger flaky.
- **Fix:** Replaced the inline `ulid()` function verbatim with the implementation from `scripts/verify-extractor-events.mjs:36-58`: 32-char Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 10-char timestamp + 16-char `randomBytes(10)` randomness sampled 5 bits at a time. Added `randomBytes` to the imports alongside the existing `randomUUID`.
- **Acceptance:** `node --check scripts/trigger-full-dossier.mjs` exits 0; inline node test confirmed 5 generated IDs all match `/^[0-9A-HJKMNP-TV-Z]{26}$/`.

### IN-06 — GEMINI_FULL_DOSSIER_TTL_SECONDS hoisted constant (verify-only)
- **Status:** Already addressed by 06-REVIEW-FIX.md WR-04 — `GEMINI_FULL_DOSSIER_TTL_SECONDS = 24 * 3600` declared at handler.ts line 42 with the D-21 fallback ceiling doc comment, referenced at the writeDossierCache call site (line 118 / now 118 post-edit). No edit needed for this plan.
- **Verified by:** `grep -c "GEMINI_FULL_DOSSIER_TTL_SECONDS" services/dossier-loader/src/handler.ts` returns 2 (declaration + usage).

### IN-03 — explicitly skipped
- **Status:** REVIEW.md reads "No action required for Phase 6". Not addressed by this plan. The decision belongs to a future RDS-hardening plan that ships the AWS RDS root CA bundle.

## Test exit codes

| Package | Tests | Status |
| ------- | ----- | ------ |
| @kos/azure-search | 19 | PASS |
| @kos/context-loader | 30 | PASS |
| @kos/db | 48 | PASS |
| @kos/service-dossier-loader (handler.test.ts only) | 4 | PASS |

## Gate verifier

`node scripts/verify-phase-6-gate.mjs --mock` exits 0 — no regressions. 7 PASS-auto, 5 HUMAN-pending (unchanged from pre-plan baseline).

## Static asserts (final)

| Check | Expected | Actual |
| ----- | -------- | ------ |
| `grep -c "UUID_RE" packages/azure-search/src/query.ts` | ≥ 2 | 2 |
| `grep -c "make_interval" packages/context-loader/src/cache.ts` | ≥ 1 | 3 |
| `grep -c "make_interval" services/dossier-loader/src/persist.ts` | ≥ 1 | 3 |
| `grep -c "from 'aws-lambda'" services/dossier-loader/src/handler.ts` | 0 | 0 |
| `grep -c "GEMINI_FULL_DOSSIER_TTL_SECONDS" services/dossier-loader/src/handler.ts` | ≥ 2 | 2 |
| `grep -c "ULID_ALPHABET" scripts/trigger-full-dossier.mjs` | ≥ 1 | 3 |
| `grep -c "Date.now().toString(32)" scripts/trigger-full-dossier.mjs` | 0 | 0 |
| `node --check scripts/trigger-full-dossier.mjs` | exit 0 | OK |

## Deviations from plan

None — plan executed exactly as written. No Rule 1/2/3 auto-fixes triggered; no Rule 4 architectural decisions surfaced.

## Deferred Issues (out of scope, pre-existing)

These pre-existed before Plan 06-08 began and are out of scope per the executor scope boundary:

1. **@kos/azure-search typecheck error** — `tsconfig.json` has `rootDir: src` but `include: test/**/*.ts`. Tests exist outside rootDir, so `pnpm typecheck` fails with TS6059. Tests themselves run fine via vitest. Confirmed pre-existing via `git stash` test before any 06-08 edit. Belongs to a future tsconfig hygiene plan.
2. **@kos/service-dossier-loader typecheck errors** — `_shared/tracing.ts` imports `@opentelemetry/sdk-trace-node`, `@langfuse/otel`, `@arizeai/openinference-instrumentation-claude-agent-sdk`, `@opentelemetry/instrumentation`, `@opentelemetry/api` which are not in the package's typed-dependency tree (TS2307 × 5). Pre-existing. Tests run fine via vitest. Belongs to a future shared-deps hygiene plan.
3. **services/dossier-loader/test/vertex.test.ts failure** — assertion `text).toContain('CORPUS START')` fails because WR-02 fix swapped `--- CORPUS START ---` for `<corpus>` in `vertex.ts` but did not update this test. Confirmed pre-existing via `git stash` test before any 06-08 edit. Two-line fix in a future plan, but not surfaced by my changes.

These are tracked here per executor scope-boundary discipline; none of them were introduced by Plan 06-08.

## Self-Check: PASSED

**Files verified:**
- `packages/azure-search/src/query.ts` — FOUND
- `packages/azure-search/test/query.test.ts` — FOUND (with new IN-01 describe block)
- `packages/context-loader/src/cache.ts` — FOUND (uses make_interval)
- `services/dossier-loader/src/persist.ts` — FOUND (uses make_interval)
- `services/dossier-loader/src/handler.ts` — FOUND (no aws-lambda import; EBEvent declared; GEMINI_FULL_DOSSIER_TTL_SECONDS present)
- `scripts/trigger-full-dossier.mjs` — FOUND (uses Crockford alphabet)

**Commits verified in `git log`:**
- `c6760d4` — fix(06-08): add UUID validation guard in hybridQuery (IN-01) — FOUND
- `0e72961` — fix(06-08): use make_interval for dossier cache TTL (IN-02) — FOUND
- `32224c6` — fix(06-08): drop aws-lambda type import in dossier-loader (IN-04) — FOUND
- `9b42cbf` — fix(06-08): use Crockford ULID alphabet in trigger-full-dossier.mjs (IN-05) — FOUND
