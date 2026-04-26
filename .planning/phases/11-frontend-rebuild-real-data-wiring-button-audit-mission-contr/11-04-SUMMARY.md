---
phase: 11
plan: 4
subsystem: dashboard-today-mission-control
tags: [today-view, real-data-wiring, mission-control, stat-tiles, channel-health, captures-feed, tdd]
wave: 2
status: complete
duration_seconds: 765
completed_at: 2026-04-26T19:46:05Z

dependency_graph:
  requires:
    - 11-00 (Wave 0 schema verification — established that capture_text/capture_voice DO NOT EXIST)
    - 11-02 (Wave 1 mission-control primitives — StatTile / StatTileGrid / ChannelHealth / ChannelHealthItemSchema)
  provides:
    - Extended TodayResponseSchema (additive: captures_today + stat_tiles + channels)
    - CaptureSourceSchema enum (5 real source tables, post-Wave-0 deviation)
    - TodayCaptureItemSchema + StatTileDataSchema in @kos/contracts/dashboard
    - loadCapturesToday / loadStatTiles / loadTodayChannels helpers in /today handler
    - StatTileStrip + CapturesList components for the today page
    - Rewired TodayView mission-control layout
  affects:
    - apps/dashboard/src/app/(app)/today/page.tsx (EMPTY shape now includes new defaults)
    - apps/dashboard/tests/e2e/today.spec.ts (Wave 0 placeholders replaced with real assertions)

tech_stack:
  added: []  # No new libraries — composes existing primitives + drizzle raw-SQL UNION pattern
  patterns:
    - "5-way UNION ALL with today_window CTE (date_trunc 'day' AT TIME ZONE 'Europe/Stockholm')"
    - "Stat-tiles aggregate via 3 SELECT subqueries in a single execute() round-trip"
    - "Channel-health classification: max-age threshold mapping with healthy/degraded/down ladder"
    - "Defensive contract extension via z.array(...).default([]) + z.optional() to keep old payloads parsing"
    - "Runtime re-parse pattern in page.tsx so callApi<T>'s generic-erasure of zod defaults stays correct"

key_files:
  created:
    - apps/dashboard/src/app/(app)/today/StatTileStrip.tsx
    - apps/dashboard/src/app/(app)/today/CapturesList.tsx
    - .planning/phases/11-frontend-rebuild-real-data-wiring-button-audit-mission-contr/11-04-SUMMARY.md
  modified:
    - packages/contracts/src/dashboard.ts (additive: CaptureSourceSchema + TodayCaptureItemSchema + StatTileDataSchema; TodayResponseSchema extended with 3 new fields)
    - services/dashboard-api/src/handlers/today.ts (3 new helpers + Promise.all extension + sequential stat_tiles)
    - services/dashboard-api/tests/today.test.ts (replace 1 skip placeholder with 4 backwards-compat + 4 handler-integration tests)
    - apps/dashboard/src/app/(app)/today/TodayView.tsx (compose StatTileStrip + ChannelHealth strip + CapturesList; preserve SSE + 2-column grid)
    - apps/dashboard/src/app/(app)/today/page.tsx (EMPTY shape includes new defaults; runtime re-parse via TodayResponseSchema)
    - apps/dashboard/tests/e2e/today.spec.ts (4 real assertions replace Wave 0 .skip placeholders)

decisions:
  - "Wave 0 deviation absorbed: CaptureSourceSchema enum is 'email|mention|event|inbox|telegram_queue' (NOT the plan's 'email|capture_text|capture_voice|mention') because capture_text and capture_voice tables do not exist in prod RDS per 11-WAVE-0-SCHEMA-VERIFICATION.md. The UNION runs over the 5 tables that DO hold capture artifacts: email_drafts, mention_events, event_log, inbox_index, telegram_inbox_queue."
  - "ChannelHealthItemSchema NOT redefined — Plan 11-02 owns it in @kos/contracts/dashboard. TodayResponseSchema uses an inline structurally-identical schema because zod schemas evaluate in source order and TodayResponseSchema appears earlier in the file. Both definitions are kept byte-for-byte equivalent."
  - "Channels strip inlined into /today response (option a from plan), not separate /integrations/health fetch (option b). Single round-trip economy: one /today call supplies StatTileStrip + ChannelHealth + everything else."
  - "Channel-health classification thresholds: Telegram (1440min — once per day cadence matches Kevin's Swedish-first usage), Gmail (30min — gmail-poller cron), Granola (60min), Calendar (90min). Down state when no successful run on record OR age > 2× threshold."
  - "page.tsx re-parses callApi result through TodayResponseSchema: zod's input/output type asymmetry causes callApi<T>'s generic to erase .default([])-derived required fields; the explicit re-parse coerces them. Belt-and-suspenders against future schema-default additions."

