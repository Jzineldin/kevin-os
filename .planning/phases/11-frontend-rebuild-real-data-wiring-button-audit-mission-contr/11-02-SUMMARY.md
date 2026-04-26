---
phase: 11
plan: 2
subsystem: dashboard-ui
tags: [design-tokens, primitives, mission-control, shadcn, tdd]
wave: 1
status: complete
duration_seconds: 459
completed_at: 2026-04-26T18:17:00Z

dependency_graph:
  requires:
    - 11-00 (Wave 0 schema verification + button registry)
  provides:
    - design-tokens.ts typed registry (COLORS / TONES / SPACING)
    - Pill / StatTile / StatTileGrid / ChannelHealth / PriorityRow primitives
    - ChatBubble / ChatSheet shell components
    - shadcn sheet / progress / popover primitives
    - ChannelHealthItemSchema in @kos/contracts/dashboard (canonical home for plans 11-04 + 11-06)
  affects:
    - apps/dashboard/src/app/globals.css (.mc-* APPEND-only extension; @theme block byte-identical)
    - apps/dashboard/vitest.config.ts (added src/**/*.test glob to discover co-located tests)

tech_stack:
  added:
    - radix-ui Dialog (via Sheet wrapper)
    - radix-ui Popover
    - radix-ui Progress
  patterns:
    - "TONES indirection: components consume tone names; design-tokens.ts maps to color-mix(--color-*)"
    - "ChannelHealthItem type imported from @kos/contracts/dashboard (single source of truth for plans 11-04 + 11-06)"
    - "shadcn primitives use radix-ui meta-package (matches existing dialog.tsx / tabs.tsx convention)"
    - "PriorityRow polymorphic button/div based on onClick presence (D-11 keyboard floor)"

key_files:
  created:
    - apps/dashboard/src/lib/design-tokens.ts
    - apps/dashboard/src/components/dashboard/Pill.tsx
    - apps/dashboard/src/components/dashboard/Pill.test.tsx
    - apps/dashboard/src/components/dashboard/StatTile.tsx
    - apps/dashboard/src/components/dashboard/StatTile.test.tsx
    - apps/dashboard/src/components/dashboard/StatTileGrid.tsx
    - apps/dashboard/src/components/dashboard/ChannelHealth.tsx
    - apps/dashboard/src/components/dashboard/ChannelHealth.test.tsx
    - apps/dashboard/src/components/dashboard/PriorityRow.tsx
    - apps/dashboard/src/components/chat/ChatBubble.tsx
    - apps/dashboard/src/components/chat/ChatSheet.tsx
    - apps/dashboard/src/components/ui/sheet.tsx
    - apps/dashboard/src/components/ui/popover.tsx
    - apps/dashboard/src/components/ui/progress.tsx
  modified:
    - apps/dashboard/src/app/globals.css (APPEND .mc-* block at EOF)
    - apps/dashboard/vitest.config.ts (extend include glob for src/**/*.test)
    - packages/contracts/src/dashboard.ts (add ChannelHealthItemSchema + SchedulerHealthItemSchema + IntegrationsHealthResponseSchema)

decisions:
  - "Component dir layout: components/dashboard/ for mission-control primitives; components/chat/ for chat shell. Mirrors existing components/badge/, components/system/ pattern (single-purpose folders, not atomic split)."
  - "ChatSheet placeholder copy explicit about Phase 11-ter deferral so reviewers know the backend is intentional non-scope, not missing work."
  - "Co-located unit tests next to components (src/components/dashboard/*.test.tsx). Required vitest.config include glob extension. Trade-off vs centralized tests/unit/ — co-location keeps the primitive + its assertions in one diff, which matters when Wave 2 plans extend Pill mappings."
  - "ChannelHealthItem type defined in packages/contracts/src/dashboard.ts (NOT in the dashboard component itself). Plans 11-04 (page) + 11-06 (Today strip) import the canonical schema rather than duplicating the type. Re-exported as a type from ChannelHealth.tsx for convenience."
  - "Pill does NOT import from ChannelHealth and ChannelHealth does NOT import Pill (checker flagged this in iteration 2 of plan-checker). ChannelHealth specializes for healthy/degraded/down with inline tone resolution; Pill stays focused on D-05 email-classification mapping."

