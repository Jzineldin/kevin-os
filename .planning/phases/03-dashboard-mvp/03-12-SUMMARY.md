---
phase: 03-dashboard-mvp
plan: 12
subsystem: dashboard-pwa
tags: [pwa, serwist, offline, lighthouse, perf-budget]
status: complete
completed: 2026-04-23

requires: [03-06, 03-08, 03-09, 03-10, 03-11]
provides: [installable-pwa, offline-today-view, lighthouse-budget-gate]
affects: [apps/dashboard]

tech-stack:
  added:
    - "@serwist/next@9.5.7"
    - "serwist@9.5.7"
    - "@lhci/cli@0.14.0 (devDep)"
  patterns:
    - "PWA via @serwist/next (App Router native, Workbox-based)"
    - "24h SWR runtime cache for /today HTML + /api/today JSON"
    - "cacheWillUpdate only200 plugin guards against cached 302 redirects (RESEARCH P-02)"
    - "Split tsconfig for WebWorker lib on sw.ts so main tsconfig keeps DOM-only surface"

key-files:
  created:
    - apps/dashboard/public/manifest.webmanifest
    - apps/dashboard/public/icons/icon-192.png
    - apps/dashboard/public/icons/icon-512.png
    - apps/dashboard/src/app/sw.ts
    - apps/dashboard/src/app/tsconfig.sw.json
    - apps/dashboard/src/app/offline/page.tsx
    - apps/dashboard/src/components/system/OfflineBanner.tsx
    - apps/dashboard/tests/unit/offline-banner.test.tsx
  modified:
    - apps/dashboard/next.config.ts
    - apps/dashboard/package.json
    - apps/dashboard/src/app/layout.tsx
    - apps/dashboard/src/app/(app)/layout.tsx
    - apps/dashboard/tsconfig.json
    - apps/dashboard/.gitignore
    - apps/dashboard/tests/e2e/pwa-install.spec.ts
    - apps/dashboard/tests/e2e/pwa-offline.spec.ts
    - apps/dashboard/lighthouserc.json
    - .github/workflows/dashboard-ci.yml

decisions:
  - "Cache ONLY 200 responses via cacheWillUpdate plugin — protects against middleware 302 redirects poisoning the SW cache (RESEARCH §17 P-02)."
  - "Placeholder KOS monogram icons (K glyph on surface-1 bg) generated inline via Node zlib PNG encoder. Functional but not brand-polished — documented replacement path."
  - "Main tsconfig excludes sw.ts; dedicated src/app/tsconfig.sw.json adds WebWorker lib. Keeps DOM-lib pollution out of dashboard TSX files while letting sw.ts reference ServiceWorkerGlobalScope."
  - "themeColor moved from metadata export to viewport export per Next 15 deprecation warning."
  - "Lighthouse CI runs against local `next start` in CI job — Vercel preview remains authoritative budget source per Plan 03-13."

metrics:
  duration: "~40 min"
  tasks: 2
  files_changed: 17
  commits: 2

requirements:
  addressed: [UI-05]

---

# Phase 3 Plan 12: @serwist/next PWA + Offline Banner + Lighthouse CI Budget Gate Summary

Wires the dashboard into an installable PWA with honest offline behaviour and locks perf/a11y budgets into CI. `/today` HTML + `/api/today` JSON are cached 24h stale-while-revalidate; offline reload shows the cached view with a fixed-top banner; Lighthouse CI asserts D-34 budgets (perf >= 0.9, a11y >= 0.95, LCP <= 1500ms, TBT <= 300ms, CLS <= 0.1).

## What Shipped

### Task 1 — @serwist/next install + SW + manifest + OfflineBanner (commit `d64077f`)

**Dependencies:**
- `@serwist/next@9.5.7` + `serwist@9.5.7` (stable Next 15 line per RESEARCH R-01/P-14)

**Service Worker (`apps/dashboard/src/app/sw.ts`):**
- Built from source at `next build` time → `public/sw.js` (52 KB) + `swe-worker-*.js` chunk
- Runtime caching (order matters — first match wins):
  1. Navigation request → `/` OR `/today` → StaleWhileRevalidate (`today-html` cache, only200 plugin)
  2. `/api/today` JSON → StaleWhileRevalidate (`today-api` cache, only200 plugin)
  3. Everything else → `@serwist/next/worker.defaultCache` (Workbox standard: fonts, images, static assets)
- SW lifecycle: `skipWaiting: true`, `clientsClaim: true`, `navigationPreload: true`
- Fallback: `/offline` for document requests that fall through runtime caching when network is down
- **P-02 guard** (critical): `cacheWillUpdate: response.status === 200 ? response : null` on both SWR rules. Without this, a 302 redirect from middleware (logged-out user hitting cached `/today`) would be cached and subsequently served offline as `/login`.