metrics:
  task_count: 3
  file_count: 2 created / 5 modified
  test_count: 9 new (1 skip→removed, 8 added: 5 contract + 4 handler) — 10 total in today.test.ts, all passing
  total_test_count_dashboard_api: 105 passing
  total_test_count_dashboard: 118 passing + 4 skipped (integration tests requiring infra)
  union_tables_count: 5
  source_enum_size: 5
  stat_tiles_count: 4
  channels_inlined: 4
---

# Phase 11 Plan 11-04: Today Mission-Control Wiring Summary

Extended `/today` to surface ALL of today's captures (5-source UNION instead of email-drafts only), added 4 stat tiles + channel-health strip to the response payload, rewired `TodayView` with the mission-control layout per D-07, and absorbed the Wave 0 deviation (capture_text/capture_voice DO NOT EXIST → UNION runs over the 5 tables that do). Single round-trip /today fetch now supplies everything the dashboard needs. SSE refresh (D-14) preserved end-to-end.

## New /today Payload Sample

The response shape now includes 3 additive sections. Sample shape (redacted IDs):

```json
{
  "brief": null,
  "priorities": [],
  "drafts": [],
  "dropped": [],
  "meetings": [],
  "captures_today": [
    {
      "source": "email",
      "id": "<uuid>",
      "title": "Re: Partnership proposal",
      "detail": "urgent",
      "at": "2026-04-26T09:00:00.000Z"
    },
    {
      "source": "mention",
      "id": "<uuid>",
      "title": "telegram-voice",
      "detail": "Damien said hi",
      "at": "2026-04-26T08:30:00.000Z"
    },
    {
      "source": "event",
      "id": "<uuid>",
      "title": "capture.text",
      "detail": "{...event_log.detail jsonb...}",
      "at": "2026-04-26T08:00:00.000Z"
    }
  ],
  "stat_tiles": {
    "captures_today": 3,
    "drafts_pending": 5,
    "entities_active": 12,
    "events_upcoming": 3
  },
  "channels": [
    { "name": "Telegram", "type": "capture", "status": "healthy", "last_event_at": "2026-04-26T19:40:00.000Z" },
    { "name": "Gmail",    "type": "capture", "status": "healthy", "last_event_at": "2026-04-26T19:30:00.000Z" },
    { "name": "Granola",  "type": "capture", "status": "degraded","last_event_at": "2026-04-26T18:30:00.000Z" },
    { "name": "Calendar", "type": "capture", "status": "down",    "last_event_at": null }
  ]
}
```

`Cache-Control: private, max-age=0, stale-while-revalidate=86400` unchanged from Phase 3.

## Files Modified — LOC delta

| Path | Delta | Role |
|------|------:|------|
| `packages/contracts/src/dashboard.ts` | +62 / 0 | CaptureSourceSchema, TodayCaptureItemSchema, StatTileDataSchema, TodayResponseSchema extended |
| `services/dashboard-api/src/handlers/today.ts` | +229 / -8 | loadCapturesToday + loadStatTiles + loadTodayChannels + Promise.all extension |
| `services/dashboard-api/tests/today.test.ts` | +369 / -21 | Replace 1 skip with 9 real cases (5 contract + 4 handler-integration) |
| `apps/dashboard/src/app/(app)/today/StatTileStrip.tsx` | +62 / 0 | NEW — 4-up mission-control row |
| `apps/dashboard/src/app/(app)/today/CapturesList.tsx` | +159 / 0 | NEW — 5-source today's-capture feed with D-12 empty state |
| `apps/dashboard/src/app/(app)/today/TodayView.tsx` | +52 / -2 | Compose new sections; preserve SSE + 2-column grid |
| `apps/dashboard/src/app/(app)/today/page.tsx` | +14 / -2 | EMPTY shape extension + runtime re-parse |
| `apps/dashboard/tests/e2e/today.spec.ts` | +59 / -18 | Replace 3 .skip placeholders with 4 real assertions |

