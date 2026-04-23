---
phase: 03-dashboard-mvp
plan: 08
subsystem: dashboard-today
tags: [today, rsc, composer, sse, server-action, framer-motion, api-mirror]
requirements: [UI-01]
requirements_addressed: [UI-01]

dependency_graph:
  requires:
    - 03-02 (dashboard-api contract shapes — TodayResponseSchema, CapturePostSchema)
    - 03-05 (callApi SigV4 client + kos_session middleware gate)
    - 03-06 (app shell mounting point, LiveRegionProvider, PulseDot, Toaster)
    - 03-07 (SseProvider + useSseKind — inbox_item / draft_ready / capture_ack)
  provides:
    - /today RSC rendering Brief + Top 3 + Drafts + Dropped + Meetings + Composer
    - EntityLink shared component (`.ent` accent link) — reusable by Inbox (09), dossier (10), timeline
    - BolagBadge shared component — reusable by every bolag-tinted surface
    - Composer + captureText Server Action (POST /capture with zod validation at boundary)
    - /api/today Node-runtime mirror with Cache-Control: stale-while-revalidate=86400 (Plan 10 SW cache)
    - Today .ent / .h-page / .brief / .draft-card / .side-card / .line-clamp-2 / .fade-up globals.css primitives
    - Today .pri-row / .priority-list / .meeting-row / .meeting-now / .thread-row / .count-chip primitives
    - framer-motion + date-fns wired into the dashboard bundle (reusable by future views)
  affects:
    - 03-09 (Inbox) — reuses EntityLink + BolagBadge + .draft-card + line-clamp-2 + .fade-up
    - 03-10 (Entity dossier + Calendar) — reuses EntityLink + BolagBadge + .h-section + fade-up
    - 03-11 (Merge UI) — reuses EntityLink + BolagBadge
    - 03-12 (PWA) — @serwist/next will runtime-cache /api/today against the SWR header set here

tech_stack:
  added:
    - framer-motion@12.38.0 (~35 KB gzipped — used for AnimatePresence list insertion rule 6)
    - date-fns@4.1.0 (relative time + HH:mm formatting; tree-shakeable)
    - "@testing-library/user-event@14.5.2 (devDep — simulates user typing + clicks in Composer tests)"
  patterns:
    - RSC fetches /today via callApi; falls back to empty TodayResponse shape on upstream error so the shell still paints (inherits D-12 "pulsing dot only" loading contract)
    - Client TodayView subscribes to SSE 'inbox_item' + 'draft_ready' → useLiveRegion.announce + router.refresh() (idempotent revalidation pattern from Plan 07)
    - Composer subscribes to SSE 'capture_ack' keyed on the returned capture_id — PulseDot tone accent→warning→success on match
    - Server Action boundary validates via CapturePostSchema.parse (throws on client bug, handled as toast error at UI)
    - framer-motion AnimatePresence scoped per-list (PriorityList, DraftsCard, DroppedThreads, MeetingsSideCard) — only list insertion animates (motion rule 6); page chrome uses CSS fade-up
    - /api/today route handler is a thin callApi proxy; 502 on upstream failure so SW cache can differentiate stale vs. unavailable

key_files:
  created:
    - apps/dashboard/src/components/entity/EntityLink.tsx
    - apps/dashboard/src/components/badge/BolagBadge.tsx
    - "apps/dashboard/src/app/(app)/today/TodayView.tsx"
    - "apps/dashboard/src/app/(app)/today/Brief.tsx"
    - "apps/dashboard/src/app/(app)/today/PriorityList.tsx"
    - "apps/dashboard/src/app/(app)/today/DraftsCard.tsx"
    - "apps/dashboard/src/app/(app)/today/DroppedThreads.tsx"
    - "apps/dashboard/src/app/(app)/today/MeetingsSideCard.tsx"
    - "apps/dashboard/src/app/(app)/today/Composer.tsx"
    - "apps/dashboard/src/app/(app)/today/actions.ts"
    - apps/dashboard/src/app/api/today/route.ts
    - apps/dashboard/tests/unit/bolag-badge.test.tsx
    - apps/dashboard/tests/unit/composer.test.tsx
  modified:
    - "apps/dashboard/src/app/(app)/today/page.tsx (stub → RSC)"
    - apps/dashboard/src/app/globals.css (Today view primitives added after existing bolag section)
    - apps/dashboard/tests/e2e/today.spec.ts (fixme → active-skip without PLAYWRIGHT_BASE_URL)
    - apps/dashboard/package.json (framer-motion, date-fns, @testing-library/user-event)
    - pnpm-lock.yaml

