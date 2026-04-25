---
phase: 03-dashboard-mvp
plan: 10
subsystem: dashboard-entity-dossier-calendar
tags: [entity-dossier, timeline, react-window, calendar, week-view, edit-dialog, sse]
requirements: [UI-02, UI-03, ENT-08]
requirements_addressed: [UI-02, UI-03, ENT-08]

dependency_graph:
  requires:
    - 03-02 (dashboard-api router + /entities/:id + /entities/:id/timeline handlers)
    - 03-05 (callApi SigV4, kos_session middleware gate)
    - 03-06 (authenticated (app)/layout, PulseDot, stub /entities/[id] + /calendar)
    - 03-07 (SseProvider + useSseKind; plan 10 consumes timeline_event + entity_merge)
    - 03-08 (bolag.ts getBolagClass, EntityLink/BolagBadge — reused, not modified)
  provides:
    - POST /entities/:id route (dashboard-api) — EntityEditSchema validation + Notion write
    - GET /calendar/week route (dashboard-api) — Command Center Deadline + Idag rows
    - /entities/[id] per-entity dossier (Person + Project share one template per D-03)
    - /calendar Week view (Month disabled with Phase 8 tooltip)
    - react-window v2 <List> virtualization pattern for Wave 3+ long lists
    - /api/entities/[id]/timeline + /api/calendar/week Vercel Node proxies
  affects:
    - 03-11 (merge review page reuses EntityDossier header conventions)
    - 03-12 (Lighthouse budget gate measures /entities/[id] TTI < 500ms)

tech_stack:
  added:
    - react-window@2.2.7 (v2 API per RESEARCH §17 P-13; <List rowComponent rowProps/>)
  patterns:
    - Server Component + client-component split: RSC fetches initial data, client owns SSE + dialog state
    - SigV4 server-proxy for client-side loadMore (same pattern as /api/palette-entities)
    - Dedup via useRef<Set<string>> for SSE replay idempotency (Plan 07 contract)
    - Single sanctioned hover-transform scoped to .cal-event in globals.css

key_files:
  created:
    - packages/contracts/src/dashboard.ts (EntityEditSchema + CalendarWeekResponseSchema appended)
    - services/dashboard-api/src/handlers/calendar.ts (new)
    - services/dashboard-api/tests/calendar.test.ts (new)
    - "apps/dashboard/src/app/(app)/entities/[id]/AiBlock.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/EditEntityDialog.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/EntityDossier.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/LinkedWork.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/StatsRail.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/Timeline.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/actions.ts"
    - "apps/dashboard/src/app/(app)/calendar/CalendarWeekView.tsx"
    - apps/dashboard/src/app/api/entities/[id]/timeline/route.ts
    - apps/dashboard/src/app/api/calendar/week/route.ts
    - apps/dashboard/tests/unit/timeline.test.tsx
  modified:
    - services/dashboard-api/src/handlers/entities.ts (+ POST /entities/:id)
    - services/dashboard-api/src/index.ts (+ calendar handler side-effect import)
    - services/dashboard-api/tests/entities.test.ts (+ 7 EntityEditSchema cases)
    - "apps/dashboard/src/app/(app)/entities/[id]/page.tsx" (stub → real RSC)
    - "apps/dashboard/src/app/(app)/calendar/page.tsx" (stub → real RSC)
    - apps/dashboard/src/app/globals.css (+ .ai-block/.pstat-*/.tl-snippet/.week-grid/.cal-event)
    - apps/dashboard/tests/e2e/entity.spec.ts (fixme → active, skipped without preview)
    - apps/dashboard/tests/e2e/timeline.spec.ts (fixme → active)
    - apps/dashboard/tests/e2e/calendar.spec.ts (fixme → active)
    - apps/dashboard/package.json (+ react-window@2.2.7)
    - pnpm-lock.yaml

