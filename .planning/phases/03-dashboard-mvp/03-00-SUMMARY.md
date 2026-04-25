---
phase: 03
plan: 00
subsystem: dashboard-mvp-wave-0
tags: [dashboard, monorepo, nextjs, tailwind-v4, vitest, playwright, lighthouse, ci]
dependency_graph:
  requires: []
  provides:
    - "apps/dashboard workspace (Next 15.5.4 + React 19.2.5 + Tailwind 4.2.4)"
    - "@kos/contracts/dashboard zod schemas (single source of truth)"
    - "3 dashboard-* service scaffolds (api, listen-relay, notify)"
    - "Wave 0 test infra (vitest + playwright + lighthouse + CI)"
  affects:
    - pnpm-workspace.yaml
    - packages/contracts
    - packages/test-fixtures
tech_stack:
  added:
    - "next@15.5.4"
    - "react@19.2.5 + react-dom@19.2.5"
    - "tailwindcss@4.2.4 + @tailwindcss/postcss@4.2.4"
    - "@playwright/test@1.51.1"
    - "@vitejs/plugin-react@4.3.4"
    - "@testing-library/react@16.1.0 + @testing-library/jest-dom@6.6.3"
    - "jsdom@25.0.1"
    - "fastify@5.1.0"
    - "pg-listen@1.7.0"
  patterns:
    - "Tailwind v4 @theme directive (CSS-first token port from TFOS-ui.html :root)"
    - "workspace subpath exports (@kos/contracts/dashboard)"
    - "test.fixme() + it.todo() scaffold stubs mapped 1:1 to requirements"
key_files:
  created:
    - apps/dashboard/package.json
    - apps/dashboard/tsconfig.json
    - apps/dashboard/next.config.ts
    - apps/dashboard/postcss.config.mjs
    - apps/dashboard/next-env.d.ts
    - apps/dashboard/.gitignore
    - apps/dashboard/src/app/globals.css
    - apps/dashboard/src/app/layout.tsx
    - apps/dashboard/src/app/page.tsx
    - apps/dashboard/vitest.config.ts
    - apps/dashboard/playwright.config.ts
    - apps/dashboard/lighthouserc.json
    - apps/dashboard/tests/unit/setup.ts
    - apps/dashboard/tests/unit/sentinel.test.ts
    - apps/dashboard/tests/e2e/fixtures.ts
    - apps/dashboard/tests/e2e/pwa-install.spec.ts
    - apps/dashboard/tests/e2e/pwa-offline.spec.ts
    - apps/dashboard/tests/e2e/sse-reconnect.spec.ts
    - apps/dashboard/tests/e2e/merge-audit.spec.ts
    - apps/dashboard/tests/e2e/inbox-keyboard.spec.ts
    - apps/dashboard/tests/e2e/auth-middleware.spec.ts
    - apps/dashboard/tests/e2e/today.spec.ts
    - apps/dashboard/tests/e2e/entity.spec.ts
    - apps/dashboard/tests/e2e/timeline.spec.ts
    - apps/dashboard/tests/e2e/calendar.spec.ts
    - apps/dashboard/tests/integration/api-layer.test.ts
    - apps/dashboard/tests/integration/sse.test.ts
    - packages/contracts/src/dashboard.ts
    - packages/contracts/src/index.ts
    - packages/test-fixtures/src/dashboard/index.ts
    - services/dashboard-api/package.json
    - services/dashboard-api/tsconfig.json
    - services/dashboard-api/src/index.ts
    - services/dashboard-api/src/handlers/.gitkeep
    - services/dashboard-api/tests/merge-transactional.test.ts
    - services/dashboard-api/tests/merge-partial.test.ts
    - services/dashboard-api/tests/merge-resume.test.ts
    - services/dashboard-api/tests/timeline.test.ts
    - services/dashboard-listen-relay/package.json
    - services/dashboard-listen-relay/tsconfig.json
    - services/dashboard-listen-relay/src/index.ts
    - services/dashboard-listen-relay/tests/listen-reconnect.test.ts
    - services/dashboard-notify/package.json
    - services/dashboard-notify/tsconfig.json
    - services/dashboard-notify/src/index.ts
    - services/dashboard-notify/tests/notify-payload.test.ts
    - .github/workflows/dashboard-ci.yml
  modified:
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - packages/contracts/package.json
    - packages/test-fixtures/package.json
    - .planning/phases/03-dashboard-mvp/03-VALIDATION.md