**Total LOC:** +1,006 / -51 across 8 files (2 new + 6 modified).

## Capture Sources Covered (Wave 0 deviation absorbed)

| Source enum | Backing table | Verified Wave 0 columns | Filter (Stockholm day) |
|-------------|---------------|-------------------------|------------------------|
| `email` | `email_drafts` | `subject`, `draft_subject`, `classification`, `received_at` | `received_at >= d_start` |
| `mention` | `mention_events` | `source`, `context`, `occurred_at` | `occurred_at >= d_start` |
| `event` | `event_log` | `kind`, `detail` jsonb, `occurred_at` | `occurred_at >= d_start` |
| `inbox` | `inbox_index` | `kind`, `preview`, `created_at` | `created_at >= d_start` |
| `telegram_queue` | `telegram_inbox_queue` | `reason`, `body`, `queued_at` | `queued_at >= d_start` |

Plan referenced `capture_text` + `capture_voice` — neither exists in prod RDS (verified via psql `\d+` against bastion + SSM port-forward; see `11-WAVE-0-SCHEMA-VERIFICATION.md` lines 149-156).

## Column-Name Corrections from Wave 0

The plan's example SQL referenced `source_kind`, `body`, `transcript` columns on tables that don't exist. The committed handler uses ONLY columns verified by Wave 0:

- `email_drafts`: `id`, `draft_subject`, `subject`, `classification`, `received_at`, `owner_id`, `status`
- `mention_events`: `id`, `source`, `context`, `occurred_at`, `owner_id`
- `event_log`: `id`, `kind`, `detail` (jsonb), `occurred_at`, `owner_id`
- `inbox_index`: `id`, `kind`, `preview`, `created_at`, `owner_id`
- `telegram_inbox_queue`: `id`, `reason`, `body`, `queued_at`, `owner_id`
- `agent_runs`: `agent_name`, `finished_at`, `status`, `owner_id`
- `entity_index`: `status` (filter `= 'active'`)
- `calendar_events_cache`: `start_utc` (NOT `start_at`), `ignored_by_kevin`, `owner_id`

`grep "WAVE 0 column" services/dashboard-api/src/handlers/today.ts | wc -l` → 0 placeholders left in committed code.

## Channel-Health Classification

`loadTodayChannels` aggregates `agent_runs` by `agent_name` (verified granular enough in Wave 0 — top entries: triage 1641 / voice-capture 27 / granola-poller 20 / transcript-extractor 19) and computes age-vs-threshold:

| Channel | agent_name | max_age_min | Healthy if | Degraded if | Down if |
|---------|------------|-------------|------------|-------------|---------|
| Telegram | `triage` | 1440 (24h) | ≤24h | 24-48h | >48h or no run |
| Gmail | `gmail-poller` | 30 | ≤30m | 30-60m | >60m or no run |
| Granola | `granola-poller` | 60 | ≤60m | 60-120m | >120m or no run |
| Calendar | `calendar-reader` | 90 | ≤90m | 90-180m | >180m or no run |

When a channel has zero successful runs, it renders `down` with `last_event_at: null` (covered by Test 4 — empty-results path).

## Tests Added

| Test File | Cases | Pass |
|-----------|-------|------|
| `today.test.ts` (contract) | 5 (empty/populated/bad-bolag/old-shape backwards-compat/CaptureSource enum guard) | ✓ |
| `today.test.ts` (handler) | 4 (UNION query / stat_tiles aggregate / channel classification / empty defaults) | ✓ |
| `today.spec.ts` (e2e) | 4 real (was 1 active + 3 skipped) — strip count / labels / channel link / captures rows | ✓ (skip when PLAYWRIGHT_BASE_URL unset, real when set) |

Run: `pnpm -F @kos/dashboard-api test -- --run today` → **10 / 10 passing**.
Run: `pnpm -F @kos/dashboard-api test` → **105 / 105 passing** (full suite).
Run: `pnpm -F @kos/dashboard test` → **118 / 118 passing** + 4 todo + 4 skipped infra integration tests.

## Empty-State Compliance (D-12)

Each new section renders informative copy when zero data:

| Section | Empty Copy |
|---------|------------|
| StatTileStrip | All 4 tiles render `0` (calm-by-default — never blank) |
| ChannelHealth strip | `No channels configured` (Plan 11-02 component default) |
| CapturesList | `No captures today — KOS will surface as they arrive.` |