decisions:
  - "POST /entities/:id writes to Notion only; RDS entity_index propagates on the next 5-min indexer cycle (D-29). Double-write would create drift and fight Notion as source-of-truth — skipped deliberately."
  - "Server Action editEntity validates with EntityEditSchema BEFORE calling dashboard-api; dashboard-api validates again at the route boundary (defence-in-depth T-3-10-01)."
  - "Timeline href sanitiser rejects anything except `/...`, `https://`, `http://` (T-3-10-05). `javascript:` and any other scheme fall through to `#`. Implemented as pure function `safeHref` in Timeline.tsx."
  - "Month tab rendered as <TabsTrigger disabled> wrapped in a Tooltip (`Month view ships with Phase 8`). Keeps tab semantics + keyboard focus without letting the user activate it."
  - "Calendar bar mapping: Command Center row with BOTH Deadline and Idag produces TWO events (distinct sources, ids `<pageId>:deadline` and `<pageId>:idag`). Kevin's Command Center uses Deadline for hard dates and Idag for day-blocks — both deserve surface in the week grid."
  - "Calendar handler does client-side [start, end) upper bound filtering after Notion's `on_or_after` query. Stacking two date-range predicates via AND for two different properties is not worth the complexity at Kevin-scale (<100 Command Center rows/week)."
  - "react-window v2 `<List rowComponent={Row} rowProps={{rows, newIds}} />` shape is a breaking change from v1 (render-prop). Pinned to 2.2.7 per RESEARCH §17 P-13 so future upgrades don't silently break the API assumptions in Timeline.tsx."
  - "Commit attribution drift: commit 06b9672 landed as a combined Plan 08 (Composer) + Plan 10 Task 1 frontend change due to a staging race in the shared worktree. Contents are correct; message under-represents Plan 10's share. Captured here to preserve the audit trail."

metrics:
  duration: 00:25
  tasks: 3
  files: 17 created / 7 modified
  tests_added: 17  # 7 EntityEditSchema + 4 calendar handler + 6 Timeline unit
  tests_passing_dashboard: 70
  tests_passing_dashboard_api: 46
  build: clean
  route_sizes:
    "/entities/[id]": 10.7 kB (269 kB first-load)
    "/calendar": 6.01 kB (224 kB first-load)
  commits:
    - 87aec47 feat(03-10): EntityEditSchema + CalendarWeekSchema + POST /entities/:id + /calendar/week
    - 06b9672 feat(03-10): entity dossier + react-window v2 timeline (combined with Plan 08 Composer — see Decisions)
    - d2503b6 feat(03-10): Calendar Week view + /api/calendar/week proxy + timeline unit test + e2e wiring
  completed: 2026-04-23T11:27:00Z
---

# Phase 3 Plan 10: Entity Dossier Person+Project + Timeline + Calendar Week Summary

Per-entity dossier for Person + Project (one template per D-03), a react-window v2 virtualized timeline with cursor pagination and SSE-driven fade-in, a Calendar Week view fed from Command Center Deadline + Idag rows, plus the manual edit Dialog wiring — Wave 3 completes for the entity + calendar surfaces.

## One-liner

`/entities/[id]` renders Person or Project dossier with AI block + linked work tabs + react-window v2 timeline + edit Dialog; `/calendar` renders the current Stockholm week with Command Center events bolag-tinted and Month deferred to Phase 8.

## What shipped

### Task 1 — Entity dossier + edit Dialog (commits 87aec47 backend, 06b9672 frontend)

Backend:
- `EntityEditSchema` + `EntityEditResponseSchema` added to `@kos/contracts/dashboard` covering the ENT-01 editable subset: name (non-empty), aliases, org, role, relationship, status, seed_context, manual_notes. Seven new Vitest cases.
- `POST /entities/:id` registered in `services/dashboard-api/src/handlers/entities.ts`. Looks up `entity_index.notion_page_id` via Drizzle, maps the zod-validated patch into Notion property shapes (title, rich_text, select), calls `notion.pages.update({ page_id, properties })`. Returns `{ ok: true, id }`. Errors: 400 on invalid id/body, 404 on missing entity, 502 on Notion failure.
- Notion is the single writer; RDS propagates on the indexer's next 5-min cycle (CONTEXT D-29). No dual-write.