decisions:
  - "Use zod 3.23.8 (monorepo pin) instead of plan-stated 4.3.6 — rest of repo on v3; avoids a workspace-wide zod upgrade inside a Wave-0 scaffold plan."
  - "Pin @playwright/test to 1.51.1 (not 1.49.0) to satisfy Next 15.5 peer requirement."
  - "Promote experimental.typedRoutes to stable top-level typedRoutes (Next 15.5 deprecation notice)."
  - "Expose @kos/contracts both as barrel (./) and subpath (./dashboard, ./events) so downstream code can use whichever import style suits."
  - "Add a unit sentinel test so `vitest run` exits 0 on a bare scaffold without `--passWithNoTests` gymnastics."
metrics:
  duration: "11m41s"
  tasks_committed: 3
  files_created: 47
  files_modified: 5
  completed_date: "2026-04-23"
---

# Phase 3 Plan 00: Dashboard MVP — Wave 0 Scaffold Summary

**One-liner:** Lays the Next 15.5 + Tailwind v4 + Vitest + Playwright + Lighthouse CI foundation for Phase 3 dashboard work — adds `apps/*` to pnpm workspaces, ports the TFOS-ui.html design tokens verbatim into `@theme`, authors `@kos/contracts/dashboard` zod schemas (single source of truth for both Vercel and the in-VPC Lambda), scaffolds 3 new `services/dashboard-*` workspaces, and creates all 18 Wave-0 test-infra gap files from 03-VALIDATION.md so downstream Wave 1+ plans can proceed.

## What shipped

### Task 1 (commit `f041d26`) — Monorepo + dashboard app bootstrap
- Added `- 'apps/*'` to `pnpm-workspace.yaml` (first `apps/*` entry in the monorepo).
- Created `apps/dashboard` workspace (`@kos/dashboard`) pinned to:
  - `next@15.5.4`, `react@19.2.5`, `react-dom@19.2.5`, `typescript@5.6.3` (monorepo-wide version)
  - `tailwindcss@4.2.4`, `@tailwindcss/postcss@4.2.4`, `postcss@8.5.1`
- Ported the `TFOS-ui.html` `:root` design tokens 1:1 into `src/app/globals.css` via the Tailwind v4 `@theme` directive. All surfaces, borders, text colours, accent (`#7c5bff`), desaturated status colours, bolag tints, motion easings, transition durations, 8-step type scale (11-36), 5-step radii scale, and the `pulse-dot` keyframe (D-12) are present.
- Wired `Geist` + `Geist_Mono` via `next/font/google` in `layout.tsx` (subsets: latin, display: swap).
- `next.config.ts` enables `reactStrictMode`, declares `transpilePackages: ['@kos/db', '@kos/contracts']`, and turns on the stable `typedRoutes` flag.
- Minimal `page.tsx` renders a single centred `pulse-dot` per D-12 motion rule.

### Task 2 (commit `c18c911`) — Shared zod contracts + fixtures
- Authored `packages/contracts/src/dashboard.ts` with every schema the routing table in RESEARCH §7 requires:
  - **Today** (`TodayBriefSchema`, `TodayPrioritySchema`, `TodayDraftSchema`, `TodayDroppedThreadSchema`, `TodayMeetingSchema`, `TodayResponseSchema`)
  - **Entity + timeline** (`EntityResponseSchema`, `TimelineRowSchema`, `TimelinePageSchema`, 8-value `TimelineRowKindSchema`)
  - **Inbox** (`InboxItemSchema`, `InboxListSchema`, `InboxApproveSchema`, `InboxEditSchema`, `InboxActionResponseSchema`; 4-value `InboxItemKindSchema`)
  - **Merge** (`MergeRequestSchema` with ULID `merge_id`, `MergeResponseSchema`, `MergeResumeRequestSchema`)
  - **Capture** (`CapturePostSchema` with refine guard, `CaptureResponseSchema`)
  - **SSE** (`SseEventSchema` + `SseEventKindSchema` — the 5 kinds from D-25 verbatim: `inbox_item`, `entity_merge`, `capture_ack`, `draft_ready`, `timeline_event`)
  - **Auth** (`LoginRequestSchema`, `LoginResponseSchema`)
