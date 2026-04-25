---
phase: quick
plan: 260424-pxt
subsystem: dashboard
tags: [dashboard, ui, next-app-router, paper-cut, rsc]
one_liner: "Add /entities list RSC reusing getPaletteEntities() — resolves sidebar People/Projects 404s"
dependency_graph:
  requires: ["getPaletteEntities() from @/components/palette/palette-root"]
  provides: ["/entities list view (route)"]
  affects: ["apps/dashboard"]
tech_stack:
  added: []
  patterns: ["Next 15 App Router async searchParams", "RSC reuses SigV4 server helper via wrapper"]
key_files:
  created:
    - "apps/dashboard/src/app/(app)/entities/page.tsx"
  modified: []
decisions:
  - "Reuse getPaletteEntities() rather than calling callApi('/entities/list', …) directly — single source of truth with command palette; preserves the [] fallback pattern."
  - "Server-rendered only (no 'use client', no SSE refresh loop) — entity additions are user-initiated and rare; router.refresh() can be added in a follow-up if an entity_added SSE kind lands."
  - "Graceful ?type= fallback (invalid/missing → ALL view with filter chips) — never 404, never throw."
  - "Swedish-first locale sort (localeCompare(…, 'sv')) per CLAUDE.md bilingual constraint."
metrics:
  duration_seconds: 300
  tasks_completed: 1
  files_changed: 1
  completed_date: "2026-04-24"
  commit_hash: "522897c"
---

# Phase Quick Plan 260424-pxt: Fix Dashboard Sidebar 404 — Summary

## Overview

Paper cut #1 from the 2026-04-24 v2 handoff. Dashboard sidebar had hard-coded links to `/entities?type=person` and `/entities?type=project` (`Sidebar.tsx` lines 135, 141), but `apps/dashboard/src/app/(app)/entities/page.tsx` did not exist — every click 404'd. The detail route at `/entities/[id]/page.tsx` was already shipped; only the list entry was missing.

Fix: one new RSC file that reuses the existing `getPaletteEntities()` server helper (same loader the command palette uses, already wired to dashboard-api `/entities/list` via SigV4 with an empty-array fallback) and renders a filtered, Swedish-locale-sorted list.

## What Shipped

**New file:** `apps/dashboard/src/app/(app)/entities/page.tsx` (155 lines, server component, `dynamic = 'force-dynamic'`).

Behavior:

1. **Reads `?type=` (async, Next 15+ searchParams Promise).** Validates against `{person, project, company, document}`. Anything else → `filterType = null`, ALL view.
2. **Fetches via `getPaletteEntities()`** — no direct `callApi()` duplication, preserves the palette's try/catch + `[]` fallback.
3. **Filters in-memory** (endpoint already returns the full set; at KOS single-user scale this is fine).
4. **Swedish-locale alphabetical sort** (`localeCompare(b.name, 'sv')`).
5. **Renders:**
   - `<h1>` title: `People` | `Projects` | `Companies` | `Documents` | `Entities` (fallback).
   - Subheading: entity count with singular/plural handling.
   - Filter chips row (only when `filterType === null`) linking to each type.
   - Empty state: `"No <title> yet."` in a bordered rounded card.
   - List: `<ul>` of `<Link href="/entities/${id}">` rows — each row shows icon + name + optional bolag badge + type badge.
6. **`EntityIcon` helper:** maps `person → Users`, `project → Folder`, `company → Building2`, `document → FileText`, fallback → `HelpCircle` (all already present in lucide-react v1.8.0).
7. **Tailwind v4 CSS-variable palette** exactly matches Sidebar + inbox aesthetic (`text-[color:var(--color-text-2)]`, `bg-[color:var(--color-surface-hover)]`, etc.).

## Verification

- `pnpm tsc --noEmit` (dashboard-scoped): **clean** (no errors, only Node engine warning).
- `pnpm exec eslint src/app/(app)/entities/page.tsx`: **clean** (no output, no violations).
- `pnpm next build` (dashboard-scoped): **succeeds** — `/entities` appears as a `ƒ` (server-rendered on demand) route in the build manifest alongside `/entities/[id]`.
- Sidebar-link integrity: `grep 'href="/entities?type='` still returns 2 matches at lines 135 and 141 of `Sidebar.tsx` — unchanged.
- Post-commit: zero file deletions, zero untracked tracked files.

Manual dev-server smoke test (operator, post-deploy) — the four cases the plan calls out:
1. `/entities?type=person` → 200, People list.
2. `/entities?type=project` → 200, Projects list.
3. `/entities` (no param) → 200, ALL view with filter chips.
4. `/entities?type=garbage` → 200, ALL view (graceful fallback, not 404 or crash).

## Deviations from Plan

None of substance. Two minor notes:

1. **Spread before sort.** The plan's Step 6 code snippet does `.filter(...)` which returns a new array safe to sort in place, but when `filterType` is null the ternary returns `entities` directly (the shared reference returned by `getPaletteEntities()`). To avoid mutating a cached module-internal reference on future refactors, I wrapped the all-view branch with `[...entities]` before `.sort()`. Behaviorally identical; belt-and-suspenders against aliasing.
2. **`next-env.d.ts` auto-regenerated during `next build`.** Next 16 rewrote a `<reference path>` to an `import` statement. This file is explicitly "do not edit" per Next docs and regenerates on every build, so I reverted the change before committing (would have bounced back on the next build in any other environment).

No auto-fixes (Rule 1/2/3) triggered. No blockers. No auth gates.

## Why Reuse `getPaletteEntities()` (Locked Decision)

The palette's loader (`apps/dashboard/src/components/palette/palette-root.ts`) already wraps `callApi('/entities/list')` with Zod validation + try/catch + `[]` fallback — the "no crying wolf" pattern used throughout the app shell (same shape as `layout.tsx`'s `fetchSidebarCounts`). Duplicating that here would have introduced a second code path, a second schema copy, and a second failure mode to keep in sync. If dashboard-api's `/entities/list` response shape ever changes, both the palette and the new list page update together via the shared helper.

## Route Manifest (Post-Build)

```
Route (app)
├ ƒ /entities              ◀── NEW (this plan)
├ ƒ /entities/[id]
├ ƒ /entities/[id]/merge
└ ... (unchanged)
```

## Commit

`522897c` — `feat(quick-260424-pxt): add /entities list RSC to fix sidebar 404s`

## Files

- Created: `apps/dashboard/src/app/(app)/entities/page.tsx` (155 lines)
- Modified: none
- Deleted: none

## Success Criteria Check

- [x] `apps/dashboard/src/app/(app)/entities/page.tsx` exists and is a server component (no `'use client'`).
- [x] Sidebar links `/entities?type=person` and `/entities?type=project` now resolve to a real route (build manifest confirms `/entities` is emitted).
- [x] Page reuses `getPaletteEntities()` — zero direct `callApi('/entities/list', …)` calls.
- [x] Rows link to `/entities/${id}`.
- [x] Missing/invalid `?type=` renders ALL view with filter chips; never 404s, never crashes.
- [x] No new npm dependencies added (`git diff package.json` is empty).
- [x] `pnpm tsc --noEmit` clean; `pnpm next build` succeeds.
- [x] Swedish-locale alphabetical sort applied (`localeCompare(…, 'sv')`).

## Self-Check: PASSED

- FOUND file: `apps/dashboard/src/app/(app)/entities/page.tsx`
- FOUND commit: `522897c` (on branch `worktree-agent-adbe88f1f6772963d`)
- Build manifest includes `ƒ /entities`
- Sidebar grep matches unchanged (lines 135, 141)