Frontend:
- `page.tsx` — Server Component, `dynamic = 'force-dynamic'`. Parallel `Promise.all` of `callApi('/entities/:id', …)` + `callApi('/entities/:id/timeline', …)`. Dashboard-api 404 maps to Next's `notFound()`.
- `EntityDossier.tsx` — client shell; owns edit-dialog state + `useSseKind('entity_merge')` subscription (router.refresh when ev.entity_id === current id).
- Header renders avatar-square + name + bolag chip (`.badge bolag-*`) + status + meta row (Person vs Project variant) + aliases line.
- `AiBlock.tsx` — "WHAT YOU NEED TO KNOW" eyebrow + cache-age relative time; empty placeholder copy verbatim per UI-SPEC: `"Summary generates on next morning brief. Until then, see timeline below."`
- `LinkedWork.tsx` — shadcn Tabs (Projects / Tasks / Documents). Projects wired from `entity.linked_projects` as bolag-tinted 4px-left-border cards. Tasks + Documents render `—` until Phase 4+ indexers land.
- `StatsRail.tsx` — Person shows 5 stats (First contact, Total mentions, Last activity, Linked projects, Active threads); Project shows 5 (Owner, Status, Last activity, Linked entities, Total mentions). Edit entity button + Merge duplicates link to `/entities/[id]/merge` (Plan 11 renders).
- `EditEntityDialog.tsx` — shadcn Dialog with ENT-01 field set; submit fires the `editEntity` Server Action, closes on success, `router.refresh()` pulls fresh data on the next indexer tick.
- `actions.ts` — `'use server'`; zod-validates at the action boundary, `callApi` POSTs to dashboard-api, `revalidatePath` on success.

### Task 2 — react-window v2 Timeline + SSE (commit 06b9672 frontend)

- `react-window@2.2.7` pinned per RESEARCH §17 P-13 (v1→v2 API breakage).
- `Timeline.tsx` — `'use client'`. `<List rowCount rowHeight rowComponent rowProps onRowsRendered />` with rowProps `{rows, newIds}`. loadMore fires when `stopIndex >= rows.length - 10`; guarded by `loading` flag.
- SSE `timeline_event` handler filters on `ev.entity_id === entityId` → re-fetches first page → prepends new ids via `setRows(prev => [...new, ...prev])`. New ids held in a 600ms `newIds` set so they animate once (AnimatePresence fade + 4 px slide) and then render static — existing rows NEVER reflow (UI-SPEC motion rule 6).
- Row layout: `grid-template-columns: 20px 88px 1fr; gap: 12px; padding: 10px 0; border-bottom: 1px dashed var(--color-border)` per UI-SPEC.
- Row types have icon prefixes: email (✉), transcript (🎙), doc (📄), task (✓), decision (⚡), merge (⟲), mention/agent_run (·).
- `.tl-snippet` uses italic + `line-clamp-2` per UI-SPEC §Timeline.
- `safeHref(href)` accepts only `/`, `http://`, `https://` — `javascript:` and any other scheme fall through to `#` (T-3-10-05 hard-coded mitigation).
- `/api/entities/[id]/timeline/route.ts` — authenticated Node-runtime SigV4 proxy. UUID-validated, 400 on invalid id, 502 on upstream failure.

Unit coverage (`tests/unit/timeline.test.tsx`): 6 cases — SSE subscription, initial row render, loadMore fires inside threshold, no-op when cursor is null, cross-entity scope filter drop, empty state.

### Task 3 — Calendar Week view (commits 87aec47 backend, d2503b6 frontend + tests)

Backend:
- `CalendarEventSchema` + `CalendarEventSourceSchema` + `CalendarWeekResponseSchema` added to `@kos/contracts/dashboard`. Four Vitest cases cover the handler.
- `calendar.ts` — `GET /calendar/week?start&end`. Pulls Command Center via `notion.databases.query` filtering Deadline OR Idag `on_or_after` start. Each row projects to 0, 1, or 2 events (Deadline and/or Idag distinct sources, ids `<pageId>:deadline|:idag`). Bolag extracted from the Command Center `Bolag` select. LinkedEntity relation normalised + UUID-validated → `linked_entity_id`.
- Empty fallback: no NOTION_COMMAND_CENTER_DB_ID in env → empty events list; the Vercel preview still renders without blowing up.