- Added `packages/contracts/src/index.ts` barrel re-exporting both `events.ts` and `dashboard.ts`; extended `packages/contracts/package.json` exports map with `./events` and `./dashboard` subpaths plus the root.
- Added `packages/test-fixtures/src/dashboard/index.ts` with deterministic factory helpers (`makeTodayResponse`, `makeEntityResponse`, `makeTimelinePage`, `makeInboxItem`, `makeMergeRequest`, `makeSseEvent`, `makeCaptureResponse`) that return zod-valid data. Declared the `@kos/contracts` workspace dep in `packages/test-fixtures/package.json` and exposed a `./dashboard` subpath.

### Task 3 (commit `4d04ef9`) — Wave-0 test harness + 3 service scaffolds + CI
- **3 service workspaces scaffolded and typecheck-clean:**
  - `services/dashboard-api` (Node 22 Lambda stub; drizzle-orm + pg + rds-signer + notion-client deps ready for plan 03-03).
  - `services/dashboard-listen-relay` (Fastify scaffold for 0.25 vCPU Fargate task; pg-listen pinned at 1.7.0; `/healthz` + `/events` stubs).
  - `services/dashboard-notify` (EventBridge-rule Lambda echoing `detail-type`).
- **Dashboard test harness:**
  - `vitest.config.ts` — jsdom env, `@` → `src` alias, jest-dom setup file, excludes `tests/e2e/**`.
  - `playwright.config.ts` — Chromium + Pixel 7 projects, `baseURL` via `PLAYWRIGHT_BASE_URL`, `storageState` via env.
  - `lighthouserc.json` — perf budgets from 03-VALIDATION.md (TTI < 1.5s, TBT < 300ms, CLS < 0.1 on `/`, `/inbox`, `/calendar`).
  - `tests/unit/setup.ts` wires `@testing-library/jest-dom`; `sentinel.test.ts` keeps the suite at ≥1 passing test.
  - `tests/e2e/fixtures.ts` with `authCookie()` helper (P-10 pitfall guard: `KOS_TEST_BEARER_TOKEN` never leaves runner).
- **10 Playwright e2e stubs** (`test.fixme`, mapped 1:1 to requirements UI-01..06, ENT-07/08, INF-12): `pwa-install`, `pwa-offline`, `sse-reconnect`, `merge-audit`, `inbox-keyboard`, `auth-middleware`, `today`, `entity`, `timeline`, `calendar`.
- **2 dashboard integration stubs** (`it.todo`): `api-layer` (SigV4), `sse` (NOTIFY → EventSource).
- **6 service vitest stubs**: `merge-transactional`, `merge-partial`, `merge-resume`, `timeline` (under `dashboard-api/tests/`); `listen-reconnect` (under `dashboard-listen-relay/tests/`); `notify-payload` (under `dashboard-notify/tests/`).
- **CI** — `.github/workflows/dashboard-ci.yml` with `quick` job (typecheck + vitest across 4 workspaces) on PR and `full` job (Playwright install + build + e2e, `KOS_TEST_BEARER_TOKEN` + `VERCEL_PREVIEW_URL` secrets) on master/main.
- **VALIDATION.md updates**: 18 Wave-0 checklist items flipped to `[x]`, `wave_0_complete: true` in frontmatter, Per-Task Verification Map populated with rows `T-03-W0-A` (scaffold), `T-03-W0-B` (contracts), `T-03-W0-C` (test infra) each mapped to threat-model refs `T-3-00-{01,02,03}`.

## Verification results