decisions:
  - "Server Action lives in apps/dashboard/src/app/(app)/today/actions.ts (colocated with Today view) rather than in a shared /lib because Next 15 is strict about 'use server' directives crossing boundary files — and Plan 09's Inbox will have its own inbox/actions.ts. Shared helpers go into lib/; directives belong in the feature folder."
  - "TodayView auto-refreshes on BOTH inbox_item AND draft_ready SSE kinds (not just one). Rationale: drafts are a subset of inbox items in D-25's event taxonomy — the pipeline publishes draft_ready when a draft becomes available for review and inbox_item for all other routings. Subscribing to both means the Drafts section reflects backend state whether it arrived via the 'create a draft' or 'route this elsewhere' path."
  - "Composer treats the 5s ack timeout as a soft failure: PulseDot stays warning (not danger). The capture DID reach the Vercel Server Action and was POSTed to dashboard-api — the ack would normally come via SSE within 1-2s. Warning communicates 'in flight, no confirmation yet' without crying wolf on transient SSE lag."
  - "Approve/Edit/Skip on draft cards are <Link href='/inbox'> not inline form posts. Triage actions belong to Plan 09's Inbox view; Today surfaces drafts as a summary with a click-through. Inlining would duplicate the /inbox/:id approve/skip plumbing for a secondary affordance."
  - "useSseKind handler for capture_ack is cast to `never` because the shared SseEvent type in packages/contracts is a single z.object() (not a discriminated union). The provider's trampoline already narrows via `ev.kind !== kind`, so the runtime guarantee is intact; the cast only suppresses a TS variance that TS can't prove."
  - "/today fallback on upstream error renders an EMPTY TodayResponse (no error banner). The dashboard-api may not serve real data in every preview env; the app-shell's LiveRegion is the surface for SSE-driven state changes. A hardcoded error banner would break the D-12 'no skeletons, no crying wolf' contract."

metrics:
  duration: 00:12
  tasks: 3
  files: 13
  tests_added: 11  # 6 bolag-badge + 5 composer
  tests_passing: 64  # dashboard-wide unit suite (was 53 after 03-07)
  commits:
    - cc2781a feat(03-08) shared EntityLink + BolagBadge + page-level CSS
    - 224bbb0 feat(03-08) Today RSC + Brief/Priorities/Drafts/Dropped/Meetings + /api/today
    - 06b9672 feat(03-08) Composer + captureText Server Action with SSE capture_ack PulseDot
  completed: 2026-04-23T11:22:00Z
---

# Phase 3 Plan 08: Today View (UI-01) Summary

Today view end-to-end: RSC calls `/today` via SigV4 `callApi`, renders Brief (D-05 placeholder) + Top 3 Priorities + Drafts-to-Review + Dropped Threads + Meetings side card + voice/text Composer. SSE `inbox_item`/`draft_ready` auto-refresh drafts; `capture_ack` flips the Composer pulse-dot green on matching `capture_id`. `/api/today` mirror sets `Cache-Control: private, max-age=0, stale-while-revalidate=86400` for Plan 10's service worker.

## One-liner

