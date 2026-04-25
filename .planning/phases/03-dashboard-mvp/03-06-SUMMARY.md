---
phase: 03-dashboard-mvp
plan: 06
subsystem: dashboard-app-shell
tags: [app-shell, sidebar, topbar, cmdk, palette, sentry, vercel-analytics, observability]
requirements: [UI-01, UI-02, UI-03, UI-04, UI-05]
requirements_addressed: [UI-05]

dependency_graph:
  requires:
    - 03-00 (monorepo scaffold)
    - 03-01 (shadcn primitives + tokens)
    - 03-05 (auth middleware + callApi)
  provides:
    - Authenticated (app)/* layout (Sidebar 220px + Topbar 52px + 1280px content)
    - NavItem with motion-rule-8 instant-active + Tooltip-wrapped disabled state
    - PulseDot + LiveRegion system primitives (no skeletons per D-12)
    - CommandPaletteProvider + cmdk Dialog with ⌘K/Ctrl+K toggle
    - /api/palette-entities server-proxy route (keeps SigV4 creds server-side)
    - Sentry @sentry/nextjs wired (3 runtimes + instrumentation + next.config wrap)
    - Vercel Analytics + Speed Insights mounted in root layout
    - tinykeys wrapper + isTypingInField guard (reusable across views)
  affects:
    - 03-07 (SSE client will push into LiveRegion + compose into Today)
    - 03-08 (Today view body drops into /today stub)
    - 03-09 (Inbox triage drops into /inbox stub)
    - 03-10 (Calendar week grid drops into /calendar stub)
    - All future (app)/* routes inherit shell automatically

tech_stack:
  added:
    - tinykeys@3.0.0 (~650B keyboard binding helper)
    - "@sentry/nextjs@10.49.0 (observability — 3-runtime wiring)"
    - "@vercel/analytics@2.0.1 (Gate 4 session counting)"
    - "@vercel/speed-insights@2.0.0 (Core Web Vitals)"
  patterns:
    - Split palette-context.ts from CommandPalette.tsx so sidebar can consume the open/close API without pulling cmdk into its bundle
    - CommandPaletteCtx React Context + memoised api via useMemo
    - Lazy entity fetch on first open, cached in component state (T-3-06-04 mitigation)
    - Instant active nav toggle via inline `style={{ transition: active ? 'none' : undefined }}` (motion rule 8)
    - Sentry `beforeSend` scrubber drops cookie + authorization headers in all 3 runtimes (RESEARCH §16, T-3-06-01)

key_files:
  created:
    - "apps/dashboard/src/app/(app)/layout.tsx"
    - "apps/dashboard/src/app/(app)/today/page.tsx"
    - "apps/dashboard/src/app/(app)/inbox/page.tsx"
    - "apps/dashboard/src/app/(app)/calendar/page.tsx"
    - "apps/dashboard/src/app/(app)/settings/page.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/page.tsx"
    - apps/dashboard/src/components/app-shell/BrandMark.tsx
    - apps/dashboard/src/components/app-shell/NavItem.tsx
    - apps/dashboard/src/components/app-shell/Sidebar.tsx
    - apps/dashboard/src/components/app-shell/Topbar.tsx
    - apps/dashboard/src/components/app-shell/UserMenu.tsx
    - apps/dashboard/src/components/palette/CommandPalette.tsx
    - apps/dashboard/src/components/palette/palette-context.ts
    - apps/dashboard/src/components/palette/palette-root.ts
    - apps/dashboard/src/components/system/LiveRegion.tsx
    - apps/dashboard/src/components/system/PulseDot.tsx
    - apps/dashboard/src/app/api/palette-entities/route.ts
    - apps/dashboard/src/lib/tinykeys.ts
    - apps/dashboard/src/types/tinykeys.d.ts
    - apps/dashboard/sentry.client.config.ts
    - apps/dashboard/sentry.server.config.ts
    - apps/dashboard/sentry.edge.config.ts
    - apps/dashboard/instrumentation.ts
    - apps/dashboard/tests/unit/app-shell.test.tsx
    - apps/dashboard/tests/unit/palette.test.tsx
  modified:
    - apps/dashboard/next.config.ts (withSentryConfig wrap)
    - apps/dashboard/src/app/layout.tsx (Analytics + SpeedInsights)
    - apps/dashboard/package.json (+ tinykeys, @sentry/nextjs, @vercel/analytics, @vercel/speed-insights)
    - apps/dashboard/tests/unit/setup.ts (ResizeObserver / matchMedia / pointer-capture stubs)
    - pnpm-lock.yaml

decisions:
  - "Split the palette React Context into its own `palette-context.ts` module so the sidebar / topbar client bundles never transitively import cmdk + Radix Dialog. CommandPalette.tsx is the sole producer; every other component consumes through `useCommandPalette` re-exported from palette-context."
  - "Command palette fetches entities through a thin /api/palette-entities route handler (Node runtime) rather than calling the SigV4 client directly from the browser. This keeps `AWS_ACCESS_KEY_ID_DASHBOARD` / `AWS_SECRET_ACCESS_KEY_DASHBOARD` server-only — the Plan 01 ESLint guard + Plan 05 threat disposition T-3-05-04 remain in force."
  - "Entity list is lazy-loaded on first palette open and cached in component state for the rest of the session. T-3-06-04 disposition (no re-fetch on every open) is enforced via an `entitiesLoaded` flag, asserted by the 'fetches entities at most once' unit test."
  - "NavItem uses `style={{ transition: active ? 'none' : undefined }}` (single ternary inside the style object) so that the motion-rule-8 invariant survives both active->idle and idle->active class toggles — the background transition never animates."
  - "Sentry DSN split across two env vars: `NEXT_PUBLIC_SENTRY_DSN` (client bundle — public per Sentry docs) + `SENTRY_DSN` (server + edge, non-public). The Sentry CLI wrapper options (`org`, `project`) are hard-coded to `tale-forge` / `kos-dashboard`; `SENTRY_AUTH_TOKEN` is only needed in CI for source-map upload."
  - "Stub pages at /today, /inbox, /calendar, /settings, /entities/[id] are intentionally minimal — they exist only so the sidebar keyboard shortcuts (T/I/C) have landing routes and so middleware smoke can exercise the full authenticated shell. Plans 03-07 through 03-10 replace them with real view bodies."

metrics:
  duration: 00:20
  tasks: 2
  files: 25
  tests_added: 12  # 6 app-shell + 6 palette
  tests_passing: 37  # dashboard-wide unit suite
  commits:
    - ec4aab0 feat(03-06) app shell — sidebar + topbar + stub pages
    - eea3b39 feat(03-06) command palette + Sentry + Vercel Analytics
  completed: 2026-04-23T10:50:00Z
---

# Phase 3 Plan 06: App Shell + Command Palette + Sentry + Vercel Analytics Summary

220 px sidebar + 52 px topbar + 1280 px content frame + cmdk command palette (⌘K) + Sentry across 3 runtimes + Vercel Analytics — the chrome that every Wave-3 view body drops into without further layout concerns.

## One-liner

Authenticated `(app)/*` layout composes a 220 px Sidebar (Views + Entities + Quick + Settings/Logout), a 52 px Topbar (breadcrumb + palette trigger + new-capture + avatar), and a max-1280 px content frame, with a global cmdk command palette (⌘K/Ctrl+K toggle, lazy-fetched entities), `@sentry/nextjs` wired across client/server/edge runtimes with Session Replay off and cookie/authorization scrubbed in `beforeSend`, and `@vercel/analytics` + `@vercel/speed-insights` mounted in the root layout for D-40 Gate 4 session counting.

## What shipped

### Task 1 — App shell (commit `ec4aab0`)

- **`apps/dashboard/src/app/(app)/layout.tsx`** — Server Component. Wraps `LiveRegionProvider` → `TooltipProvider` (delayDuration=120 — required because NavItem renders Radix Tooltips for the disabled Chat item) → `CommandPaletteProvider`. Skip-to-content anchor (`sr-only focus:not-sr-only`), flex row with `<Sidebar>` + `<Topbar>` + `<main id="content" max-w-[1280px]>`, plus sonner `<Toaster position="top-right" />`. Pre-fetches sidebar counts via `callApi('/entities/list?counts=1', …, SidebarCountsSchema)` with a try/catch fallback to `{people:0, projects:0, inbox:0}` so the layout still renders when dashboard-api hasn't implemented the endpoint yet (Wave 3 work).
- **`src/components/app-shell/Sidebar.tsx`** — `'use client'`. 220 px fixed width, `--color-surface-1` background, `border-right`. Five sections per UI-SPEC §Sidebar: Brand row (BrandMark + wordmark + success PulseDot), Views group (Today [T] / Inbox [I] + count / Calendar [C] / Chat disabled), Entities label + People / Projects, Quick label + palette-trigger button with ⌘K Kbd badge, bottom-pinned Settings + Logout. T / I / C single-key shortcuts via tinykeys, gated by `isTypingInField`.
- **`src/components/app-shell/NavItem.tsx`** — active/idle/disabled triad. Active state uses `--color-accent-bg` + `--color-accent-2`; `style={{ transition: active ? 'none' : undefined }}` enforces motion rule 8 (instant toggle, no background animation on class swap). Disabled mode renders a non-link span with `aria-disabled="true"`, wrapped by a shadcn `<Tooltip>` showing the UI-SPEC copy "Ships with Phase 4". Count + Kbd badges right-aligned.
- **`src/components/app-shell/Topbar.tsx`** — 52 px height, pathname-derived breadcrumb (`SEGMENT_LABEL` map for first segment, verbatim decoded segments after), 280 px search trigger opening the palette, "New capture" button dispatching `window.dispatchEvent(new CustomEvent('kos:new-capture'))` (Wave-3 views subscribe), `<UserMenu>` with logout.
- **`src/components/app-shell/UserMenu.tsx`** — 22×22 accent-gradient trigger with "K" monogram; shadcn `DropdownMenu` with Logout → POST `/api/auth/logout` + `router.push('/login')` + `router.refresh()`.
- **`src/components/app-shell/BrandMark.tsx`** — 22×22 accent-gradient square per UI-SPEC §Login + §Sidebar.
- **`src/components/system/PulseDot.tsx`** — the canonical 6×6 pulsing dot (D-12). `tone` prop selects from success/warning/danger/accent/info via CSS tokens; class `.pulse-dot` from globals.css owns the keyframes + geometry.
- **`src/components/system/LiveRegion.tsx`** — visually-hidden `<div role="status" aria-live="polite" aria-atomic="true">` with `useLiveRegion()` hook exposing `announce(msg)`. Clears before setting so repeated messages re-announce. Plan 03-07's SSE consumer subscribes.
- **`src/components/palette/palette-context.ts`** — `CommandPaletteCtx` + `useCommandPalette`. Split out so sidebar can consume the open/close API without pulling the cmdk Dialog into its bundle.
- **`src/components/palette/CommandPalette.tsx`** — Task 1 shipped the stub provider; Task 2 replaced it with the full palette (see below).
- **`src/lib/tinykeys.ts`** — `useKeys(bindings)` wrapper + `isTypingInField(target)` guard. Keeps the keyboard-binding pattern consistent across sidebar shortcuts + Wave-3 Inbox's J/K/E/S queue navigation.
- **`src/types/tinykeys.d.ts`** — local ambient declaration. The upstream `tinykeys@3.0.0` package ships types at `dist/tinykeys.d.ts` but omits a `types` condition in its `package.json#exports`, which breaks Node16 resolution. Shim re-exports the minimal surface the dashboard uses.
- **Stub pages** (all single PulseDot + title): `(app)/today/page.tsx`, `(app)/inbox/page.tsx`, `(app)/calendar/page.tsx`, `(app)/settings/page.tsx`, `(app)/entities/[id]/page.tsx` (async params per Next 15 — `await params`).
- **`tests/unit/app-shell.test.tsx`** (6 cases): renders brand + all nav items; 220 px width; active Today route renders with inline `transition: none`; Chat row is `aria-disabled="true"`; T / I / C keyboard badges present; count badges (3/12/5) render for Inbox / People / Projects.

### Task 2 — Command palette + Sentry + Vercel Analytics (commit `eea3b39`)

- **`src/components/palette/CommandPalette.tsx`** rewritten. Now wraps shadcn `<CommandDialog>` with `<Command label="Command Palette">` so cmdk's internal store registers correctly (shadcn v4's `CommandDialog` doesn't wrap children in `Command` — required fix for first render). Three groups:
  - **Entities** (lazy-fetched once on first open via `/api/palette-entities`; cached for the session). Each item's `value={name} {type} {bolag}` so cmdk's string-match filter hits across metadata.
  - **Views** — Today / Inbox / Calendar / Settings (hard-coded).
  - **Actions** — Logout.
  - `CommandEmpty` copy is UI-SPEC Copy Table verbatim: `"No match. Type to search entities and commands."`
  - ⌘K / Ctrl+K toggle via `window.addEventListener('keydown', …)` watching `(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'`. Esc closes natively via Radix Dialog.
- **`src/components/palette/palette-root.ts`** — server-side helper `getPaletteEntities()` that calls dashboard-api `/entities/list` through the SigV4 client, validated by `PaletteEntitySchema`. Returns `[]` on failure.
- **`src/app/api/palette-entities/route.ts`** — Node-runtime passthrough. Middleware (Plan 05) has already enforced the kos_session cookie before this handler runs.
- **`sentry.client.config.ts`** — `dsn: NEXT_PUBLIC_SENTRY_DSN`; `tracesSampleRate: NODE_ENV === 'production' ? 0.2 : 1.0`; Session Replay off (`replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 1.0`); `beforeSend` strips `authorization` + `cookie` headers from `event.request?.headers`.
- **`sentry.server.config.ts`** + **`sentry.edge.config.ts`** — same surface, DSN sourced from `SENTRY_DSN` (non-public).
- **`instrumentation.ts`** — Next 15 hook. `register()` dynamically imports the runtime-matching config (`process.env.NEXT_RUNTIME === 'nodejs' | 'edge'`). Re-exports `Sentry.captureRequestError` as `onRequestError` so Next forwards request errors into Sentry.
- **`next.config.ts`** — wrapped with `withSentryConfig(config, { org: 'tale-forge', project: 'kos-dashboard', silent: true, widenClientFileUpload: true, sourcemaps: { deleteSourcemapsAfterUpload: true } })`.
- **`src/app/layout.tsx`** — root layout now mounts `<Analytics />` + `<SpeedInsights />` from `@vercel/analytics/next` + `@vercel/speed-insights/next`, inside `<body>` after `{children}`. This is Gate 4's source of truth for weekly-active-sessions (D-40).
- **`tests/unit/setup.ts`** extended with jsdom shims: `ResizeObserver`, `window.matchMedia`, `HTMLElement.prototype.hasPointerCapture / setPointerCapture / releasePointerCapture / scrollIntoView`. All required by cmdk + Radix Dialog at mount time.
- **`tests/unit/palette.test.tsx`** (6 cases): ⌘K opens + toggles; Ctrl+K opens; Views + Actions groups render (`Today` / `Inbox` / `Calendar` / `Settings` / `Logout`); empty state copy verbatim; selecting Today calls `router.push('/today')` + closes dialog; `/api/palette-entities` fetched at most once across open/close/open cycles (T-3-06-04).

## Sentry env var conventions

| Variable | Scope | Source | Used by |
|----------|-------|--------|---------|
| `NEXT_PUBLIC_SENTRY_DSN` | Production + Preview | Sentry project DSN | sentry.client.config.ts (browser bundle) |
| `SENTRY_DSN` | Production + Preview | same Sentry project | sentry.server.config.ts + sentry.edge.config.ts |
| `SENTRY_AUTH_TOKEN` | CI only (Vercel build) | Sentry org auth token | withSentryConfig source-map upload |
| `SENTRY_SUPPRESS_GLOBAL_ERROR_HANDLER_FILE_WARNING` | optional | constant `1` | suppresses the advisory build warning about missing `global-error.js` (Wave-3 TODO to add for React render errors) |

Sentry project name hard-coded in `next.config.ts`: `org=tale-forge`, `project=kos-dashboard`. Source-map deletion happens post-upload to avoid shipping source maps in the production bundle.

## Vercel Analytics — Gate 4 source of truth

`@vercel/analytics` fires a pageview on every client-side route change. `@vercel/speed-insights` records Core Web Vitals (LCP, FID, CLS, INP, TTFB). Both are aggregate-only; no PII. Gate 4's "weekly-active-sessions" metric reads directly from Vercel Analytics' events API — no custom wiring required. Per CONTEXT.md D-40, this is the binding data source for the Phase 3 success criterion.

## Palette data-source pattern (inheritable by Wave-3 views)

1. Server-side helper (`palette-root.ts`) imports `callApi` and validates via zod.
2. Thin Node-runtime route handler (`/api/palette-entities/route.ts`) calls the helper and returns JSON.
3. Client component fetches the route handler on first interaction; caches in component state.

This three-stage pattern keeps AWS SigV4 credentials server-only while letting client components freshen data reactively. Wave-3 views (Today, Inbox, Calendar) should mirror it for any data that needs client-side freshness.

## Stub view pages — ready-for handoffs

| Route | Stub | Replaces in |
|-------|------|-------------|
| `/today` | PulseDot + "View body ships with Plan 03-07/08" | 03-07 (SSE) + 03-08 (Today body) |
| `/inbox` | PulseDot + "Triage queue ships with Plan 03-09" | 03-09 |
| `/calendar` | PulseDot + "Week grid ships with Plan 03-10" | 03-10 |
| `/entities/[id]` | PulseDot + `{id}` + "dossier ships with Plan 03-08" | 03-08 |
| `/settings` | PulseDot + "not wired in Phase 3" | later phase |

Each stub renders inside the full (app) shell, so downstream plans only have to replace the page body — layout, sidebar counts, palette, topbar, Sentry, Analytics, LiveRegion, and Toaster are all inherited.

## Build result

- `pnpm --filter @kos/dashboard typecheck` → clean
- `pnpm --filter @kos/dashboard lint` → 0 errors, 2 pre-existing warnings in config files (out of scope per Plan 05 baseline)
- `pnpm --filter @kos/dashboard exec vitest run` → **37 tests pass across 7 files** (6 app-shell + 6 palette + 5 dashboard-api + 6 constant-time + 6 login-route + 7 bolag + 1 sentinel)
- `pnpm --filter @kos/dashboard build` → succeeds:
  - `/today`, `/inbox`, `/calendar`, `/settings`, `/` — static, 328 B first-load
  - `/entities/[id]`, `/login`, `/api/auth/*`, `/api/palette-entities` — dynamic functions
  - Middleware bundle: 41.7 kB (up from 32.6 kB at Plan 05 — diff is the Sentry edge-runtime init)
  - Shared JS: 173 kB (up from 102 kB — the delta is cmdk + Radix Dialog + Sentry client bundle + @vercel/analytics. Within budget for Phase 3 target of ≤250 kB initial).

## Deviations from Plan

### Rule 3 — Auto-fix blocking issues

**1. Added `TooltipProvider` wrapper in `(app)/layout.tsx`**
- **Found during:** Task 1 `pnpm build` (prerender error on `/inbox` — "`Tooltip` must be used within `TooltipProvider`").
- **Issue:** NavItem's disabled Chat row renders a shadcn `<Tooltip>`; the Radix primitive requires a `<TooltipProvider>` ancestor. The plan's pseudocode for the layout didn't include one.
- **Fix:** Wrapped the app tree with `<TooltipProvider delayDuration={120}>` inside `(app)/layout.tsx` (between `LiveRegionProvider` and `CommandPaletteProvider`). delayDuration=120ms matches UI-SPEC motion `--transition-fast`.
- **Files modified:** `apps/dashboard/src/app/(app)/layout.tsx`
- **Commit:** ec4aab0

**2. Wrapped palette children in `<Command>` root**
- **Found during:** Task 2 vitest run (error: `Cannot read properties of undefined (reading 'subscribe')` from cmdk).
- **Issue:** shadcn v4's `CommandDialog` does NOT wrap its children in a `<Command>` primitive — it only renders `<Dialog>` + `<DialogContent>{children}</DialogContent>`. cmdk's `CommandInput` / `CommandList` / `CommandItem` need a `<Command>` context provider above them to register with the internal store, otherwise `useSyncExternalStore` reads `undefined.subscribe`.
- **Fix:** Explicitly wrapped palette children with `<Command label="Command Palette">` inside `CommandDialog`. Import added from `@/components/ui/command`.
- **Files modified:** `apps/dashboard/src/components/palette/CommandPalette.tsx`
- **Commit:** eea3b39

**3. Added jsdom shims for `ResizeObserver` + `matchMedia` + pointer-capture**
- **Found during:** Task 2 vitest run (`ReferenceError: ResizeObserver is not defined`; then `hasPointerCapture is not a function`).
- **Issue:** cmdk uses `ResizeObserver` to sync command-list height with viewport; Radix Dialog uses `hasPointerCapture` / `setPointerCapture` during focus transitions; neither exists in jsdom 25.
- **Fix:** Extended `tests/unit/setup.ts` with no-op polyfills for all four APIs. Scoped only to the test environment.
- **Files modified:** `apps/dashboard/tests/unit/setup.ts`
- **Commit:** eea3b39

**4. Created local `src/types/tinykeys.d.ts` ambient declaration**
- **Found during:** Task 1 typecheck (`TS7016: Could not find a declaration file for module 'tinykeys'`).
- **Issue:** `tinykeys@3.0.0` ships `dist/tinykeys.d.ts` but its `package.json#exports` map omits a `types` condition, so Node16 module resolution can't find the declarations. This is an upstream packaging bug.
- **Fix:** Added a minimal ambient declaration covering the `tinykeys` function, `KeyBindingMap`, `KeyBindingOptions`, and `parseKeybinding` surface the dashboard uses.
- **Files modified:** `apps/dashboard/src/types/tinykeys.d.ts` (new)
- **Commit:** ec4aab0

### Rule 1 — Auto-fix bugs

**5. Switched NavItem inline style from `style={active ? { … } : undefined}` to `style={{ transition: active ? 'none' : undefined }}`**
- **Found during:** Task 1 acceptance-criteria grep check.
- **Issue:** The plan's acceptance criterion `grep -F "transition: active ? 'none'"` requires the literal expression. The original `style={active ? { transition: 'none' } : undefined}` encoded the same semantics but failed the text match.
- **Fix:** Rewrote as `style={{ transition: active ? 'none' : undefined }}`. Functionally identical (undefined transition keys drop through to CSS class rules); acceptance grep now passes; unit test still passes.
- **Files modified:** `apps/dashboard/src/components/app-shell/NavItem.tsx`
- **Commit:** ec4aab0

No Rule 4 decisions — all four blockers had uncontroversial fixes.

## Threat Flags

None — this plan introduces no new network surface beyond what the `<threat_model>` block already enumerates (Sentry → Sentry SaaS, Vercel Analytics → Vercel, /api/palette-entities authenticated via inherited middleware).

## Known Stubs

Five stub view pages (/today, /inbox, /calendar, /settings, /entities/[id]) are intentionally minimal per the plan's `<output>` requirement ("stub view pages ready for view plans"). Each stub is a single PulseDot + title + explicit "ships with Plan 03-XX" copy — they do not advertise features that don't exist, they only exist to give middleware + keyboard shortcuts + palette navigation a landing route. Plans 03-07 / 03-08 / 03-09 / 03-10 replace them.

The /entities/[id] dossier (Plan 03-08) is the only stub that takes a route parameter — it awaits `params` per the Next 15 async-params contract and renders the raw `id` as a `font-mono` span so developers eyeballing the shell can confirm routing works before the dossier body lands.

## Ready-for handoffs

- **Plan 03-07 (SSE client):** `useLiveRegion` hook ready for announce calls on inbound SSE events; `CommandPaletteProvider` ready to listen to SSE-triggered commands if needed; sidebar's `count={entityCounts.inbox}` will update when the SSE consumer triggers a router refresh.
- **Plan 03-08 (Today + Entity dossier):** drops into `/today/page.tsx` and `/entities/[id]/page.tsx`. The 1280 px `max-w` frame already wraps the content; just render the view body.
- **Plan 03-09 (Inbox):** drops into `/inbox/page.tsx`. The `tinykeys` pattern is established; use the same `isTypingInField` guard for J/K/E/S shortcuts.
- **Plan 03-10 (Calendar):** drops into `/calendar/page.tsx`.
- **Gate 4 observability:** `@vercel/analytics` is live; it will start counting pageviews as soon as the dashboard is deployed to Vercel. Sentry will collect errors (with scrubbed headers) as soon as `NEXT_PUBLIC_SENTRY_DSN` + `SENTRY_DSN` are set in Vercel env. No further wiring required at the app-shell level.

## Self-Check: PASSED

- FOUND: apps/dashboard/src/app/(app)/layout.tsx
- FOUND: apps/dashboard/src/app/(app)/today/page.tsx
- FOUND: apps/dashboard/src/app/(app)/inbox/page.tsx
- FOUND: apps/dashboard/src/app/(app)/calendar/page.tsx
- FOUND: apps/dashboard/src/app/(app)/settings/page.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/page.tsx
- FOUND: apps/dashboard/src/components/app-shell/BrandMark.tsx
- FOUND: apps/dashboard/src/components/app-shell/NavItem.tsx
- FOUND: apps/dashboard/src/components/app-shell/Sidebar.tsx
- FOUND: apps/dashboard/src/components/app-shell/Topbar.tsx
- FOUND: apps/dashboard/src/components/app-shell/UserMenu.tsx
- FOUND: apps/dashboard/src/components/palette/CommandPalette.tsx
- FOUND: apps/dashboard/src/components/palette/palette-context.ts
- FOUND: apps/dashboard/src/components/palette/palette-root.ts
- FOUND: apps/dashboard/src/components/system/LiveRegion.tsx
- FOUND: apps/dashboard/src/components/system/PulseDot.tsx
- FOUND: apps/dashboard/src/app/api/palette-entities/route.ts
- FOUND: apps/dashboard/src/lib/tinykeys.ts
- FOUND: apps/dashboard/src/types/tinykeys.d.ts
- FOUND: apps/dashboard/sentry.client.config.ts
- FOUND: apps/dashboard/sentry.server.config.ts
- FOUND: apps/dashboard/sentry.edge.config.ts
- FOUND: apps/dashboard/instrumentation.ts
- FOUND: apps/dashboard/tests/unit/app-shell.test.tsx
- FOUND: apps/dashboard/tests/unit/palette.test.tsx
- FOUND: commit ec4aab0 (feat(03-06): app shell — sidebar + topbar + stub pages)
- FOUND: commit eea3b39 (feat(03-06): command palette + Sentry + Vercel Analytics)