| Command | Result |
| --- | --- |
| `pnpm install --prefer-offline` | succeeded after 3 rounds (new workspaces + bumped Playwright peer to 1.51.1) |
| `pnpm --filter @kos/dashboard typecheck` | clean (TS 5.6.3, strict) |
| `pnpm --filter @kos/dashboard build` | clean (2 static routes, 102 kB first-load JS) |
| `pnpm --filter @kos/dashboard test` | 1 passed + 4 todo, 2 skipped (todo suites collapse to skipped files) |
| `pnpm --filter @kos/dashboard-api test` | 8 todo / 4 skipped files |
| `pnpm --filter @kos/dashboard-listen-relay test` | 2 todo / 1 skipped file |
| `pnpm --filter @kos/dashboard-notify test` | 2 todo / 1 skipped file |
| `pnpm --filter @kos/dashboard exec playwright test --list` | 28 tests across 10 spec files (chromium + mobile-android projects) |
| `pnpm --filter @kos/contracts typecheck` | clean |
| `pnpm --filter @kos/test-fixtures typecheck` | clean |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 – Compatibility] zod pin mismatch**
- **Found during:** Task 2
- **Issue:** Plan specified `zod@4.3.6`; monorepo is on `zod@3.23.8` (confirmed in root package.json + all Phase 2 services).
- **Fix:** Authored `packages/contracts/src/dashboard.ts` with zod-v3-compatible syntax (`z.record(z.unknown())` one-arg form, `z.string().datetime()`, `z.string().uuid()`). Added a file-level comment documenting the future upgrade path.
- **Files modified:** `packages/contracts/src/dashboard.ts`
- **Commit:** `c18c911`

**2. [Rule 3 – Dependency compatibility] @playwright/test peer requirement**
- **Found during:** Task 1 install
- **Issue:** Plan pinned `@playwright/test@1.49.0`, but Next 15.5.4 has peer `@playwright/test@^1.51.1`. `pnpm install` surfaced an unmet-peer warning.
- **Fix:** Bumped pin to `@playwright/test@1.51.1`.
- **Files modified:** `apps/dashboard/package.json`
- **Commit:** `f041d26`

**3. [Rule 1 – Deprecation] Next 15.5 typedRoutes config key**
- **Found during:** Task 3 build
- **Issue:** Initial `next.config.ts` placed `typedRoutes` under `experimental`. Next 15.5 warns: "experimental.typedRoutes has been moved to typedRoutes."
- **Fix:** Promoted to the stable top-level config key.
- **Files modified:** `apps/dashboard/next.config.ts`
- **Commit:** `4d04ef9`

**4. [Rule 3 – Scaffold hygiene] `apps/dashboard/.gitignore` missing**
- **Found during:** Task 3 post-build
- **Issue:** First `next build` produced `.next/` artefacts that were not git-ignored.
- **Fix:** Added a local `.gitignore` covering `.next/`, `out/`, `test-results/`, `playwright-report/`, `playwright/.cache/`, `.lighthouseci/`.
- **Files modified:** `apps/dashboard/.gitignore` (new).
- **Commit:** `4d04ef9`

**5. [Rule 3 – Exports shape] `packages/contracts` lacked an `index.ts`**
- **Found during:** Task 2
- **Issue:** Plan required `export * from './dashboard.js'` in `packages/contracts/src/index.ts`, but the file did not exist (package `main` pointed at `src/events.ts`).
- **Fix:** Authored `src/index.ts` barrel re-exporting both `events.ts` and `dashboard.ts`; updated `packages/contracts/package.json` `main` / `types` / `exports` to expose `.` (barrel), `./events`, and `./dashboard` subpaths. No existing consumer imports change.
- **Files modified:** `packages/contracts/src/index.ts` (new), `packages/contracts/package.json`
- **Commit:** `c18c911`

### Deferred Issues

**1. Pre-existing zod peer-warning cascade** (out of scope per Rule SCOPE BOUNDARY)
- Phase 2 `services/entity-resolver` pulls `@anthropic-ai/claude-agent-sdk@0.2.117` whose transitive deps want `zod@^3.25 || ^4`. `pnpm install` surfaces the warning on every run. Resolving it means bumping root `zod` (touches every Phase 2 service). Deferred to a dedicated infra bump — not part of Wave 0 scaffold scope.

**2. Pre-existing `.eslintrc.cjs` conflict** (out of scope)
- `next build` reports: `ESLint: Plugin "@typescript-eslint" was conflicted between "..\..\.eslintrc.cjs" and "..\..\..\..\..\.eslintrc.cjs"`. The second path is an ancestor directory above the project root (likely a user-wide config). Does not block lint or build; warning only. No change made here.