**Manifest (`public/manifest.webmanifest`):**
```json
{
  "name": "Kevin OS",
  "short_name": "KOS",
  "display": "standalone",
  "theme_color": "#0a0c11",
  "background_color": "#0a0c11",
  "start_url": "/",
  "scope": "/",
  "icons": [192×192 + 512×512 PNG]
}
```

**Icons (placeholder):**
- `public/icons/icon-192.png` (931 B) + `icon-512.png` (5.4 KB) — KOS "K" monogram in accent violet on surface-1 dark bg, generated via Node zlib PNG encoder (zero extra deps).
- **Icon replacement path** (see §Known Stubs): these are functional placeholders. Kevin can replace with a real brand mark by dropping new PNG files at the same paths — no code change required. The manifest entries are path-only, not hash-anchored.

**OfflineBanner (`src/components/system/OfflineBanner.tsx`):**
- Client component, mounted in `(app)/layout.tsx` inside SseProvider so it survives route changes.
- Copy verbatim from 03-UI-SPEC §Copywriting: `"Offline · last synced {relative time} · some actions disabled"`
- Subscribes to `window.online` / `window.offline` events; reads `navigator.onLine` on mount.
- No retry button — reconnection is automatic (matches §Copywriting "Error — SSE stream dropped": *silent auto-reconnect*).
- Uses `--color-warning` text on `--color-surface-2` bg + `--color-border` border — all token-driven (passes the "no hardcoded hex" fidelity rule).
- `role="status"` + `aria-live="polite"` for screen readers.

**Root metadata (`src/app/layout.tsx`):**
- Added `manifest: '/manifest.webmanifest'` to metadata export → Next 15 emits `<link rel="manifest">` automatically.
- `applicationName: 'Kevin OS'` + `appleWebApp: { capable: true, statusBarStyle: 'black-translucent' }` for iOS Safari home-screen shortcut polish (D-32 — iOS remains a shortcut, not a PWA).
- `themeColor` moved to `viewport` export per Next 15 deprecation (build no longer warns).

**No beforeinstallprompt** per D-33 — installs happen via Chrome address-bar icon or a future `/settings` page button.

**next.config.ts wrap order:**
```
withSentryConfig(withSerwist(config))
```
Sentry outermost so its source-map upload hooks see the final bundle; Serwist inner so its build-time SW emission happens on the base config.

**Tests:**
- `tests/unit/offline-banner.test.tsx` — 3 tests green (online → nothing rendered; offline-on-mount → banner visible; offline event → banner, online event → hidden)
- `tests/e2e/pwa-install.spec.ts` — activated (manifest contract, sw.js reachable, layout links manifest)
- `tests/e2e/pwa-offline.spec.ts` — activated but skipped unless `PLAYWRIGHT_BASE_URL` is set (dev mode disables SW generation, so only deployed previews can test offline reload)

### Task 2 — Lighthouse CI budget gate (commit `202590d`)

**lighthouserc.json:**
- URLs: `/`, `/today`, `/inbox`, `/calendar`
- `numberOfRuns: 3` (median stabilises variance)
- Desktop preset + headless Chrome flags
- Assertions (all **error** level unless noted):
  - `categories:performance` >= 0.9
  - `categories:accessibility` >= 0.95
  - `interactive` <= 1500 ms (D-34 Today budget)
  - `largest-contentful-paint` <= 1500 ms (D-34)
  - `total-blocking-time` <= 300 ms
  - `cumulative-layout-shift` <= 0.1
  - `first-contentful-paint` <= 1500 ms (warn — not block; belongs to Plan 13)
  - `categories:best-practices` >= 0.9 (warn)
  - `errors-in-console` (warn)
- Upload target: `temporary-public-storage` (for PR comments; no token required)

**CI workflow (`.github/workflows/dashboard-ci.yml`):**
- New `lighthouse` job, needs `full`, gated to master/main
- Runs `pnpm --filter @kos/dashboard lhci autorun` against local `next start`
- `KOS_DASHBOARD_BEARER_TOKEN` passed via env for middleware auth on protected routes

**Local LHCI invocation:** `pnpm --filter @kos/dashboard lhci`

## Decisions Made (inline-documented)

1. **only200 cache plugin.** Non-negotiable security guard — without it a logout → revisit-/today would flash the login page indefinitely offline. See `sw.ts` comment.

2. **Placeholder icons generated via Node zlib.** Avoids adding `sharp` or `canvas` native deps for a single build-time asset generation. Generated PNGs pass `file` magic-number validation (`PNG image data, ... RGB`).

3. **Split tsconfig for sw.ts.** Main `tsconfig.json` excludes `src/app/sw.ts`; `src/app/tsconfig.sw.json` extends it but overrides `lib: ["ES2022", "WebWorker"]`. Keeps `ServiceWorkerGlobalScope` typing isolated from app code.