metrics:
  task_count: 3
  file_count: 14 created / 3 modified
  test_count: 9 new (4 Pill + 3 StatTile + 2 ChannelHealth) — all passing
  total_test_count: 14 passing in dashboard scope
  globals_css_lines_before: 345
  globals_css_lines_after: 400
  globals_css_delta: +55 lines (APPEND-only)
---

# Phase 11 Plan 02: Wave 1 — Design Tokens + Mission-Control Primitives + Chat Shell Summary

Built the typed design-token registry, four mission-control dashboard primitives (StatTile/StatTileGrid, Pill, ChannelHealth, PriorityRow), the chat-shell components (ChatBubble + ChatSheet — visual-only, backend deferred to Phase 11-ter), three new shadcn primitives (sheet, progress, popover), and the canonical ChannelHealthItemSchema in @kos/contracts/dashboard. Extended globals.css APPEND-only with `.mc-*` namespaced classes consuming the existing `--color-*` token system. 9 new unit tests, all passing.

## Components Created

| Path | Lines | Role |
|------|-------|------|
| apps/dashboard/src/lib/design-tokens.ts | 69 | Typed COLORS / TONES / SPACING registry |
| apps/dashboard/src/components/dashboard/Pill.tsx | 107 | D-05 (classification, status) → label+tone+pulse |
| apps/dashboard/src/components/dashboard/StatTile.tsx | 89 | Caps-label + giant numeric tile w/ tonal icon chip |
| apps/dashboard/src/components/dashboard/StatTileGrid.tsx | 22 | 4-column desktop grid wrapper |
| apps/dashboard/src/components/dashboard/ChannelHealth.tsx | 143 | Channel row list w/ healthy/degraded/down pill + relative time |
| apps/dashboard/src/components/dashboard/PriorityRow.tsx | 61 | Polymorphic button/div around `.pri-row` |
| apps/dashboard/src/components/chat/ChatBubble.tsx | 34 | Floating bottom-right action button |
| apps/dashboard/src/components/chat/ChatSheet.tsx | 59 | Right-anchored shadcn Sheet drawer w/ Phase 11-ter placeholder |
| apps/dashboard/src/components/ui/sheet.tsx | 147 | shadcn Sheet (radix-ui Dialog re-export) |
| apps/dashboard/src/components/ui/popover.tsx | 89 | shadcn Popover |
| apps/dashboard/src/components/ui/progress.tsx | 31 | shadcn Progress |

All component file targets in plan frontmatter `files_modified` met. Total component LOC (excluding tests + shadcn): ~584 across 8 KOS-owned components.

## Tests Added

| Test File | Cases | Pass |
|-----------|-------|------|
| Pill.test.tsx | 4 (urgent×draft → danger; important×sent → info; null×pending_triage → accent+pulse; junk×skipped → dim) | ✓ |
| StatTile.test.tsx | 3 (label + value rendering; zero-value not blanked; tone applies) | ✓ |
| ChannelHealth.test.tsx | 2 (channel list with name+status; empty-state) | ✓ |

Run: `pnpm -F @kos/dashboard test -- dashboard` → **14 tests passing** (5 pre-existing dashboard-api + 9 new). Vitest config extended to discover `src/**/*.test.{ts,tsx}` alongside the existing `tests/unit/**` glob.

## globals.css Extension — APPEND-Only