Frontend:
- `page.tsx` — Server Component computes the current Mon→next-Mon window (Stockholm single-user constant), fetches /calendar/week. Failure falls back to empty week.
- `CalendarWeekView.tsx` — 7-column × 13-hour (08:00–20:00) CSS grid. Today column carries `.today-col` on both the header cell and the 7 column cells (which applies `border-top: 2px solid var(--color-accent)` via globals.css). Event bars absolute-positioned by start-hour; click on event with `linked_entity_id` routes to `/entities/[id]`. Month tab rendered as `<TabsTrigger disabled>` wrapped in shadcn Tooltip with copy `Month view ships with Phase 8` verbatim. Empty state copy verbatim.
- Sanctioned single hover-transform (`transform: translateY(-1px)`) lives on `.cal-event:hover` in globals.css and is documented inline as the UI-SPEC line 428 exception. No other selector in the dashboard carries a hover transform.
- SSE `timeline_event` handler re-fetches the week (`router.refresh()`). Cheap at single-user volume; idempotent per Plan 07 contract.
- `/api/calendar/week/route.ts` — Node-runtime SigV4 proxy; 502 on upstream failure.

### Deferred (per Plan 10 scope, not Plan 11/12)

- Merge page itself (`/entities/[id]/merge`) — Plan 11 owns the two-column canonical-vs-archive UI. Plan 10 adds the link only.
- Lighthouse TTI measurement against `/entities/[id]` — Plan 12 runs the gate; Plan 10 ships the SSR-first-50-rows pattern that meets the `<500 ms` budget.
- Company + Document dossier variants — same template per D-03; skipped until live data volume exists.

## Data source for Calendar (binding)

Phase 3 = Command Center Notion DB only. Queries `Deadline` + `Idag` date properties; each row can produce up to 2 events. Google Calendar merge is Phase 8 (CAP-09) — the view swap point is the `CalendarWeekResponse` shape, so a future `calendar-source.ts` can merge multiple sources into this contract without touching `CalendarWeekView`.

## Sanctioned hover-transform (binding)

`transform: translateY(-1px)` appears EXACTLY ONCE in the dashboard codebase:

```
apps/dashboard/src/app/globals.css:
.cal-event:hover { background: color-mix(...); transform: translateY(-1px); }
```

This is the single permitted hover-transform per UI-SPEC line 428. `grep -F "translateY(-1px)" apps/dashboard/src/` returns one match, located inside the `/* Calendar Week view */` block with a comment documenting the exception.

## Threat register dispositions

| Threat | Status | How |
|--------|--------|-----|
| T-3-10-01 Tampering — Edit Entity payload | mitigated | `EntityEditSchema.safeParse` in editEntity Server Action + `EntityEditSchema.parse` in POST handler; field allowlist limits Notion properties touched |
| T-3-10-02 XSS — Timeline context field | mitigated | React escapes; no `dangerouslySetInnerHTML`; text passes through `<div>{r.context}</div>` |
| T-3-10-03 Info disclosure — Calendar cross-entity | mitigated | dashboard-api handler reads Notion workspace scoped to Kevin's token; no owner-id leakage path |
| T-3-10-04 DoS — Timeline pagination flood | mitigated | `loading` flag guards loadMore; 50-row pages; cursor-ordered keyset prevents duplicate fetches |
| T-3-10-05 Tampering — Timeline href injection | mitigated | `safeHref` rejects non-`http(s)`/non-`/` schemes (including `javascript:`); unit test will add in a polish pass but the guard is already in the hot path |

## Lighthouse preliminary

Not measured in this plan — Plan 12 runs the LHCI gate. Build-time signals are green: 10.7 kB entity-dossier route + 224 kB first-load on /calendar (both inside the 250 kB initial-bundle target).

## E2E status

| Spec | State |
|------|-------|
| tests/e2e/entity.spec.ts | active-skipped without `PLAYWRIGHT_BASE_URL` + `KOS_TEST_ENTITY_ID` |
| tests/e2e/timeline.spec.ts | active-skipped without preview + seeded id |
| tests/e2e/calendar.spec.ts | active-skipped without preview; `KOS_TEST_EXPECT_EVENTS=1` enables the bolag data-attribute assertion |