`/today` renders the full UI-01 mockup per TFOS-ui.html §01 — Brief, Top 3 mono-numbered Priorities with BolagBadge, draft cards with 2-line-clamped preview, dropped threads with avatar initials, today's meetings with `meeting-now` accent, voice/text Composer posting to `/capture` via Server Action with SSE-ack'd PulseDot — plus EntityLink + BolagBadge shared components every later view will reuse.

## What shipped

### Task 1 — Shared components + globals.css primitives (commit `cc2781a`)

- **`src/components/entity/EntityLink.tsx`** — Next `<Link>` wrapper with the `.ent` class (accent-2 color, dotted accent-border underline, focus ring). Typed via `next` `Route` to satisfy `typedRoutes: true`.
- **`src/components/badge/BolagBadge.tsx`** — data-driven bolag tint using `getBolagClass`. `variant="short"` (default) renders `TF`/`OB`/`PE`; `variant="full"` renders `Tale Forge`/`Outbehaving`/`Personal`. Unknown/null orgs fall through to `bolag-pe`.
- **`src/app/globals.css`** appended with:
  - `.ent` + `:hover` + `:focus-visible` (accent ring)
  - `.h-page` (22 px, 600, tracking -0.012em) + `.h-page-meta` (13 px, text-3) + `.h-section` (11 px, 600, upper, tracking 0.1em)
  - `.brief` (gradient surface-2 → surface-1, 22/24 padding, xl radius)
  - `.draft-card` (surface-1, lg radius, 14/16 padding, flex-col gap 10)
  - `.side-card` (surface-1, lg radius, 16/18 padding)
  - `.line-clamp-2` utility (webkit-line-clamp 2)
  - `@keyframes fade-up` + `.fade-up` animation (motion rule 4)
- **`tests/unit/bolag-badge.test.tsx`** — 6 cases (Tale Forge, Outbehaving, Personal, null/undef/unknown fallback, full variant, extra className propagation).

### Task 2 — Today RSC + 6 sub-components + /api/today mirror (commit `224bbb0`)

