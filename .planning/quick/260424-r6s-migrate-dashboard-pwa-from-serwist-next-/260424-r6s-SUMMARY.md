---
phase: quick-260424-r6s
plan: 01
subsystem: ui
tags: [pwa, serwist, turbopack, nextjs-16, middleware, vercel]

requires:
  - phase: 03-dashboard-mvp
    provides: Plan 03-12 PWA (sw.ts + manifest + runtime caching + middleware bypass)
provides:
  - "@serwist/turbopack migration path from @serwist/next under Next 16 Turbopack (Webpack-only @serwist/next was silent no-op)"
  - "/serwist/sw.js Route Handler serving the esbuild-bundled SW (replaces public/sw.js build emission)"
  - "SerwistProvider client-side registration (replaces @serwist/next's injected <script>)"
  - "Middleware + matcher bypass for /serwist/ prefix (replaces per-file /sw.js bypass)"
affects: [phase-03, phase-07, phase-08]

tech-stack:
  added: ["@serwist/turbopack 9.5.7", "esbuild 0.25.12"]
  patterns:
    - "Next.js Route Handler + generateStaticParams prerenders SW as SSG at build time"
    - "Client-side SW registration via React provider (disable/cacheOnNavigation/reloadOnOnline live on provider, not next.config)"

key-files:
  created:
    - "apps/dashboard/src/app/serwist/[path]/route.ts"
    - "apps/dashboard/src/components/pwa/serwist-provider.tsx"
  modified:
    - "apps/dashboard/package.json"
    - "apps/dashboard/next.config.ts"
    - "apps/dashboard/src/app/sw.ts"
    - "apps/dashboard/src/app/layout.tsx"
    - "apps/dashboard/src/middleware.ts"
    - "apps/dashboard/.gitignore"
    - "pnpm-lock.yaml"

key-decisions:
  - "SW URL changed /sw.js → /serwist/sw.js (Route Handler lives under /serwist/[path])"
  - "useNativeEsbuild: true set explicitly on createSerwistRoute (belt-and-braces on Linux)"
  - "Sentry(OUTER) → Serwist(INNER) wrapping order preserved"
  - "disable=NODE_ENV==='development' moved from next.config.ts to client provider"

patterns-established:
  - "Route-Handler-served service workers: @serwist/turbopack streams esbuild output; no public/ emission"
  - "Middleware bypass uses path-prefix (/serwist/) instead of per-filename (/sw.js), covers sourcemaps + any future chunk files"

requirements-completed: []  # PAPER-CUT-2 placeholder; no formal requirement IDs for quick tasks

duration: ~20min (up to Gate 4 block)
completed: null  # blocked at Gate 4 — see "Issues Encountered"
---

# Quick 260424-r6s: Dashboard PWA @serwist/next → @serwist/turbopack Migration Summary

**Migration from @serwist/next (Webpack-only, silent no-op under Next 16 Turbopack) to @serwist/turbopack 9.5.7 complete locally (Gates 1-3b green); BLOCKED at Gate 4 by pre-existing Vercel CLI deploy access issue ("Git author kevin@tale-forge.app must have access to the team Tale Forge on Vercel") — not caused by this migration.**

## Performance

- **Duration:** ~20 min (execution reached Gate 4 block)
- **Started:** 2026-04-24T19:33:00Z
- **Halted at:** 2026-04-24T19:53:00Z
- **Tasks:** 1/1 local steps (Steps 1-9 done, Step 10 Vercel deploy blocked by environment)
- **Files modified:** 7 (+ auto-regenerated `next-env.d.ts`)

## Accomplishments (Local)

- **Dependency swap clean:** `@serwist/next` removed, `@serwist/turbopack@9.5.7` added, `esbuild@^0.25.0` added to devDependencies. `pnpm --filter @kos/dashboard install` clean (25.8s, no new peer warnings beyond the pre-existing zod/@eslint/js ones).
- **next.config.ts rewrite:** Bare `withSerwist(config)` wrapper from `@serwist/turbopack`; Sentry(OUTER) → Serwist(INNER) preserved; `swDest`/`cacheOnNavigation`/`reloadOnOnline`/`disable` options migrated out (see Route Handler + Provider).
- **Route Handler created:** `apps/dashboard/src/app/serwist/[path]/route.ts` exports `{ dynamic, dynamicParams, revalidate, generateStaticParams, GET }` from `createSerwistRoute({ swSrc: 'src/app/sw.ts', useNativeEsbuild: true })`. Next build confirmed SSG of `/serwist/sw.js` + `/serwist/sw.js.map` (see Gate 3 build output).
- **Client provider created:** `apps/dashboard/src/components/pwa/serwist-provider.tsx` wraps `SerwistProvider` from `@serwist/turbopack/react` with `swUrl='/serwist/sw.js'`, `disable=NODE_ENV==='development'`, `register`, `cacheOnNavigation`, `reloadOnOnline`.
- **Layout wired:** `<KosSerwistProvider>{children}</KosSerwistProvider>` mounted in `<body>` (Analytics/SpeedInsights kept outside).
- **sw.ts import fixed:** `@serwist/next/worker` → `@serwist/turbopack/worker`. Docstring updated; runtime caching + `only200` plugin + fallbacks unchanged (byte-for-byte stable).
- **Middleware bypass updated:** `pathname === '/sw.js'` → `pathname.startsWith('/serwist/')`; matcher `sw.js` → `serwist/`. Defence-in-depth docstring updated.
- **.gitignore cleanup:** `public/sw.js*` and `public/swe-worker-*` entries removed (nothing is emitted to public/ anymore). Replaced with migration reference comment.
- **Local smoke PASS:** `pnpm start --port 3100` + `curl -sI http://localhost:3100/serwist/sw.js` → `HTTP/1.1 200 OK`, `content-type: application/javascript`, `service-worker-allowed: /`.

