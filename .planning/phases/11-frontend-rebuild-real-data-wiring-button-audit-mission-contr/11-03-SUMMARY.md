---
phase: 11
plan: 3
subsystem: dashboard-inbox-data-wiring
tags: [d-05, d-11, d-14, contract-extension, sql-helper, inbox-pill, terminal-guard, tdd]
wave: 2
status: complete
duration_seconds: 950
completed_at: 2026-04-26T19:49:49Z

dependency_graph:
  requires:
    - 11-00 (Wave 0 schema + scaffolds — confirmed inbox_index has 4 distinct kinds)
    - 11-02 (Wave 1 — Pill primitive + design tokens)
  provides:
    - InboxItemSchema additive extension (classification + email_status)
    - EmailClassificationSchema + EmailDraftStatusSchema (canonical)
    - 'dead_letter' added to InboxItemKindSchema (for /inbox-merged)
    - listInboxDrafts returns ALL classified rows (not just draft/edited)
    - mergedInboxHandler UNIONs email_drafts + agent_dead_letter + inbox_index
    - isTerminalInboxItem() helper exported from InboxClient
    - inbox-row-pill / inbox-approve-btn / inbox-skip-btn / inbox-edit-btn data-testids
  affects:
    - apps/dashboard/src/app/(app)/inbox/* (renderer + handlers)
    - All future plans that consume @kos/contracts/dashboard InboxItem

tech_stack:
  added: []
  patterns:
    - "zod-at-exit: mergedInboxHandler now InboxListSchema.parse() before JSON.stringify"
    - "Discriminated-union enum extension (kind: 'dead_letter' added additively)"
    - "Optional + nullable contract extension for legacy-client compatibility"
    - "Terminal-status guard: isTerminalInboxItem() at the keyboard handler entry + button render"

key_files:
  created:
    - packages/contracts/test/dashboard.test.ts
    - services/dashboard-api/tests/inbox-merged.test.ts
  modified:
    - packages/contracts/src/dashboard.ts (+38 lines — schemas, additive)
    - services/dashboard-api/src/email-drafts-persist.ts (drop status filter, raise limit, doc-comment)
    - services/dashboard-api/src/routes/inbox.ts (+rewrite — UNION inbox_index, zod-at-exit)
    - services/dashboard-api/tests/email-drafts.test.ts (+155 lines — 4 new tests)
    - apps/dashboard/src/app/(app)/inbox/InboxClient.tsx (terminal-status guard + helper export)
    - apps/dashboard/src/app/(app)/inbox/ItemRow.tsx (Pill render + dead_letter icon)
    - apps/dashboard/src/app/(app)/inbox/ItemDetail.tsx (Pill in header + Read-only label + data-testids)
    - apps/dashboard/tests/e2e/inbox.spec.ts (placeholders → real assertions)
    - apps/dashboard/tests/unit/inbox-client.test.tsx (+3 terminal-guard tests)

decisions:
  - "Added 'dead_letter' to InboxItemKindSchema (auto-deviation, Rule 2): the existing /inbox-merged route has emitted dead_letter items since Phase 4, but the contract enum never included it. Without the addition, mergedInboxHandler's new InboxListSchema.parse() at exit would fail on any non-empty dead-letter row. This closes a latent contract-vs-implementation gap surfaced by Plan 11-03."
  - "Made InboxItemSchema's classification + email_status optional AND nullable: both legacy clients (no field) and future API responses (explicit null for non-email kinds) parse cleanly. Old dashboard JS bundles in the wild keep working."
  - "Default listInboxDrafts limit raised 50 → 100: D-05 surfaces 4 classification × 7 status combinations. 50 was tight already; 100 keeps a single-page render manageable without paging."
  - "Rewrote mergedInboxHandler response shape to conform to InboxListSchema: previously the route returned items with `from`/`subject`/`body_preview` fields that would have failed the dashboard's zod parse if the route ever returned non-empty data. The bug was hidden by the prod inbox being empty in production."
  - "isTerminalInboxItem() exported from InboxClient.tsx (rather than a separate util file): keeps the terminal-status definition co-located with its primary consumer (the keyboard handlers). ItemDetail re-imports it. Single source of truth, no drift risk."
  - "ActionBar shows 'Read-only' label (not just empty) when isTerminal: better UX than disappearing controls. Includes data-testid='inbox-readonly-label' for test discoverability."
  - "Edit button hidden unless email_status is draft/edited OR is absent (pre-D-05 inbox_index kinds): the existing entity_routing/new_entity flows had Edit available pre-Phase-11; preserving that path while gating new email-row Edit behavior."

metrics:
  task_count: 3
  file_count: 2 created / 9 modified
  test_count_added: 14 new (4 listInboxDrafts SQL + 5 inbox-merged UNION + 4 InboxItemSchema/EmailClassification + 3 InboxClient terminal-guard - 2 e2e replacements)
  total_test_count_passing: 95 dashboard-api / 121 dashboard / 76 contracts
  loc_delta: +1004 (+1106 / -102)
  duration_minutes: 16
---

# Phase 11 Plan 11-03: D-05 Inbox real-data wiring + classification Pills + terminal-status guard Summary

Drop the email-triage urgent-only filter, surface ALL classified email captures with classification × status pills, close the doc-vs-code gap on `/inbox-merged` (now also UNIONs `inbox_index` rows), and gate Approve/Skip on terminal-status items. Preserves the J/K/Enter/E/S keyboard floor (D-11) and the existing SSE-driven `router.refresh()` flow (D-14).

## Files Modified

| File | LOC delta | Role |
|------|----------:|------|
| packages/contracts/src/dashboard.ts | +38 | Add EmailClassificationSchema, EmailDraftStatusSchema, classification + email_status fields on InboxItemSchema, plus 'dead_letter' in InboxItemKindSchema |
| services/dashboard-api/src/email-drafts-persist.ts | +12 / -7 | listInboxDrafts: drop status-IN filter; default limit 50 → 100; doc-comment update |
| services/dashboard-api/src/routes/inbox.ts | +220 / -67 | mergedInboxHandler: UNION inbox_index; map to InboxItem shape; zod-at-exit |
| apps/dashboard/src/app/(app)/inbox/ItemRow.tsx | +18 / -3 | Render Pill below preview when classification set; add dead_letter icon |
| apps/dashboard/src/app/(app)/inbox/InboxClient.tsx | +28 / -3 | isTerminalInboxItem() helper + terminal guard in doApprove / doSkip |
| apps/dashboard/src/app/(app)/inbox/ItemDetail.tsx | +50 / -8 | Pill in header; Read-only label; data-testids on Approve/Edit/Skip |

## Files Created

| File | LOC | Tests |
|------|----:|------:|
| packages/contracts/test/dashboard.test.ts | 121 | 17 |
| services/dashboard-api/tests/inbox-merged.test.ts | 292 | 5 |

## Tests Added

| File | New tests | Suite |
|------|----------:|-------|
| services/dashboard-api/tests/email-drafts.test.ts | 4 | listInboxDrafts (Phase 11 D-05) |
| services/dashboard-api/tests/inbox-merged.test.ts | 5 | /inbox-merged UNION inbox_index |
| packages/contracts/test/dashboard.test.ts | 17 | EmailClassificationSchema / EmailDraftStatusSchema / InboxItemSchema |
| apps/dashboard/tests/unit/inbox-client.test.tsx | 3 | Terminal-status no-op guard |
| apps/dashboard/tests/e2e/inbox.spec.ts | 0 (3 placeholders → real bodies) | Skipped without PLAYWRIGHT_BASE_URL |

29 total new test cases. Existing tests unchanged and passing.

## Verification Results

| Check | Status |
|-------|--------|
| `pnpm -F @kos/contracts test` | ✓ 76 passed |
| `pnpm -F @kos/dashboard-api test` | ✓ 95 passed / 5 skipped (existing) |
| `pnpm -F @kos/dashboard test` | ✓ 121 passed / 4 todo (existing) |
| `pnpm -F @kos/contracts typecheck` | ✓ exit 0 |
| `pnpm -F @kos/dashboard-api typecheck` | ✓ exit 0 |
| `pnpm -F @kos/dashboard typecheck` | ✓ exit 0 |
| `pnpm -F @kos/dashboard lint` | ✓ exit 0 |

## TDD Gate Sequence

| Commit | Type | Subject |
|--------|------|---------|
| 9e7d733 | test | RED — failing tests for D-05 contract + listInboxDrafts |
| 3b3f235 | feat | GREEN — drop status filter + extend InboxItem contract |
| d64081d | test | RED — failing tests for /inbox-merged UNION inbox_index |
| f3a098a | feat | GREEN — UNION inbox_index + InboxItem-shaped response |
| 1ff2d94 | test | RED — terminal-status guard + Pill rendering |
| 12088c1 | feat | GREEN — render Pill + hide actions on terminal status |

All 3 tasks followed RED → GREEN cleanly. No REFACTOR commits needed; implementations were idiomatic on first pass.

## Acceptance Criteria — Per-Task Evidence

### Task 1
- ✓ `grep "status IN" services/dashboard-api/src/email-drafts-persist.ts` finds only the doc-comment reference (the actual SQL filter is gone)
- ✓ `grep "limit = 100" services/dashboard-api/src/email-drafts-persist.ts` returns 1 line (default raised)
- ✓ `grep -c "EmailClassificationSchema\|EmailDraftStatusSchema" packages/contracts/src/dashboard.ts` → 6 (definitions + usage)
- ✓ `grep "classification" packages/contracts/src/dashboard.ts | grep "optional"` → 1 (additive extension)
- ✓ `pnpm -F @kos/dashboard-api test --run email-drafts` → 14 passing (10 existing + 4 new)
- ✓ Contracts schema parse tests → 17 passing
- ✓ Typecheck clean

### Task 2
- ✓ `grep -c "FROM inbox_index" services/dashboard-api/src/routes/inbox.ts` → 1 (UNION query added)
- ✓ `grep "classification:" services/dashboard-api/src/routes/inbox.ts` → 4 lines (mapping + null fallbacks)
- ✓ `services/dashboard-api/tests/inbox-merged.test.ts` exists, 5 tests passing (originally 4 failing in RED)
- ✓ Existing `/inbox-merged` test in email-drafts.test.ts (Test 8) still passes
- ✓ Typecheck clean (no break for the route's new InboxListSchema-conformant response)
- ✓ Phase 11 doc-comment added at top of mergedInboxHandler

### Task 3
- ✓ `grep "data-testid=\"inbox-row-pill\"" apps/dashboard/src/app/(app)/inbox/ItemRow.tsx` → 1
- ✓ `grep -c "isTerminalInboxItem\|TERMINAL_EMAIL_STATUSES" apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` → 5 (definition + 2 uses + helper export + guard)
- ✓ `grep "approved\|sent\|skipped\|failed" apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` → ['approved', 'sent', 'skipped', 'failed']
- ✓ Action button data-testids: 3 in ItemDetail (`inbox-approve-btn`, `inbox-skip-btn`, `inbox-edit-btn`)
- ✓ `apps/dashboard/tests/e2e/inbox.spec.ts` no longer contains "Wave 2 will implement"
- ✓ `pnpm -F @kos/dashboard test --run inbox-client` → 13 passing (10 original + 3 new)
- ✓ Typecheck clean
- ✓ Lint clean

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical structural piece] Added 'dead_letter' to InboxItemKindSchema**
- **Found during:** Task 2 GREEN — running dashboard typecheck after the /inbox-merged rewrite
- **Issue:** The contract enum `InboxItemKindSchema` did not include 'dead_letter', yet the existing `/inbox-merged` route has been emitting `kind: 'dead_letter'` items since Phase 4 D-24. The dashboard never observed this drift because (a) prod has 0 dead-letter rows (Wave 0 inventory), and (b) the previous route response shape (`from`/`subject`/`body_preview`) wouldn't have passed `InboxListSchema.parse()` anyway. Plan 11-03 introduced zod-at-exit on mergedInboxHandler, which would now fail on any non-empty dead-letter row.
- **Fix:** Added 'dead_letter' to InboxItemKindSchema in `packages/contracts/src/dashboard.ts` with a comment noting it is only emitted by /inbox-merged (the legacy /inbox path never returns it).
- **Files modified:** `packages/contracts/src/dashboard.ts`, `apps/dashboard/src/app/(app)/inbox/ItemRow.tsx`, `apps/dashboard/src/app/(app)/inbox/ItemDetail.tsx` (KIND_ICON / KIND_LABEL records gained the new key)
- **Commit:** f3a098a (contract) + 12088c1 (UI records)

**2. [Rule 3 — Blocking] Worktree branch was stale (pre-Phase 11)**
- **Found during:** Plan startup
- **Issue:** The agent worktree was checked out at a pre-Phase-11 commit (`87e815e`); the planning files referenced files that didn't exist (Pill primitive, design-tokens, Wave 0 baselines all sit at `da38b41` on master).
- **Fix:** Created a new branch `phase-11-03-execute` from master so the worktree saw the actual Wave 0 + Wave 1 outputs. Ran `pnpm install --frozen-lockfile` to populate node_modules.
- **Commit:** N/A (workspace setup, not a code change)

### Other Minor Adjustments

- **Pill placement:** plan example put the Pill "between title and BolagBadge" (rightmost). The grid in ItemRow is `20px 1fr auto` with bolag in the third column — putting the Pill there would have squeezed BolagBadge or required a column-template change. Instead the Pill renders below the preview text inside the middle column (vertical stack). Mirrors the `.pri-row` meta-row pattern noted in 11-PATTERNS.md A1. data-testid catches it the same way.
- **Read-only display:** plan said "hide Approve/Skip" only. The implementation ALSO hides Edit when status is non-draft/edited, AND replaces the action row with a "Read-only" label so the user has positive confirmation rather than wondering whether the buttons just failed to render. data-testid="inbox-readonly-label" added for test discoverability.
- **Helper location:** plan example put `isTerminal()` inline in InboxClient. I exported it as `isTerminalInboxItem()` so ItemDetail can re-use the same predicate. Avoids two-source-of-truth drift between the keyboard handler and the button-render gates.

## Threat Model Compliance

| ID | Disposition | Status |
|----|-------------|--------|
| T-11-03-01 (Information disclosure — junk/informational subjects now visible) | accept | No new exposure surface; classification + body were already accessible via /api/email-drafts/:id. The single-user dashboard belongs to the email author or recipient. |
| T-11-03-02 (Approve double-fire on terminal item) | mitigate | isTerminalInboxItem() guards both the keyboard handler (doApprove early-return) and the button render (Approve hidden in ActionBar). Defense-in-depth alongside email-sender's idempotency on `email_send_authorizations`. |
| T-11-03-03 (Repudiation — operator can't tell classified-vs-sent from API) | accept | classification + email_status returned per row; clients can filter as needed. |
| T-11-03-04 (Elevation of privilege — new SQL query bypasses owner_scoped) | mitigate | New `loadInboxIndexPending()` in routes/inbox.ts uses `WHERE owner_id = ${OWNER_ID}` literal (PATTERNS shared section). Verified via `grep "OWNER_ID" services/dashboard-api/src/routes/inbox.ts` → 2 matches (import + use). |

No new threats discovered during execution. No `threat_flag` entries needed.

## Live Evidence

`/inbox-merged` now returns inbox_index rows: cannot curl from this worktree without dashboard-api credentials, but the unit test `Test 1: returns items from email_drafts + agent_dead_letter + inbox_index` directly proves the union via the SQL query patterns. A live curl is recommended once Wave 4 visual baselines run against the deployed Vercel preview.

Pill rendering: covered by Pill.test.tsx (Plan 11-02, 4 cases for the (classification, status) → label/tone matrix) + the new ItemRow integration via the inbox-row-pill data-testid. Visual baseline screenshot deferred to Wave 4 polish (`tests/e2e/visual.spec.ts`).

## Self-Check: PASSED

All commits + files verified post-write:

```text
[ -f packages/contracts/test/dashboard.test.ts ]                   → FOUND
[ -f services/dashboard-api/tests/inbox-merged.test.ts ]           → FOUND
[ -f services/dashboard-api/src/email-drafts-persist.ts ]          → FOUND (modified)
[ -f services/dashboard-api/src/routes/inbox.ts ]                  → FOUND (modified)
[ -f packages/contracts/src/dashboard.ts ]                         → FOUND (modified)
[ -f apps/dashboard/src/app/(app)/inbox/ItemRow.tsx ]              → FOUND (modified)
[ -f apps/dashboard/src/app/(app)/inbox/ItemDetail.tsx ]           → FOUND (modified)
[ -f apps/dashboard/src/app/(app)/inbox/InboxClient.tsx ]          → FOUND (modified)
[ -f apps/dashboard/tests/e2e/inbox.spec.ts ]                      → FOUND (modified)
[ -f apps/dashboard/tests/unit/inbox-client.test.tsx ]             → FOUND (modified)

git log --oneline | grep 9e7d733  → FOUND (Task 1 RED)
git log --oneline | grep 3b3f235  → FOUND (Task 1 GREEN)
git log --oneline | grep d64081d  → FOUND (Task 2 RED)
git log --oneline | grep f3a098a  → FOUND (Task 2 GREEN)
git log --oneline | grep 1ff2d94  → FOUND (Task 3 RED)
git log --oneline | grep 12088c1  → FOUND (Task 3 GREEN)
```

## Wave 3+ Open Questions

None. Wave 3 (Plan 11-04 / 11-05 / 11-06) can rely on:

- `InboxItem` has optional `classification` + `email_status` fields → safe to read or omit
- `'dead_letter'` is a valid InboxItemKind → renderers must handle it (KIND_ICON / KIND_LABEL maps must include it; this plan added that for the inbox surface)
- `/inbox-merged` returns the canonical InboxList shape → Plan 11-04 today aggregations + Plan 11-06 channel-health views can re-use the same client-side row primitives
- `isTerminalInboxItem()` is exported → any other surface that mutates email_drafts (Plan 11-04 today CapturesList?) can re-use the same guard