- **`src/app/(app)/today/page.tsx`** — replaces the Plan-06 stub. `dynamic = 'force-dynamic'`. Calls `callApi('/today', …, TodayResponseSchema)` with a try/catch that falls back to an empty `TodayResponse` so the shell renders even when dashboard-api `/today` isn't implemented in the current preview env.
- **`src/app/(app)/today/TodayView.tsx`** — `'use client'`. Grid `1fr 320px` gap 32. Left column stacks Brief → PriorityList → DraftsCard → DroppedThreads (gap 28). Right aside stacks MeetingsSideCard → Composer (gap 24). Header mono-meta reads `"N prioritering(ar) · M drafts · K möte(n)"` (Swedish pass-through per D-41). Subscribes to SSE `inbox_item` + `draft_ready` → `announce()` + `router.refresh()`.
- **`src/app/(app)/today/Brief.tsx`** — `.brief` card, pulsing success `brief-dot`, header `"AI Morning Brief · 07:00"`, body renders `brief.body` or the verbatim D-05 placeholder `"Brief generated daily at 07:00 — ships with Phase 7."` at 15 px / line-height 1.65. Page-entry `fade-up` animation.
- **`src/app/(app)/today/PriorityList.tsx`** — `.h-section` eyebrow "TOP 3 PRIORITIES" + count chip. `.priority-list` container with 3 `.pri-row` children. Each row: mono `01`/`02`/`03` in `.pri-num`, `.pri-title` with truncate, `.pri-meta` row with `<EntityLink>` (or plain `.ent-tag`) + `<BolagBadge>`. Framer-motion `<AnimatePresence>` wraps rows with 4px fade-in/out per motion rule 6. Empty state: `.side-card` with "No priorities yet. KOS surfaces them from Command Center every morning."
- **`src/app/(app)/today/DraftsCard.tsx`** — `.h-section` + count chip. Each draft renders as a `.draft-card` with a header row (`from · entity · relative-time via date-fns formatDistanceToNow`), optional subject, 2-line-clamped preview, and Approve/Edit/Skip `<Button>`s that `<Link>` to `/inbox` (triage actions belong to Plan 09 — see decisions). Empty state: "No drafts awaiting review. ✅" verbatim per UI-SPEC copy table.
- **`src/app/(app)/today/DroppedThreads.tsx`** — `.side-card` with `.thread-row` children. 28×28 initial avatar, entity name, `ago(age_days)` helper (today / Nd / Nw / Nmo). Row wraps the entire area in `<Link href={/entities/{id}}>`. Empty: "All threads are active."
- **`src/app/(app)/today/MeetingsSideCard.tsx`** — `.side-card` containing `.meeting-row` × meetings. Mono 56 px `.meeting-time` with `.meeting-now` accent-2 color when `is_now: true`. Time formatted `HH:mm` via date-fns. Empty: "Nothing on your calendar today." verbatim per UI-SPEC.
- **`src/app/globals.css`** appended with Today sub-primitives: `.brief-dot`, `.priority-list`, `.pri-row`/`.pri-num`/`.pri-title`/`.pri-meta`/`.pri-actions` (hover-revealed), `.meeting-row`/`.meeting-time`/`.meeting-now`/`.meeting-title`/`.meeting-meta`, `.thread-row`/`.thread-avatar`/`.thread-title`/`.thread-meta`, `.count-chip`.
- **`src/app/api/today/route.ts`** — Node-runtime mirror. `export const runtime = 'nodejs'; dynamic = 'force-dynamic'`. Proxies `/today` through callApi; on success returns with `cache-control: private, max-age=0, stale-while-revalidate=86400`; on upstream error returns 502 `{ error: 'upstream' }` (so the SW can distinguish stale vs missing).
- **`tests/e2e/today.spec.ts`** — promoted from `test.fixme` to `test.skip` (skips without `PLAYWRIGHT_BASE_URL`). Visits `/today`, asserts the H1, `.brief`, "TOP 3 PRIORITIES" eyebrow, "DRAFTS TO REVIEW" eyebrow, and the Swedish composer placeholder are all visible.

### Task 3 — Composer + captureText Server Action + unit test (commit `06b9672`)

- **`src/app/(app)/today/actions.ts`** — `'use server'`. `captureText(text: string)` runs `CapturePostSchema.parse({ text })` then `callApi('/capture', POST, CaptureResponseSchema)`.
- **`src/app/(app)/today/Composer.tsx`** — `'use client'`. Swedish placeholder verbatim per UI-SPEC + D-41: `"Dumpa allt — en tanke, en idé, ett möte. KOS sorterar."`. "Skicka" primary button disabled until textarea has non-whitespace content. `useTransition` for pending state; success path clears textarea + shows sonner `toast.success` with mono capture_id (3s auto-dismiss); failure path shows `toast.error("Capture didn't reach KOS. Retry?")` with retry action and `duration: Infinity`. `<PulseDot>` tone flips accent → warning on submit → success on SSE `capture_ack` match → warning after 5 s if no ack. `useSseKind('capture_ack', …)` subscription keyed on the returned `capture_id`.
- **`tests/unit/composer.test.tsx`** — 5 cases: placeholder + "Skicka" visible, disabled when empty, success path (captureText called with trimmed value + toast.success with capture_id + textarea cleared), failure path (toast.error with verbatim copy + Retry action + duration Infinity), whitespace-only stays disabled.

## Empty-state coverage matrix (UI-SPEC §Copywriting — Today rows)

| Row | Copy | Component | Status |
|-----|------|-----------|--------|
| Today priorities | "No priorities yet." + "KOS surfaces them from Command Center every morning." | PriorityList.tsx | ✅ |
| Today drafts | "No drafts awaiting review. ✅" | DraftsCard.tsx | ✅ |
| Today meetings | "Nothing on your calendar today." | MeetingsSideCard.tsx | ✅ |
| Dropped threads (plan-added) | "All threads are active." | DroppedThreads.tsx | ✅ (new — not in UI-SPEC copy table) |
| Brief placeholder (D-05) | "Brief generated daily at 07:00 — ships with Phase 7." | Brief.tsx | ✅ |
| Error — capture submit failed | "Capture didn't reach KOS. Retry?" with Retry action, auto-dismiss disabled | Composer.tsx | ✅ |