| Aspect | Before | After |
|--------|--------|-------|
| Total lines | 345 | 400 |
| Delta | +55 lines | All inside the new Phase 11 mission-control block |
| `@theme` block (lines 8-70) | Untouched | Untouched (verified via `git diff … \| grep "^-" \| grep -c "@theme"` → 0) |
| `.mc-*` class count | 0 | 8 (`.mc-stat-tile`, `.mc-stat-tile:hover`, `.mc-channel-bar`, `.mc-channel-bar:hover`, `.mc-pill[data-pulse="true"]`, `.mc-chat-bubble`, `.mc-chat-bubble:hover`, `.mc-chat-bubble:focus-visible`) |

All `.mc-*` rules consume existing tokens: `--color-bg`, `--color-surface-1`, `--color-surface-2`, `--color-accent`, `--color-accent-2`, `--color-border`, `--ease`, `--transition-fast`. NO new color values added.

## shadcn Primitives Installed

`npx shadcn@latest add sheet progress popover` — created 3 files at `apps/dashboard/src/components/ui/{sheet,progress,popover}.tsx`. All three import from the existing `radix-ui` meta-package (matches `dialog.tsx` and `tabs.tsx` conventions). No new transitive deps — `radix-ui@1.4.3` already in `apps/dashboard/package.json`.

## ChannelHealthItem Contract — Canonical Home

Added to `packages/contracts/src/dashboard.ts` (lines 197-235):

- `ChannelHealthItemSchema` — `{ name, type: 'capture'|'scheduler', status: 'healthy'|'degraded'|'down', last_event_at: string|null }`
- `SchedulerHealthItemSchema` — for the `/integrations-health` page's scheduler block
- `IntegrationsHealthResponseSchema` — wraps both arrays

Plan 11-04 (`/integrations-health` page) and Plan 11-06 (Today channel-health strip) MUST import from `@kos/contracts/dashboard`. The ChannelHealth.tsx component re-exports the type as a convenience for direct consumers but does not redefine it.

## Commits

| Hash | Type | Subject |
|------|------|---------|
| 497159a | feat | scaffold design-token registry + shadcn primitives + ChannelHealth contract |
| 0f6bffd | test | add failing tests for Pill / StatTile / ChannelHealth (TDD RED) |
| d1076b8 | feat | mission-control primitives Pill / StatTile / ChannelHealth / PriorityRow (TDD GREEN) |
| 00def71 | feat | chat shell — ChatBubble + ChatSheet (visual-only, backend deferred) |

TDD RED → GREEN gate sequence honored: `test(...)` commit (0f6bffd) precedes the implementing `feat(...)` commit (d1076b8). No REFACTOR commit — implementation was clean on first pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Vitest config did not discover co-located src/**/*.test.tsx**
- **Found during:** Task 2 RED phase (initial test run failed to even resolve test files)
- **Issue:** `apps/dashboard/vitest.config.ts` `include` glob was `['tests/unit/**', 'tests/integration/**']`. The plan specifies tests at `src/components/dashboard/*.test.tsx` paths in the frontmatter `files_modified`, but vitest was excluding them.
- **Fix:** Added `src/**/*.test.{ts,tsx}` to the include glob with a comment pointing back to Plan 11-02 acceptance criterion.
- **Files modified:** apps/dashboard/vitest.config.ts
- **Commit:** 0f6bffd (bundled with TDD RED commit)

**2. [Rule 2 — Missing critical structural piece] ChannelHealthItemSchema added to canonical contracts location**
- **Found during:** Pre-Task-1 prompt directive review (executor prompt explicitly listed this as a Task 1 deliverable, but the original plan body did not enumerate the contracts file in `files_modified`).
- **Issue:** Per plan-checker iteration 2, ChannelHealthItem must live in `@kos/contracts/dashboard` (canonical home for plans 11-04 + 11-06). Without this, downstream plans would either (a) redefine the type — drift risk — or (b) fail to typecheck.
- **Fix:** Added `ChannelHealthItemSchema`, `SchedulerHealthItemSchema`, and `IntegrationsHealthResponseSchema` to `packages/contracts/src/dashboard.ts` between the existing entity-edit and calendar sections.
- **Files modified:** packages/contracts/src/dashboard.ts
- **Commit:** 497159a