**3. `TFOS-ui.html` binding-spec file absent from git**
- The plan's "read_first" step 3 listed `TFOS-ui.html lines 12-100` as the source of truth for tokens. The file was never committed (it appears in project-root working trees only as an untracked file per the opening git status). RESEARCH §2 contains the authoritative `@theme` token port, which was used verbatim. No decision deviation — just a provenance note for future auditors.

### Auth gates

None encountered. All work was local-filesystem + pnpm-registry only.

## Ready for Wave 1

Every Wave 1 plan (03-01..03-13) can now import:
- `@kos/dashboard` workspace (Next 15.5 + Tailwind tokens live).
- `@kos/contracts/dashboard` (every zod schema the API layer needs).
- `@kos/test-fixtures/dashboard` (deterministic factories for tests).
- `@kos/dashboard-api`, `@kos/dashboard-listen-relay`, `@kos/dashboard-notify` (scaffolds ready to receive handler code).

Plan 03-01 picks up next with shadcn/ui init, sidebar shell, and command palette.

## Known Stubs

These stubs are **intentional** — Wave 0's purpose is to create the test harness and scaffolds for downstream plans. They will be replaced in the waves listed:

| File | Reason | Resolved In |
| --- | --- | --- |
| `apps/dashboard/src/app/page.tsx` | renders only the `pulse-dot` sentinel | Plan 03-04 (Today view) |
| `services/dashboard-api/src/index.ts` | returns 501 Not Implemented | Plans 03-03/05/07/08 (routes) |
| `services/dashboard-listen-relay/src/index.ts` | `/healthz` + `/events` echo empty | Plan 03-06 (pg-listen wiring) |
| `services/dashboard-notify/src/index.ts` | echoes `detail-type` | Plan 03-06 (NOTIFY publish) |
| 10 Playwright specs + 2 integration stubs + 6 service vitests | `test.fixme` / `it.todo` placeholders | Plans 03-02..03-11 per requirement mapping |

## Self-Check

### Files created / exist

- FOUND: `apps/dashboard/package.json`
- FOUND: `apps/dashboard/src/app/globals.css`
- FOUND: `apps/dashboard/src/app/layout.tsx`
- FOUND: `apps/dashboard/src/app/page.tsx`
- FOUND: `apps/dashboard/next.config.ts`
- FOUND: `apps/dashboard/postcss.config.mjs`
- FOUND: `apps/dashboard/tsconfig.json`
- FOUND: `apps/dashboard/next-env.d.ts`
- FOUND: `apps/dashboard/.gitignore`
- FOUND: `apps/dashboard/vitest.config.ts`
- FOUND: `apps/dashboard/playwright.config.ts`
- FOUND: `apps/dashboard/lighthouserc.json`
- FOUND: `apps/dashboard/tests/unit/setup.ts`
- FOUND: `apps/dashboard/tests/unit/sentinel.test.ts`
- FOUND: `apps/dashboard/tests/e2e/fixtures.ts`
- FOUND: `apps/dashboard/tests/e2e/pwa-install.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/pwa-offline.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/sse-reconnect.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/merge-audit.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/inbox-keyboard.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/auth-middleware.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/today.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/entity.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/timeline.spec.ts`
- FOUND: `apps/dashboard/tests/e2e/calendar.spec.ts`
- FOUND: `apps/dashboard/tests/integration/api-layer.test.ts`
- FOUND: `apps/dashboard/tests/integration/sse.test.ts`
- FOUND: `packages/contracts/src/dashboard.ts`
- FOUND: `packages/contracts/src/index.ts`
- FOUND: `packages/test-fixtures/src/dashboard/index.ts`
- FOUND: `services/dashboard-api/package.json` + `tsconfig.json` + `src/index.ts` + 4 test stubs
- FOUND: `services/dashboard-listen-relay/package.json` + `tsconfig.json` + `src/index.ts` + 1 test stub
- FOUND: `services/dashboard-notify/package.json` + `tsconfig.json` + `src/index.ts` + 1 test stub
- FOUND: `.github/workflows/dashboard-ci.yml`

### Commits exist

- FOUND: `f041d26` (Task 1)
- FOUND: `c18c911` (Task 2)
- FOUND: `4d04ef9` (Task 3)

## Self-Check: PASSED