## Gate Results

| # | Gate | Status | Notes |
|---|------|--------|-------|
| 1 | `pnpm --filter @kos/dashboard install` | GREEN | Clean install, 25.8s, no new peer warnings |
| 2 | `pnpm --filter @kos/dashboard typecheck` | YELLOW (pre-existing unrelated error) | Only error is `src/app/(app)/entities/page.tsx(114,15)` — verified present at base commit `e0d234b` via stash test. Not caused by migration; outside `files_modified` scope per plan rules. `next build` internal TypeScript phase passes (Gate 3). |
| 3 | `pnpm --filter @kos/dashboard build` | GREEN | Turbopack compile 18.8s, TS 12.8s, SSG generated `● /serwist/[path]` with `/serwist/sw.js` + `/serwist/sw.js.map` prerendered as static content |
| 3b | Local `next start` + curl `/serwist/sw.js` | GREEN | `HTTP/1.1 200 OK`, `content-type: application/javascript`, `service-worker-allowed: /`, `x-nextjs-cache: HIT` |
| 4 | Vercel preview deploy | **RED — BLOCKED (environmental, pre-existing)** | See "Issues Encountered" below |
| 5 | Preview `/serwist/sw.js` 200 + JS | NOT RUN (blocked on Gate 4) | |
| 6 | Preview `/login` 200 | NOT RUN (blocked on Gate 4) | |

## Dependency State (`apps/dashboard/package.json` — Serwist-related)

```json
"dependencies": {
  "@serwist/turbopack": "9.5.7",    // ← NEW (replaced @serwist/next)
  "serwist": "9.5.7"                 // ← unchanged (sw.ts uses Serwist, StaleWhileRevalidate, types)
},
"devDependencies": {
  "esbuild": "^0.25.0"               // ← NEW (@serwist/turbopack peer, useNativeEsbuild: true)
}
```

## Build Output Confirmation

The `next build` tree confirms the Route Handler prerenders both SW artefacts:

```
├ ● /serwist/[path]
│ ├ /serwist/sw.js.map
│ └ /serwist/sw.js
```

`●` = SSG (prerendered as static HTML via `generateStaticParams`), exactly the behaviour the plan `<interfaces>` block describes.

## SW URL Change (grep-target note)

- **Old:** `/sw.js` (emitted to `public/sw.js` at build time by `@serwist/next`)
- **New:** `/serwist/sw.js` (served by the Route Handler at `src/app/serwist/[path]/route.ts`; prerendered as SSG)

Any downstream code grep-ing for `/sw.js` must be updated. Verified call-sites:

- `apps/dashboard/src/middleware.ts` → updated (bypass + matcher)
- `apps/dashboard/src/components/pwa/serwist-provider.tsx` → `SW_URL` constant set
- `apps/dashboard/src/app/sw.ts` → docstring updated
- `apps/dashboard/.gitignore` → stale `public/sw.js*` entries removed

## Issues Encountered

### Gate 4 BLOCKED — pre-existing Vercel CLI deploy access failure

**Environmental, not caused by this migration.** First CLI deploy attempt uploaded successfully but status came back as `ERROR` with build duration `0ms` (no build ever started). Pulled full deployment metadata via Vercel API (v13 deployments endpoint with Bearer auth):

```json
{
  "status": "ERROR",
  "readyStateReason": "Git author kevin@tale-forge.app must have access to the team Tale Forge on Vercel to create deployments.",
  "errorLink": "https://vercel.com/docs/deployments/troubleshoot-project-collaboration#team-configuration",
  "source": "cli",
  "meta": { "gitDirty": "1", "actor": "claude", "githubCommitAuthorEmail": "kevin@tale-forge.app" }
}
```

**Vercel CLI deploy history confirms pre-existing pattern:**

- Failed CLI deploys with 0s duration at: 1h ago, 2h ago (×2), 5h ago, 6h ago (×8), 7h ago
- Successful deploys at 5h/6h ago are all `source: null` (GitHub-integration triggered), `target: production`
- **No CLI-sourced preview deploy has succeeded for at least 7 hours on this EC2**, predating every change in this migration