### Other Minor Adjustments

- **Pill aria-hidden on pulse-dot:** Added `aria-hidden` to the `<span className="pulse-dot" />` inside Pill so screen readers announce only the label, not the decorative dot. (D-11 keyboard floor + accessibility hygiene — Rule 2.)
- **PriorityRow polymorphic split:** Implemented as `if (onClick) return <button>; else return <div>;` rather than the dynamic-tag approach in the plan example. The dynamic-tag pattern fails TS strict mode when passing `type="button"` conditionally; the split form is cleaner and types correctly.
- **ChannelHealth type re-export:** Re-exports `ChannelHealthItem` from contracts as a convenience for callers — does not redefine. Plan-checker constraint honored (canonical schema lives in contracts only).
- **No glassmorphism / .macos-panel:** Per RESEARCH "trap" callout — used flat `surface-1` over the existing token system. Confirmed via grep: zero `backdrop-filter` rules added.

## Verification Results

| Check | Status |
|-------|--------|
| `pnpm -F @kos/dashboard typecheck` | ✓ exit 0 |
| `pnpm -F @kos/dashboard test -- dashboard` | ✓ 14/14 passing |
| `pnpm -F @kos/dashboard lint --fix` | ✓ no errors |
| @theme block byte-identical | ✓ 0 minus-lines for `@theme` in `git diff` |
| `.mc-*` class count | ✓ 8 (>= 4) |
| Pill covers 10 D-05 tuples | ✓ 4 tests + remaining branches in `resolvePill()` |
| 9 new unit tests pass | ✓ 4 Pill + 3 StatTile + 2 ChannelHealth |

## Wave 2 Open Question

**Confirm StatTileGrid's 4-column layout is desktop-only — Wave 4 polish handles tablet collapse.** Current implementation hardcodes `gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'`. At narrow viewports (<900px) this will produce cramped tiles. Acceptable per D-10 (mobile/responsive deferred), but flagged here so Wave 2 page authors don't try to retrofit responsive behavior on the primitive itself.

## Threat Model Compliance

All four threats from PLAN frontmatter `<threat_model>` resolved or mitigated as designed:

- **T-11-02-01 (Information disclosure via Pill DOM):** `accept` — Pill renders only the LABEL ("URGENT — Draft ready" etc.), never email body content. Verified by reading the `resolvePill()` switch.
- **T-11-02-02 (shadcn supply-chain):** `mitigate` — primitives committed verbatim; no new transitive deps (radix-ui already in package.json). Diff inspected before commit.
- **T-11-02-03 (globals.css mutation):** `mitigate` — verified `@theme` block byte-identical via `git diff` (acceptance criterion). New rules appended below the `@layer base` block at EOF.
- **T-11-02-04 (animation perf regression):** `accept` — only animation added is `.mc-chat-bubble:hover` color/transform transition + reuse of existing `.pulse-dot` keyframe. No new keyframes, no continuous animations.

## Self-Check: PASSED

- All 14 file paths verified to exist on disk
- All 4 task commits verified in `git log` (497159a, 0f6bffd, d1076b8, 00def71)
- TDD gate sequence verified: 0f6bffd (`test:`) precedes d1076b8 (`feat:`)
- Final typecheck + test run clean

## Wave 2 Readiness

Plans 11-03 / 11-04 / 11-05 / 11-06 can now `import { Pill, StatTile, StatTileGrid, ChannelHealth, PriorityRow }` from `@/components/dashboard/*` without further work. Plan 11-07 can `import { ChatBubble }` from `@/components/chat/ChatBubble`. The contract `ChannelHealthItemSchema` is the single import for any plan that surfaces channel-health data.