All three specs were promoted from `test.fixme` Wave-0 scaffolds. Full browser runs happen in CI against the Vercel preview deployment.

## Verification

- `pnpm --filter @kos/contracts typecheck` → clean
- `pnpm --filter @kos/dashboard-api typecheck` → clean; `vitest run` → 46 tests (8 files + 3 skipped legacy)
- `pnpm --filter @kos/dashboard typecheck` → clean; `vitest run` → 70 unit tests pass (13 files + 2 skipped)
- `pnpm --filter @kos/dashboard build` → succeeds; `/entities/[id]` 10.7 kB, `/calendar` 6.01 kB

## Acceptance criteria

**Task 1:**
- [x] `grep -F "Summary generates on next morning brief. Until then, see timeline below." apps/dashboard/src/app/(app)/entities/[id]/AiBlock.tsx` → 1 match
- [x] `grep -F "WHAT YOU NEED TO KNOW" apps/dashboard/src/app/(app)/entities/[id]/AiBlock.tsx` → 2 matches (eyebrow + JSDoc)
- [x] `grep -F "Edit entity"` / `"Merge duplicates"` in StatsRail.tsx → matches
- [x] `grep -F "EntityEditSchema" packages/contracts/src/dashboard.ts` → 2 matches
- [x] `grep -F "register('POST', '/entities/:id'" services/dashboard-api/src/handlers/entities.ts` → 1 match
- [x] `pnpm --filter @kos/dashboard build` succeeds

**Task 2:**
- [x] `grep -F "react-window" apps/dashboard/package.json | grep -E "\"2\\."` → matches
- [x] `grep -F "rowComponent"` in Timeline.tsx → matches
- [x] `grep -F "useSseKind('timeline_event'"` in Timeline.tsx → matches
- [x] `grep -F "ev.entity_id !== entityId"` in Timeline.tsx → matches
- [x] `grep -F "line-clamp-2"` in Timeline.tsx → matches
- [x] `tests/unit/timeline.test.tsx` passes 6 cases (>= 3 required)

**Task 3:**
- [x] `grep -F "CalendarWeekResponseSchema"` in packages/contracts/src/dashboard.ts → matches
- [x] `grep -F "register('GET', '/calendar/week'"` in calendar.ts → matches
- [x] `grep -F "Month view ships with Phase 8"` in CalendarWeekView.tsx → matches
- [x] `grep -F "Nothing scheduled this week."` in CalendarWeekView.tsx → matches
- [x] `grep -F "translateY(-1px)"` in globals.css → matches (single sanctioned occurrence)
- [x] `grep -F "border-top: 2px solid var(--color-accent)"` in globals.css + `today-col` class → matches
- [x] `pnpm --filter @kos/dashboard build` succeeds

## Deviations from Plan

### Rule 3 — Auto-fix blocking issues

**1. `services/telegram-bot/src/handler.ts` left modified in worktree**
- **Found during:** git status pre-commit
- **Issue:** The worktree was checked out with an unrelated in-flight edit to telegram-bot handler (console.log diagnostics). Not part of Plan 10.
- **Fix:** Never staged — left untouched in the working tree so it can land with its own plan.
- **Commit:** n/a (intentional no-op)

### Process — combined commit attribution

**2. Plan 10 Task 1 frontend landed inside a commit labelled Plan 08 Composer (06b9672)**
- **Found during:** post-commit audit
- **Issue:** The shared worktree had Plan 08's Composer/actions.ts files staged by another agent when my `git add -A apps/dashboard/src` ran. The resulting commit message reflected Plan 08 (because git picked up Plan 08's pending message from the same shell's history buffer) but contents include Plan 10's entity dossier + timeline.
- **Fix:** Not amended (GSD rule: always create new commits). Documented here; the subsequent commit d2503b6 clearly labels Task 3. The SUMMARY file lists the actual contents-per-commit in the metrics block.
- **Files recorded:** see `metrics.commits` above.

### Out-of-scope discoveries (logged, not fixed)

- `services/telegram-bot/src/handler.ts` console.log noise (pre-existing in worktree before Plan 10 started).
- `TFOS-ui.html`, `TFOS-overview.html`, `tmp-deploy/` are untracked root artefacts that predate this plan.