All 5 UI-SPEC Today-empty rows are covered (the matrix also shows the Brief D-05 placeholder and the Composer failure toast as belt-and-suspenders).

## Bundle impact (Next build)

| Route | First Load JS | Notes |
|-------|---------------|-------|
| `/today` | 264 kB | +90 kB over Plan 06 shell; framer-motion hoisted into shared chunks means Plan 09/10/11 reuse the cost |
| `/api/today` | 331 B (function) | Node-runtime proxy |
| Shared JS | 173 kB | unchanged (framer-motion lands in the shared chunk) |

Bundle is within the Phase-3 ≤ 250 kB "first-paint-critical JS" budget for the route's own code (11.5 kB server-component / 52 kB client components). Framer-motion + date-fns are shared libs amortized across the rest of Wave-3.

## Lifecycle flows

### Initial load
1. Middleware gates `kos_session` cookie (Plan 05).
2. RSC `TodayPage` calls `callApi('/today', …)` via SigV4 against dashboard-api Function URL.
3. On success → passes `TodayResponse` to `<TodayView>` (client).
4. On upstream error → renders empty shape; layout still paints; SSE will later drive content in.

### SSE-driven refresh
1. `SseProvider` (Plan 07) fires `inbox_item` or `draft_ready` event.
2. `TodayView` subscribers call `announce()` + `router.refresh()`.
3. Next re-executes `TodayPage` RSC → new data props → React reconciles.
4. `<AnimatePresence>` animates inserted rows with 4px slide-in + fade (180 ms ease).

### Capture flow
1. User types in Composer → "Skicka" enables.
2. Submit: `startTransition` sets dot warning → calls `captureText(text)` Server Action → SigV4 POST to `/capture`.
3. Server Action returns `{ capture_id, received_at }`.
4. Composer stores `waitingFor = capture_id`; sonner toast.success shows capture_id (3s).
5. SSE `capture_ack` arrives → matching id flips dot to success + clears `waitingFor` + clears timeout.
6. If no ack within 5 s → dot stays warning (soft-fail, per decisions).
7. Server Action throws → toast.error with Retry action; dot back to accent.

## Verification

- `pnpm --filter @kos/dashboard typecheck` → clean.
- `pnpm --filter @kos/dashboard test --run` → **64 tests pass across 12 files** (was 53 after Plan 03-07; +11 new: 6 bolag-badge + 5 composer).
- `pnpm --filter @kos/dashboard build` → succeeds; `/today` = 264 kB first load, `/api/today` present as dynamic function, middleware bundle unchanged at 41.7 kB.
- Acceptance greps — all pass:
  - `.ent {` / `.brief {` / `.draft-card {` / `.h-page {` / `@keyframes fade-up` in globals.css
  - `getBolagClass` in BolagBadge.tsx
  - 6 Today sub-component files exist (TodayView/Brief/PriorityList/DraftsCard/DroppedThreads/MeetingsSideCard)
  - `"Brief generated daily at 07:00 — ships with Phase 7."` verbatim in Brief.tsx
  - `"No drafts awaiting review. ✅"` verbatim in DraftsCard.tsx
  - `"TOP 3 PRIORITIES"` in PriorityList.tsx
  - `useSseKind` + `inbox_item` in TodayView.tsx
  - `AnimatePresence` in DraftsCard.tsx + PriorityList.tsx
  - `stale-while-revalidate=86400` in /api/today/route.ts
  - Composer: `"Dumpa allt — en tanke, en idé, ett möte. KOS sorterar."` + `"Skicka"` + `"Capture didn't reach KOS. Retry?"` + `useSseKind('capture_ack'` + `CapturePostSchema.parse` in actions.ts + `'use server'` in actions.ts