## Commits

| Hash | Type | Subject |
|------|------|---------|
| b7f1325 | test | add failing tests for /today captures_today + stat_tiles + channels |
| a3ade86 | feat | implement /today captures_today + stat_tiles + channels |
| dc37688 | feat | add StatTileStrip + CapturesList components for /today |
| d9b7ad5 | feat | wire TodayView with StatTileStrip + ChannelHealth + CapturesList |

TDD RED → GREEN gate sequence honored: `test(11-04)` commit (b7f1325) precedes the implementing `feat(11-04)` commit (a3ade86). Tasks 2-3 build on the GREEN handler with no further test scaffolding needed — co-located unit tests for the new components were not required by the plan (the e2e suite covers the rendering surface).

## Deviations from Plan

### Wave 0 deviation absorbed (Rule 1 — auto-fix bug)

**1. [Rule 1 — Bug] capture_text / capture_voice tables do not exist**
- **Found during:** Task 1 — pre-execution context review (executor prompt explicitly flagged this)
- **Issue:** Plan body references `capture_text` and `capture_voice` tables in the UNION SQL example. Wave 0 schema verification (`11-WAVE-0-SCHEMA-VERIFICATION.md` lines 149-156) proved neither table exists in prod RDS — the only capture-bearing tables are `event_log`, `inbox_index`, `mention_events`, `telegram_inbox_queue`, and `email_drafts`.
- **Fix:** Replaced the 4-source UNION (email + capture_text + capture_voice + mention) with a 5-source UNION over the verified tables. Updated `CaptureSourceSchema` enum to `email | mention | event | inbox | telegram_queue` and updated SOURCE_ICON / SOURCE_LABEL maps in `CapturesList.tsx` accordingly.
- **Files modified:** `packages/contracts/src/dashboard.ts`, `services/dashboard-api/src/handlers/today.ts`, `services/dashboard-api/tests/today.test.ts`, `apps/dashboard/src/app/(app)/today/CapturesList.tsx`
- **Commit:** b7f1325 (contracts + tests) + a3ade86 (handler) + dc37688 (CapturesList)

### Auto-fixed Issues (Rule 2 + Rule 3)

**2. [Rule 3 — Blocking] page.tsx EMPTY shape no longer matched extended TodayResponseSchema**
- **Found during:** Task 2 typecheck verify (`pnpm -F @kos/dashboard typecheck`)
- **Issue:** My Task 1 contract change added `captures_today: z.array(...).default([])` and `channels: z.array(...).default([])` — both emerge as required on the parsed-output type. The pre-existing `EMPTY: TodayResponse` literal omitted them, so dashboard typecheck failed with TS2739.
- **Fix:** Extended EMPTY with `captures_today: []` and `channels: []`. Also added a runtime re-parse of `callApi`'s result through `TodayResponseSchema.parse()` because zod's `ZodSchema<T>` generic erases the input/output asymmetry of `.default([])`-derived defaults — without the re-parse, callApi's typed return treats `channels` as optional, which trips assignment to the post-parse `TodayResponse` type.
- **Files modified:** `apps/dashboard/src/app/(app)/today/page.tsx`
- **Commit:** d9b7ad5

**3. [Rule 2 — Missing critical functionality] CapturesList aria-labelledby + decorative icon aria-hidden**
- **Found during:** Task 2 component design review
- **Issue:** D-11 keyboard floor + accessibility hygiene requires that screen readers announce only meaningful content. The source-icon and the `count-chip` were both decorative.
- **Fix:** `<Icon ... aria-hidden />` and `<span className="count-chip" aria-hidden>{count}</span>`. The section uses `aria-labelledby="captures-h"` pointing at the visible heading. Same pattern as Plan 11-02's Pill component.
- **Files modified:** `apps/dashboard/src/app/(app)/today/CapturesList.tsx`
- **Commit:** dc37688

### No Other Deviations

The 3 tasks otherwise executed exactly as written in `11-04-PLAN.md`. The plan's 4-source UNION example was upgraded to 5-source (capture_text and capture_voice replaced by event_log + inbox_index + telegram_inbox_queue) — the structural pattern was preserved; only the source-table identities changed.

### Pre-existing typecheck issue resolved by parallel plan