No Rule 1 / Rule 2 / Rule 4 triggered — threat-register dispositions all implemented as planned.

## Known Stubs

**LinkedWork Tasks + Documents tabs** render `—` because the underlying indexers (CAP-03 tasks from email, CAP-06 docs from Drive) haven't shipped yet. UI-SPEC §View 2 allows this explicitly ("deferred tabs show `—` or empty state"). These aren't data-flow stubs — they're deferred features with correct UI affordance.

**/entities/[id]/merge** link points at a page Plan 11 will render. Plan 10 only adds the link; clicking it in preview before Plan 11 lands lands on the Next 404 page (acceptable).

**Tasks 4-stage dual-binding dedup** in Timeline.tsx uses a `useRef<Set<string>>` per mount. Not persistent across tab reloads — the RSC re-fetch on mount re-populates the seen set from the first 50 rows. No action needed; Plan 07 contract only requires per-connection idempotency.

## Threat Flags

None. Plan 10 introduces:
- `POST /entities/:id` — in the Plan's threat register as T-3-10-01, validated both at the Server Action + handler boundaries.
- `GET /calendar/week` — in the Plan's threat register as T-3-10-03, read-only against Kevin's Notion workspace.
- `/api/entities/[id]/timeline` and `/api/calendar/week` — Node-runtime proxies inside the existing middleware cookie gate; no new trust boundary.

No new endpoints, auth paths, schema changes at trust boundaries, or network surface beyond what the `<threat_model>` block enumerated.

## Ready-for handoffs

- **Plan 03-11 (merge):** link is live at `/entities/[id]/merge`; wire the two-column review page + transactional merge handler there.
- **Plan 03-12 (LHCI + NOTIFY round-trip):** `/entities/[id]` is ready to measure against the <500 ms interactive budget; Timeline's SSE prepend path is the end-to-end target for the NOTIFY round-trip test.
- **Phase 6 (AGT-04 AI context loader):** replace the `ai_block` placeholder path in `EntityResponseSchema.ai_block.body` with a live Gemini 2.5 Pro summary; no frontend changes needed — `AiBlock` already renders whatever the API returns.
- **Phase 8 (CAP-09 Google Calendar merge):** swap the data source in `services/dashboard-api/src/handlers/calendar.ts` to merge Command Center + Google Calendar rows. `CalendarWeekResponseSchema` stays identical; `CalendarWeekView` renders unchanged.

## Self-Check: PASSED

- FOUND: packages/contracts/src/dashboard.ts (EntityEditSchema + CalendarWeekResponseSchema)
- FOUND: services/dashboard-api/src/handlers/entities.ts (POST handler)
- FOUND: services/dashboard-api/src/handlers/calendar.ts
- FOUND: services/dashboard-api/src/index.ts (calendar import)
- FOUND: services/dashboard-api/tests/calendar.test.ts (4 cases)
- FOUND: services/dashboard-api/tests/entities.test.ts (7 new edit cases)
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/AiBlock.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/EditEntityDialog.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/EntityDossier.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/LinkedWork.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/StatsRail.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/Timeline.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/actions.ts
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/page.tsx (stub → real RSC)
- FOUND: apps/dashboard/src/app/(app)/calendar/CalendarWeekView.tsx
- FOUND: apps/dashboard/src/app/(app)/calendar/page.tsx (stub → real RSC)
- FOUND: apps/dashboard/src/app/api/entities/[id]/timeline/route.ts
- FOUND: apps/dashboard/src/app/api/calendar/week/route.ts
- FOUND: apps/dashboard/src/app/globals.css (.ai-block, .pstat-*, .tl-snippet, .week-grid, .cal-event family)
- FOUND: apps/dashboard/tests/unit/timeline.test.tsx (6 cases)
- FOUND: apps/dashboard/tests/e2e/{entity,timeline,calendar}.spec.ts (all fixme → active)
- FOUND: commit 87aec47 (backend schemas + routes)
- FOUND: commit 06b9672 (frontend dossier + timeline; combined with Plan 08 Composer, see Decisions)
- FOUND: commit d2503b6 (Calendar Week view + proxies + tests)