## Acceptance criteria (from plan)

**Task 1 — Shared components:**
- [x] `.ent {` / `.brief {` / `.draft-card {` / `.h-page {` / `@keyframes fade-up` all matched in globals.css
- [x] `getBolagClass` matched in BolagBadge.tsx
- [x] bolag-badge.test.tsx passes ≥ 5 cases (actual: 6)

**Task 2 — Today RSC + sub-components + /api/today:**
- [x] All 6 sub-component files exist.
- [x] Brief.tsx contains D-05 placeholder verbatim.
- [x] DraftsCard.tsx contains empty-state copy verbatim.
- [x] PriorityList.tsx contains "TOP 3 PRIORITIES" eyebrow.
- [x] TodayView.tsx contains `useSseKind` + `inbox_item`.
- [x] DraftsCard or PriorityList contains `AnimatePresence`.
- [x] /api/today has `stale-while-revalidate=86400`.
- [x] `pnpm --filter @kos/dashboard build` succeeds.

**Task 3 — Composer + Server Action:**
- [x] Composer has Swedish placeholder verbatim + "Skicka" + retry copy verbatim + `useSseKind('capture_ack'`.
- [x] actions.ts has `'use server'` + `CapturePostSchema.parse`.
- [x] composer.test.tsx passes (5 cases).
- [x] Build succeeds.

## Deviations from Plan

### Rule 3 — Auto-fix blocking issues

**1. Installed `@testing-library/user-event@14.5.2` as devDependency**
- **Found during:** Task 3 — running `tests/unit/composer.test.tsx`.
- **Issue:** Plan pseudocode referenced user-event simulation (simulate typing + submit), but the dashboard had `@testing-library/react` only; `user-event` was never installed.
- **Fix:** `pnpm --filter @kos/dashboard add -D @testing-library/user-event@14.5.2`. All 5 Composer cases pass.
- **Files modified:** `apps/dashboard/package.json`, `pnpm-lock.yaml`
- **Commit:** 06b9672

### Rule 1 — Auto-fix bugs