**Root cause:** Vercel requires the Git author of the HEAD commit to have team access. Our EC2 is authenticated as `jzineldin-2591`, but HEAD commits are authored by `kevin@tale-forge.app`, which is not a member of the "Tale Forge" Vercel team. The CLI deploy path passes author metadata to Vercel which blocks the build before it starts.

**Not remediable by this migration.** Fixing requires either:
1. Adding `kevin@tale-forge.app` as a Vercel team member (admin action — Kevin does this via the Vercel dashboard), OR
2. Pushing the branch to GitHub and letting the GitHub↔Vercel integration auto-deploy (disallowed per plan constraints: "No push unless Kevin asks"; also the plan explicitly requires `vercel deploy` from `apps/dashboard/`), OR
3. Rewriting HEAD commits to a team-member author (would rewrite git history — destructive, not authorised)

I did not attempt remediation (1) or (2) — they exceed this task's scope and the plan's hard constraints. Option (3) is destructive.

### Gate 2 caveat — pre-existing typecheck error

`src/app/(app)/entities/page.tsx(114,15)` has a TypeScript `TS2322` error related to `typedRoutes` strict checking for the `href="/entities?type=person"` union type. **Verified pre-existing at base commit** via a `git stash -u` → typecheck → restore cycle. The error was introduced by quick task `260424-pxt` (commit `522897c`) and is outside this migration's `files_modified` scope. Per deviation Rule-scope-boundary: not fixed in this task. Recommend a follow-up quick task to resolve (likely casting the href via `as Route` or using a `UrlObject`).

`next build`'s internal TypeScript phase did NOT flag it, so it doesn't block the build — only standalone `tsc --noEmit` catches it.

### Auto-regenerated file

`apps/dashboard/next-env.d.ts` was rewritten by Next.js during `build`: `/// <reference path="./.next/types/routes.d.ts" />` → `import "./.next/types/routes.d.ts";`. This is a Next-maintained file, not in `files_modified`, but it's auto-regenerated on every build. Treat as expected drift; not a migration artefact.

## Deviations from Plan

### Scope-boundary decisions (no auto-fixes applied)

**1. Gate 2 pre-existing typecheck error NOT fixed.**
- **Found during:** Gate 2 check.
- **Issue:** `src/app/(app)/entities/page.tsx` has TS2322. Pre-existing at base commit `e0d234b`.
- **Decision:** NOT fixed. Per plan success_criteria line 6 ("No files outside `files_modified` touched") + the executor's scope boundary rule ("Only auto-fix issues DIRECTLY caused by the current task's changes").
- **Files NOT modified:** `src/app/(app)/entities/page.tsx`
- **Documented here for:** follow-up quick task tracking.

### None auto-fixed

Plan was executed exactly as written through Step 9. Step 10 (Vercel deploy) blocked by environment.

---

**Total deviations:** 0 auto-fixed. 1 scope-boundary deferral (pre-existing typecheck error logged for follow-up).
**Impact on plan:** None — migration logic is correct and green on every gate that is achievable locally.

## No Commit Created

Per plan constraint "commit ONLY after all six validation gates pass. If any gate fails, STOP and report to orchestrator." — Gate 4 is red (not the migration's fault, but red nonetheless), so no commit was made. Working tree contains all migration changes intact; orchestrator may either:
- Fix Vercel team access (add `kevin@tale-forge.app` to Tale Forge team), then re-run gates and commit, OR
- Push the branch to GitHub if allowed, let the Vercel↔GitHub auto-integration deploy (succeeded historically within the same session), then verify gates 5+6 against that preview URL and commit.

## Self-Check: PASSED

- `apps/dashboard/src/app/serwist/[path]/route.ts` → FOUND (1025 bytes)
- `apps/dashboard/src/components/pwa/serwist-provider.tsx` → FOUND (1085 bytes)
- `apps/dashboard/next.config.ts` imports from `@serwist/turbopack` → FOUND
- `apps/dashboard/package.json` has `@serwist/turbopack` + `esbuild` → FOUND
- `apps/dashboard/src/app/sw.ts` imports `@serwist/turbopack/worker` → FOUND
- `apps/dashboard/src/middleware.ts` bypass on `/serwist/` + matcher `serwist/` → FOUND
- `apps/dashboard/.gitignore` no longer references `public/sw.js*` → FOUND
- `pnpm build` emits `/serwist/sw.js` + `/serwist/sw.js.map` as SSG → CONFIRMED in build output
- Local `next start` serves `/serwist/sw.js` @ 200 JS → CONFIRMED via curl
- No commit hash (Gate 4 blocked; plan requires all 6 green before commit) → EXPECTED

---

*Quick task: 260424-r6s*
*Status: BLOCKED at Gate 4 (environmental, pre-existing)*
*Halted: 2026-04-24T19:53:00Z*