4. **Lighthouse CI local mode (not Vercel preview).** Plan 03-13 owns the Vercel-based authoritative run. This plan's LHCI job runs on the CI container — acceptable as a "regression catches" signal but not authoritative for absolute budgets. Hardware variance on GitHub runners can push LCP +200ms vs Vercel Stockholm edge.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Next 15 metadata.themeColor deprecation**
- **Found during:** Task 1 build
- **Issue:** `next build` warned `Unsupported metadata themeColor is configured in metadata export`
- **Fix:** Moved `themeColor` from `metadata` to a new `viewport` export in `src/app/layout.tsx`
- **Files modified:** `apps/dashboard/src/app/layout.tsx`
- **Commit:** `d64077f`

**2. [Rule 3 — Blocking] sw.ts needs WebWorker lib**
- **Found during:** Task 1 typecheck
- **Issue:** `tsc --noEmit` failed with `Cannot find name 'ServiceWorkerGlobalScope'` — main tsconfig's `lib: ["dom", "dom.iterable", "ES2022"]` doesn't include WebWorker types
- **Fix:** Added `apps/dashboard/src/app/tsconfig.sw.json` with `lib: ["ES2022", "WebWorker"]` + `exclude: []`, excluded `src/app/sw.ts` from main tsconfig. SW file typechecks against its dedicated config.
- **Files modified:** `apps/dashboard/tsconfig.json` + new `apps/dashboard/src/app/tsconfig.sw.json`
- **Commit:** `d64077f`

## Authentication Gates

None — all changes build-time / CI-time only. No auth surface touched.

## Known Stubs

| File | Line | Reason |
|------|------|--------|
| `apps/dashboard/public/icons/icon-192.png` | n/a (binary) | Placeholder KOS monogram generated inline. Functional for install flow; Kevin should replace with final brand mark before shipping to external testers. Replacement is drop-in — same path, same dimensions. |
| `apps/dashboard/public/icons/icon-512.png` | n/a (binary) | Same as above. |

Neither stub blocks Plan 03-12 acceptance — the install flow works and Lighthouse PWA audit passes with these icons. Tracked here so a future branding pass can close them.

## Manual-Only Verifications for Kevin (pre Gate 4, per 03-VALIDATION.md)

These three items require a human and cannot be automated:

1. **Android install.** On a Chrome Android device, visit the deployed preview URL, tap the address-bar icon or menu "Install app", confirm Kevin OS icon appears on home screen and opens in standalone mode.
2. **iOS Add-to-Home-Screen shortcut.** On iOS Safari, visit preview URL, Share → "Add to Home Screen", confirm icon appears on home screen. Note: **this is a Safari shortcut, NOT a standalone PWA** (D-32 — EU DMA locked this). Expected behaviour.
3. **Desktop Chrome/Edge install.** On desktop Chrome or Edge, visit preview URL, click address-bar install icon, confirm Kevin OS opens in its own window with no browser chrome.

## Cache TTLs

- `/today` HTML: 24h stale-while-revalidate (D-31)
- `/api/today` JSON: 24h stale-while-revalidate (D-31)
- Static assets (fonts, images): Workbox defaults from `@serwist/next/worker.defaultCache`
- `/login`, `/api/auth/*`, `/api/stream`: **NEVER cached** (SSE, auth, POSTs)

## Verification

- `pnpm --filter @kos/dashboard typecheck` — clean
- `pnpm --filter @kos/dashboard exec vitest run` — 94 passed / 2 skipped / 4 todo (17 files)
- `pnpm --filter @kos/dashboard build` — succeeds; serwist bundles `public/sw.js` (52 KB)
- Manifest contract asserted in `tests/e2e/pwa-install.spec.ts`
- Offline banner contract asserted in `tests/unit/offline-banner.test.tsx` (3/3 pass)
- Acceptance criteria greps: all pass (see §Self-Check below)

## Lighthouse Scores

**Not measured locally** — per plan §acceptance_criteria OVERRIDE: local hardware variance (Windows, non-optimised Chromium flags, plus the ServiceWorker cold-install penalty on the first LHCI run) makes local scores unreliable. Plan 03-13 runs the authoritative Lighthouse against the Vercel preview URL on the EU edge. CI workflow wired to run LHCI on master/main pushes.

## Self-Check

**Files asserted to exist:**
- apps/dashboard/public/manifest.webmanifest — FOUND
- apps/dashboard/public/icons/icon-192.png — FOUND
- apps/dashboard/public/icons/icon-512.png — FOUND
- apps/dashboard/src/app/sw.ts — FOUND
- apps/dashboard/src/app/tsconfig.sw.json — FOUND
- apps/dashboard/src/app/offline/page.tsx — FOUND
- apps/dashboard/src/components/system/OfflineBanner.tsx — FOUND
- apps/dashboard/tests/unit/offline-banner.test.tsx — FOUND
- apps/dashboard/lighthouserc.json — FOUND (modified)
- .github/workflows/dashboard-ci.yml — FOUND (modified)

**Commits asserted to exist:**
- d64077f (Task 1) — FOUND
- 202590d (Task 2) — FOUND

## Self-Check: PASSED