The plan's Task 2 acceptance criterion `pnpm -F @kos/dashboard typecheck exits 0` originally failed due to a pre-existing error in `apps/dashboard/src/components/dashboard/ChannelHealth.tsx:76` (Next.js typed-routes error: `/integrations-health` route did not yet exist). This was tracked in `deferred-items.md` from Plan 11-05's execution and was resolved during this plan's runtime by Plan 11-06 commits (`340893f feat(11-06): build /integrations-health page` and `9bcab6b feat(11-06): add Health nav entry`) which materialized the route. Final typecheck after my last commit is clean.

## Threat Model Compliance

All four threats from PLAN frontmatter `<threat_model>` resolved or mitigated as designed:

- **T-11-04-01 (Information disclosure via captures_today body text):** `accept` — single-user dashboard, only Kevin sees his own captures. CapturesList truncates `detail` to 120 chars (`cap.detail.slice(0, 120)`). Full content stays behind the existing entity-detail auth boundary.
- **T-11-04-02 (Tampering via UNION over drifted-shape table):** `mitigate` — Wave 0 verified column names. Acceptance criterion `grep "WAVE 0 column" today.ts` returns 0; CI typecheck catches any zod-parse mismatch.
- **T-11-04-03 (DoS via UNION over 4 tables):** `mitigate` — `LIMIT 100` on the UNION; `today_window` CTE prunes rows to the current Stockholm day before UNION. Existing indexes on `(owner_id, created_at)`, `(owner_id, received_at)`, `(owner_id, occurred_at)` (verified in migrations 0001 + 0010). Cache-control SWR 86400s preserved.
- **T-11-04-04 (Elevation via missing owner_id):** `mitigate` — every new SELECT includes `WHERE owner_id = ${OWNER_ID}::uuid`. Defense-in-depth — if Lambda auth is ever loosened, SQL still scopes correctly.

## Self-Check: PASSED

Verified post-write:

```text
[ -f services/dashboard-api/src/handlers/today.ts ]              → FOUND (extended)
[ -f services/dashboard-api/tests/today.test.ts ]                → FOUND (extended)
[ -f packages/contracts/src/dashboard.ts ]                       → FOUND (extended)
[ -f apps/dashboard/src/app/(app)/today/StatTileStrip.tsx ]      → FOUND (new)
[ -f apps/dashboard/src/app/(app)/today/CapturesList.tsx ]       → FOUND (new)
[ -f apps/dashboard/src/app/(app)/today/TodayView.tsx ]          → FOUND (modified)
[ -f apps/dashboard/src/app/(app)/today/page.tsx ]               → FOUND (modified)
[ -f apps/dashboard/tests/e2e/today.spec.ts ]                    → FOUND (modified)

git log --oneline | grep b7f1325 → FOUND (RED commit)
git log --oneline | grep a3ade86 → FOUND (GREEN handler commit)
git log --oneline | grep dc37688 → FOUND (Task 2 components commit)
git log --oneline | grep d9b7ad5 → FOUND (Task 3 wiring commit)
```

All 5 acceptance criteria from `<acceptance_criteria>` met (Tasks 1+2+3):

```text
grep -c "UNION ALL" services/dashboard-api/src/handlers/today.ts     → 4 (>= 3 ✓)
grep -c "loadCapturesToday\|loadStatTiles\|loadTodayChannels"        → 6 (>= 6 ✓)
grep "captures_today" packages/contracts/src/dashboard.ts | wc -l    → 3 (>= 3 ✓)
grep "TodayCaptureItemSchema\|StatTileDataSchema" contracts.ts | wc  → 6 (>= 4 ✓)
grep "Phase 11" today.ts | wc -l                                      → 4 (>= 1 ✓)
grep "WAVE 0 column" today.ts | wc -l                                 → 0 (= 0 ✓)
grep "data-testid=\"stat-tile-strip\"" StatTileStrip.tsx | wc -l     → 1 (✓)
grep -E "captures-list(-empty)?" CapturesList.tsx | wc -l            → 2 (✓)
grep -c "<StatTile " StatTileStrip.tsx                                → 4 (✓)
grep "data-testid=\"channel-health-strip\"" TodayView.tsx | wc -l    → 1 (✓)
pnpm -F @kos/dashboard-api test                                       → 105/105 ✓
pnpm -F @kos/dashboard-api typecheck                                  → exit 0 ✓
pnpm -F @kos/dashboard typecheck                                      → exit 0 ✓
pnpm -F @kos/dashboard test                                           → 118/118 ✓
```