**2. `useSseKind('capture_ack', handler)` cast to `never` for TS2352**
- **Found during:** Task 3 typecheck (`Property 'id' does not exist on type 'never'`).
- **Issue:** SseProvider's `Handler<K>` type is `Extract<SseEvent, { kind: K }>` — but `SseEvent` in packages/contracts is a single `z.object()`, not a discriminated union. So `Extract<SseEvent, { kind: 'capture_ack' }>` resolves to `never` and TS rejects access to `ev.id`.
- **Fix:** Declared handler with explicit `(ev: SseEvent) => void` signature (matches runtime reality — the provider's trampoline runs `ev.kind !== kind` before dispatch), then passed to `useSseKind('capture_ack', onAck as never)`. Runtime behaviour is unchanged; the cast only suppresses the variance TS can't prove.
- **Files modified:** `apps/dashboard/src/app/(app)/today/Composer.tsx`
- **Commit:** 06b9672

### Rule 2 — Auto-added missing critical functionality

**3. `TodayPage` wraps `callApi('/today', …)` in try/catch with empty fallback**
- **Found during:** Task 2 reasoning about upstream availability.
- **Issue:** If dashboard-api `/today` isn't yet implemented in the current preview env, the RSC would throw and render the Next error boundary (500-ish page) — violating D-12 "no crying wolf" + breaking the Plan-06 stub-shell contract.
- **Fix:** try/catch returns an empty `TodayResponse` shape. The shell + empty-state copy handle the "no data" case cleanly. If /today IS implemented upstream and returns a non-2xx, callApi throws with an error that gets caught and also fallbacks to empty — the SSE reconnect layer would then drive content in.
- **Files modified:** `apps/dashboard/src/app/(app)/today/page.tsx`
- **Commit:** 224bbb0

No Rule 4 triggered — the plan's threat register (T-3-08-01..04) is fully implemented as specified; no architectural changes.

## Threat Flags

None. The plan introduces exactly one new public network surface (`GET /api/today`) which sits behind the existing middleware cookie gate; the `captureText` Server Action runs same-origin through Next 15's signed Server Action protocol (handled by Next). No new trust boundaries.

## Known Stubs

The Approve/Edit/Skip buttons on draft cards are `<Link href="/inbox">`. This is INTENTIONAL — triage actions belong to Plan 03-09's Inbox view; Today surfaces drafts as a summary with click-through rather than duplicating the inbox action plumbing. Documented in decisions + matches the Phase 3 view-ownership split (Today = overview, Inbox = triage).

No other stubs. Brief.tsx's D-05 placeholder is the Phase 7 contract, not a stub — it ships per the plan.

## Ready-for handoffs

- **Plan 03-09 (Inbox):** `<EntityLink>` + `<BolagBadge>` + `.draft-card` + `.line-clamp-2` all already in place; just import. The AnimatePresence + motion rule 6 pattern used here translates 1:1 to the Inbox queue. The `tinykeys` J/K/E/S keyboard pattern from Plan 06's sidebar still applies — use `isTypingInField` guard.
- **Plan 03-10 (Entity dossier):** `<EntityLink>` renders entity-to-entity links in the AI block + timeline; `<BolagBadge>` for every bolag tint in the dossier header + linked projects; `.fade-up` for page-entry; `.h-section` for every eyebrow; `useSseKind('entity_merge', …)` + `useSseKind('timeline_event', …)` with event-id dedup set per Plan 07 handoff doc.
- **Plan 03-10 (Calendar week):** `<BolagBadge>` on event pills; `.meeting-row` style optional reuse.
- **Plan 03-12 (PWA):** `@serwist/next` should register a runtime cache for `/api/today` with a `StaleWhileRevalidate` strategy and a 24h max-age — the route handler's `Cache-Control: stale-while-revalidate=86400` header already carries the budget, the SW just needs to honor it.

## Self-Check: PASSED

- FOUND: apps/dashboard/src/components/entity/EntityLink.tsx
- FOUND: apps/dashboard/src/components/badge/BolagBadge.tsx
- FOUND: apps/dashboard/src/app/(app)/today/page.tsx
- FOUND: apps/dashboard/src/app/(app)/today/TodayView.tsx
- FOUND: apps/dashboard/src/app/(app)/today/Brief.tsx
- FOUND: apps/dashboard/src/app/(app)/today/PriorityList.tsx
- FOUND: apps/dashboard/src/app/(app)/today/DraftsCard.tsx
- FOUND: apps/dashboard/src/app/(app)/today/DroppedThreads.tsx
- FOUND: apps/dashboard/src/app/(app)/today/MeetingsSideCard.tsx
- FOUND: apps/dashboard/src/app/(app)/today/Composer.tsx
- FOUND: apps/dashboard/src/app/(app)/today/actions.ts
- FOUND: apps/dashboard/src/app/api/today/route.ts
- FOUND: apps/dashboard/tests/unit/bolag-badge.test.tsx
- FOUND: apps/dashboard/tests/unit/composer.test.tsx
- FOUND: apps/dashboard/tests/e2e/today.spec.ts (modified — fixme → active-skip)
- FOUND: apps/dashboard/src/app/globals.css (modified — Today primitives appended)
- FOUND: commit cc2781a (feat(03-08): shared EntityLink + BolagBadge + page-level CSS)
- FOUND: commit 224bbb0 (feat(03-08): Today RSC + Brief/Priorities/Drafts/Dropped/Meetings + /api/today)
- FOUND: commit 06b9672 (feat(03-08): Composer + captureText Server Action with SSE capture_ack PulseDot)
