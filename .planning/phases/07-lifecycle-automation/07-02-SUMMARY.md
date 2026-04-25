---
phase: 07-lifecycle-automation
plan: 02
subsystem: day-close + weekly-review
tags: [auto-03, auto-04, day-close, weekly-review, sonnet-tool-use, kevin-context-update]
requires:
  - "Plan 07-00: scaffold (services/day-close + services/weekly-review workspaces, brief-renderer signatures, DayCloseBriefSchema + WeeklyReviewSchema, integrations-lifecycle.ts helper)"
  - "Plan 07-01: services/_shared/brief-renderer.ts full bodies + morning-brief reference implementation (handler/agent/persist/notion shape)"
  - "Phase 6: @kos/context-loader::loadContext + @kos/azure-search hybridQuery"
  - "Phase 1: SafetyStack outputBus + push-telegram cap enforcement"
provides:
  - "services/day-close/src/{handler,agent,persist,notion}.ts — AUTO-03 end-to-end Lambda"
  - "services/weekly-review/src/{handler,agent,persist,notion}.ts — AUTO-04 end-to-end Lambda"
  - "appendKevinContextSections (services/day-close/src/notion.ts) — append-only Recent decisions + Slipped items writer"
  - "replaceActiveThreadsSection (services/weekly-review/src/notion.ts) — overwrite the Active Threads heading_2 section on Kevin Context"
  - "CDK day-close schedule (cron 0 18 ? * MON-FRI * Stockholm) + weekly-review schedule (cron 0 19 ? * SUN * Stockholm) + paired IAM grants on integrations-lifecycle.ts"
affects:
  - "Phase 7 SC 2 (Daily Brief Log accretes morning + day-close + weekly-review entries) reachable end-to-end."
  - "Plan 07-04 (verify-notification-cap) treats every weekday as 3 brief invocations (morning + day-close + cap-budget headroom) and Sunday as 1 (weekly-review)."
tech-stack:
  added:
    - "@kos/azure-search workspace dep on services/day-close + services/weekly-review (handler imports hybridQuery wrapper for loadContext)"
  patterns:
    - "Three-brief shared shape: same orchestrator pipeline (idempotency claim → loadContext → Sonnet tool_use → Promise.allSettled Notion side-effects → ONE output.push) — only schemas, prompts, and Notion targets differ."
    - "Active Threads section detection: heading_2 plain_text starts with 'active threads' (case-insensitive); archive everything from that heading inclusive up to (but excluding) the next heading_2; non-destructive append-at-end fallback when section absent."
    - "Day-close decisions hint via mention_events.context regex (decided|approved|signed|agreed|godkänd|beslutad) over last 12h — best-effort heuristic; Sonnet infers when query empty."
    - "Weekly-review week window = inclusive 7 days ending today (today - 6d → today, Stockholm). Half-open SQL ranges use weekEndExclusive = today + 1d for clean date arithmetic."
key-files:
  created:
    - "services/day-close/src/agent.ts (283 lines)"
    - "services/day-close/src/handler.ts (338 lines, replaces 11-line scaffold)"
    - "services/day-close/src/notion.ts (208 lines)"
    - "services/day-close/src/persist.ts (254 lines)"
    - "services/day-close/test/agent.test.ts (101 lines, 3 tests)"
    - "services/day-close/test/handler.test.ts (195 lines, 2 tests)"
    - "services/day-close/test/persist.test.ts (81 lines, 4 tests)"
    - "services/weekly-review/src/agent.ts (237 lines)"
    - "services/weekly-review/src/handler.ts (308 lines, replaces 10-line scaffold)"
    - "services/weekly-review/src/notion.ts (194 lines)"
    - "services/weekly-review/src/persist.ts (200 lines)"
    - "services/weekly-review/test/agent.test.ts (96 lines, 3 tests)"
    - "services/weekly-review/test/handler.test.ts (178 lines, 2 tests)"
    - "services/weekly-review/test/notion.test.ts (129 lines, 3 tests)"
    - "services/weekly-review/test/persist.test.ts (69 lines, 3 tests)"
  modified:
    - "services/day-close/package.json (added @kos/azure-search workspace dep)"
    - "services/weekly-review/package.json (added @kos/azure-search workspace dep)"
    - "packages/cdk/lib/stacks/integrations-lifecycle.ts (+109 lines: env wiring, IAM grants loop, day-close + weekly-review schedules)"
    - "packages/cdk/test/integrations-lifecycle.test.ts (+6 tests for Plan 07-02)"
    - "pnpm-lock.yaml (regenerated for new workspace dep)"
decisions:
  - "Day-close handler ordering for Notion side-effects: replaceTodayPageBlocks + appendDailyBriefLogPage + appendKevinContextSections all run inside ONE Promise.allSettled. Each one is independently best-effort — partial failure recorded but Telegram still fires. Plan suggested sequential 1→2→3→4 which is functionally equivalent but strictly less parallel; the parallel form matches morning-brief precedent."
  - "mention_events column for decisions hint is `context` (per migration 0001), NOT `text_content` as some plan drafts hinted. Plan annotation about email_drafts fallback is no longer needed for day-close — we read from mention_events only. Decisions hint returns [] when no rows match; handler renders a placeholder hint and Sonnet infers from broader context."
  - "Weekly-review week window simplification: plan suggested computing dow via locale-string slice arithmetic; we use 'last 7 days inclusive of today' (today - 6 days → today). Acceptable simplification per the plan's explicit allowance ('Acceptable simplification: weekly review = last 7 days inclusive of today.'). Half-open SQL ranges use weekEndExclusive = today + 1d."
  - "Active Threads detection rule (T-07-WEEKLY-01 mitigation): heading_2 plain_text starts with 'active threads' (case-insensitive). Implementation walks linearly; once a section heading is found, archive accumulates until the NEXT heading_2 is encountered. Three notion.test.ts fixtures cover: section in middle (archive only middle), no existing section (append-at-end fallback, no archives), section at end of page (archive everything to end of page)."
  - "loadHotEntities is duplicated in services/day-close/src/persist.ts (12h interval) and services/weekly-review/src/persist.ts (7-day interval, daysBack/days unit) rather than centralizing into a shared module. Each Lambda inspects its own intent (12h for day-close vs 7 days for weekly) and the shape divergence (hours-back int vs days-back int) made factoring risky. Future Phase 9 cleanup may consolidate into _shared/hot-entities.ts."
  - "WeeklyReviewSchema has no top_three field (D-05): persist module deliberately omits writeTop3Membership; the schema-conformance test enforces this so a future Phase 9 schema bump can't silently drop the assertion."
  - "WeeklyReview Lambda env intentionally OMITS NOTION_TODAY_PAGE_ID — the weekly review never overwrites the 🏠 Today page (only morning + day-close do). DayClose env still includes NOTION_TODAY_PAGE_ID since day-close DOES overwrite 🏠 Today (the plan's required Notion ordering)."
  - "Plan suggested optional refactor of replaceTodayPageBlocks + appendDailyBriefLogPage into services/_shared/notion-blocks.ts. Skipped — the duplication is small (~120 lines per service) and the call sites differ slightly (day-close has appendKevinContextSections in the same file). Inline keeps service folders self-contained with zero new shared module."
metrics:
  duration_minutes: 19
  completed_date: "2026-04-25"
  tasks_completed: 3
  files_changed: 17
  tests_added: 20
  tests_passing: 20
  cdk_tests_passing: 17
---

# Phase 7 Plan 02: Day-Close + Weekly-Review Briefs Summary

End-to-end implementation of AUTO-03 (day-close) and AUTO-04 (weekly-review) Lambdas. Both fire on EventBridge Scheduler with Stockholm-native cron expressions; both invoke Sonnet 4.6 once via Bedrock `tool_use` and emit a single `output.push` to `kos.output` (counted as 1-of-3 daily Telegram cap). Day-close additionally appends Recent decisions + Slipped items to the Kevin Context page (append-only); weekly-review overwrites the existing "Active threads" section on Kevin Context (replace-in-place via heading_2 detection).

## What Got Built

### Task 1 — Day-close Lambda (commits `aef948b` RED, `fe4079e` GREEN)

Four source files (1083 lines total) + three test files (377 lines, 9 tests). All pass.

- **`src/agent.ts` (283 lines):** Single Bedrock invocation forced via `tool_choice='record_day_close_brief'`. EU inference profile `eu.anthropic.claude-sonnet-4-6-20250929-v1:0`. Three system-prompt segments (BASE + Kevin Context + dossier markdown), every segment `cache_control:ephemeral`. Hand-written JSON Schema mirrors `DayCloseBriefSchema`. Safe-fallback brief on no-tool-use OR Zod parse failure.
- **`src/persist.ts` (254 lines):** RDS Proxy IAM-auth pool. Helpers: `getPool`, `insertAgentRunStarted` (SELECT-before-INSERT idempotency claim, identical pattern to morning-brief — agent_runs has no UNIQUE constraint), `updateAgentRunSuccess`, `updateAgentRunError`, `writeTop3Membership` (DayCloseBriefSchema HAS top_three per D-05; one row per `top_three[i].entity_ids[j]` pair), `loadHotEntities` (12h interval — distinct from morning's 48h), `loadSlippedItemsForToday` (top3_membership where brief_kind='morning-brief' AND brief_date=today AND acted_on_at IS NULL), `loadDecisionsHint` (regex over `mention_events.context` for `(decided|approved|signed|agreed|godkänd|beslutad)` over last 12h).
- **`src/notion.ts` (208 lines):** `replaceTodayPageBlocks` (semaphore-3 archive pacing for Notion 3 RPS) + `appendDailyBriefLogPage` + new **`appendKevinContextSections`** — append-only writes two heading_2 sections "Recent decisions (YYYY-MM-DD)" and "Slipped items (YYYY-MM-DD)" with bulleted_list_item children. NEVER archives existing Kevin Context content.
- **`src/handler.ts` (338 lines):** Full orchestration. `ulid()` capture_id → `tagTraceWithCaptureId` → idempotency claim → parallel (`loadContext` via `@kos/azure-search` `hybridQuery` injection + `loadSlippedItemsForToday` + `loadDecisionsHint`) → `runDayCloseAgent` → **`writeTop3Membership` BEFORE outbound side-effects** (durable record) → Promise.allSettled on three Notion writes (🏠 Today / Daily Brief Log / Kevin Context) → ONE `output.push` to `kos.output` → `updateAgentRunSuccess`. Error path: `updateAgentRunError` + emit `kos.system / brief.generation_failed` + return `{ status: 'error' }` without throwing.

**Tests (9 pass):**
- `agent.test.ts` (3): valid tool_use parsing, garbage Bedrock output safe fallback, 3 cache_control:ephemeral system segments + tool_choice forced.
- `persist.test.ts` (4): `loadSlippedItemsForToday` SQL shape + empty-result handling, `loadDecisionsHint` regex SQL + empty-result handling.
- `handler.test.ts` (2): happy-path orchestration with Kevin Context append, Kevin Context append rejection still fires Telegram (best-effort).

### Task 2 — Weekly-review Lambda (commits `e6f8038` RED, `d9ad547` GREEN)

Four source files (939 lines total) + four test files (472 lines, 11 tests). All pass.

- **`src/agent.ts` (237 lines):** Single Bedrock invocation forced via `tool_choice='record_weekly_review'`. Same Sonnet 4.6 EU profile + 3-segment cached system prompt. Hand-written JSON Schema mirrors `WeeklyReviewSchema`. Safe-fallback review on no-tool-use OR Zod parse failure.
- **`src/persist.ts` (200 lines):** RDS Proxy IAM-auth pool. **NO `writeTop3Membership`** (WeeklyReviewSchema has no `top_three` per D-05). Helpers: `insertAgentRunStarted` / `updateAgentRunSuccess` / `updateAgentRunError`, `loadHotEntities` (7-day interval, top 20 — D-17 weekly), `loadWeekRecapHint` (UNION ALL aggregating `mention_events` + `email_drafts` + `agent_runs WHERE agent_name='morning-brief' status='ok'` + `agent_runs WHERE agent_name='day-close' status='ok'` over the week window). SQLSTATE 42P01 graceful degrade returns `[]` when `email_drafts` table is missing (Phase-4 dependency).
- **`src/notion.ts` (194 lines):** `appendDailyBriefLogPage` + **`replaceActiveThreadsSection`** — walks Kevin Context page, finds the "Active threads" heading_2 block (case-insensitive `startsWith` match), archives that heading + every block until the NEXT heading_2 (or end of page), then appends a fresh "Active threads" section. **Non-destructive append-at-end fallback when no existing section detected.** Semaphore-3 paces archive PATCHes for Notion 3 RPS.
- **`src/handler.ts` (308 lines):** Full orchestration. Computes inclusive 7-day window (today - 6d → today, Stockholm). Parallel `loadHotEntities` + `loadWeekRecapHint`; sequential `loadContext` (depends on entityIds from hot); `runWeeklyReviewAgent` → Promise.allSettled on `replaceActiveThreadsSection` + `appendDailyBriefLogPage` → ONE `output.push` to `kos.output` (Sunday 1-of-3 cap) → `updateAgentRunSuccess`.

**Tests (11 pass):**
- `agent.test.ts` (3): valid tool_use parsing, garbage Bedrock output safe fallback, schema-conformance assertion that WeeklyReviewSchema does NOT include `top_three` / `dropped_threads`.
- `persist.test.ts` (3): `loadWeekRecapHint` UNION ALL SQL shape + Phase-4 graceful degrade, `writeTop3Membership` symbol absent (no top_three field).
- `handler.test.ts` (2): happy-path orchestration for 7-day rollup, `replaceActiveThreadsSection` rejection still fires Telegram.
- `notion.test.ts` (3): replaceActiveThreadsSection T-07-WEEKLY-01 mitigation — section in middle (archive only middle), no existing section (append-at-end fallback, no archives), section at end of page (archive to end).

### Task 3 — CDK schedules + IAM grants (commit `2c4d913`)

`packages/cdk/lib/stacks/integrations-lifecycle.ts` (+109 lines):

- **DayClose env vars** added after Lambda construction: `NOTION_TODAY_PAGE_ID`, `NOTION_DAILY_BRIEF_LOG_DB_ID`, `NOTION_KEVIN_CONTEXT_PAGE_ID`, `DASH_URL`. Sourced from `loadNotionIds()` (from `_notion-ids.ts`).
- **WeeklyReview env vars** added: `NOTION_DAILY_BRIEF_LOG_DB_ID`, `NOTION_KEVIN_CONTEXT_PAGE_ID`, `DASH_URL`. **Intentionally omits `NOTION_TODAY_PAGE_ID`** — weekly never overwrites 🏠 Today.
- **Loop-shared IAM grants** for both Lambdas per D-12: `bedrock:InvokeModel` on `eu.anthropic.claude-sonnet-4-6*` inference profile + foundation-model fan-out; `rds-db:connect` on `kos_admin`; `notionTokenSecret.grantRead`; `azureSearchAdminSecret.grantRead`; `outputBus.grantPutEventsTo`; `systemBus.grantPutEventsTo`. **Explicitly NO `ses:*`** — briefs do not send email.
- **DayClose schedule** `day-close-weekdays-18`: `cron(0 18 ? * MON-FRI *)` Europe/Stockholm, `flexibleTimeWindow: OFF`, `state: ENABLED`. Target = DayClose Lambda functionArn; input = `{ kind: 'day-close' }`.
- **WeeklyReview schedule** `weekly-review-sun-19`: `cron(0 19 ? * SUN *)` Europe/Stockholm, `flexibleTimeWindow: OFF`, `state: ENABLED`. Target = WeeklyReview Lambda functionArn; input = `{ kind: 'weekly-review' }`.
- Both schedules call `grantInvoke(schedulerRole)` on the shared LifecycleSchedulerRole.

`packages/cdk/test/integrations-lifecycle.test.ts` — 6 new Plan 07-02 tests (total 17 pass):
1. DayClose IAM has Bedrock + RDS.
2. WeeklyReview IAM has Bedrock + RDS.
3. DayClose env carries `NOTION_KEVIN_CONTEXT_PAGE_ID` + `NOTION_TODAY_PAGE_ID` + `NOTION_DAILY_BRIEF_LOG_DB_ID`.
4. WeeklyReview env carries `NOTION_KEVIN_CONTEXT_PAGE_ID` + `NOTION_DAILY_BRIEF_LOG_DB_ID`.
5. CfnSchedule `day-close-weekdays-18` cron + Stockholm + OFF + ENABLED.
6. CfnSchedule `weekly-review-sun-19` cron + Stockholm + OFF + ENABLED.

## Sonnet Token Estimates per Brief

Sonnet 4.6 input pricing $3/M tokens, output $15/M tokens.

**Day-close per run:**
- Kevin Context block ~3k tokens
- Assembled dossier markdown (top-10 hot entities, 12h window) ~5k tokens
- User prompt (hot summary + slipped hint + decisions hint) ~1.5k tokens
- Input total: ~9.5k tokens × $3/M = **$0.029**
- Output (DayCloseBrief with ≤3 Top 3 + ≤5 slipped + ≤5 decisions + ≤10 threads delta + prose ≤600 chars) ~1.2k tokens × $15/M = **$0.018**
- **Per-run cost: ~$0.047** (matches morning-brief envelope).

**Weekly-review per run:**
- Kevin Context block ~3k tokens
- Assembled dossier markdown (top-20 hot entities, 7-day window) ~8k tokens
- User prompt (week recap hint + active threads hint) ~1k tokens
- Input total: ~12k tokens × $3/M = **$0.036**
- Output (WeeklyReview with ≤10 recap + ≤7 candidates + ≤20 snapshot + prose ≤1000 chars) ~1.8k tokens × $15/M = **$0.027**
- **Per-run cost: ~$0.063** (slightly above morning brief; larger context + larger output).

**Volume:** Day-close 5/week × 4 = 20/mo ≈ **$0.94/mo**. Weekly-review 4/mo ≈ **$0.25/mo**. Combined Plan 07-02 cost: **~$1.19/mo** added to Plan 07-01's $0.96/mo. Phase 7 total trending at ~$2.15/mo Bedrock — well under D-19 $5/mo envelope.

Cache impact: Sonnet sees the same BASE prompt + Kevin Context block on day-close and morning-brief same-day. Cache TTL is 5 min so the same-day morning→day-close gap (10 hours) won't hit cache, but consecutive briefs within a single test run will. Day-close → next-morning-brief is also 14h apart — no cache reuse expected in steady state.

## Notion Replace-Section Semantics (Active Threads)

The weekly-review's `replaceActiveThreadsSection` walks Kevin Context page children once and applies this rule:

```
For each block in children:
  if block.type === 'heading_2':
    text = block.heading_2.rich_text[0].plain_text.lowercased()
    if text.startsWith('active threads'):
      inSection = true
      toArchive.append(block.id)        ← include the heading itself
      continue
    if inSection:
      inSection = false
      break                              ← stop at next heading_2
  if inSection:
    toArchive.append(block.id)           ← accumulate body blocks
```

After collection: archive every block in `toArchive` (semaphore-3 pacing for Notion 3 RPS), then `blocks.children.append` a fresh `[heading_2 'Active threads', ...bullets]`.

**Edge cases tested in notion.test.ts:**
1. Section in middle (`Current priorities → Active threads → Recent decisions`): only `Active threads` heading + its bullets archived; other sections untouched.
2. No "Active threads" heading anywhere: `toArchive` stays empty; we skip the archive Promise.all and append the new section at the end (non-destructive fallback).
3. Section at end of page (no following heading_2): archive accumulates to end of page; new section appends fresh.

**Detection caveat:** Notion's `blocks.children.list` paginates at 100 children per page. Kevin Context is single-pager today (~30 blocks). If it grows >100 blocks, the trailing tail of the page won't be inspected — the section detection still finds the heading correctly within the first 100 but archived blocks following the heading might be miss-counted if they spill across pagination. Documented as a Phase-9 follow-up; non-blocking for v1.

## D-18 Quiet-Hours Invariant

Both schedules fire OUTSIDE the 20:00–08:00 quiet-hours window:
- **Day-close** at 18:00 Stockholm — `isQuietHour(18)` returns false.
- **Weekly-review** at 19:00 Stockholm — `isQuietHour(19)` returns false.

D-18 (which forced the morning-brief from 07:00 → 08:00 to honor the invariant) does NOT apply to either Plan 07-02 schedule. `output.push` events land directly without queueing to `telegram_inbox_queue`.

## Active Threads Append-At-End Fallback

When `replaceActiveThreadsSection` finds NO existing "Active threads" heading on Kevin Context, it skips the archive step entirely and appends the new section at the end of the page. This is **non-destructive**: every existing block on Kevin Context is preserved. After the first weekly review run on a fresh page, the section exists; from then on every subsequent run replaces in place.

## Operator Pre-Deploy Runbook (additions to 07-01's runbook)

Before `cdk deploy` for AUTO-03 + AUTO-04:

1. **No new Notion IDs needed beyond Plan 07-01.** Day-close + weekly-review reuse `todayPage` + `dailyBriefLog` + `kevinContext` keys already required for morning-brief.
2. **Confirm Kevin Context page exists** in Notion and has at least one block — empty pages won't crash `replaceActiveThreadsSection` but the first weekly run will append at end and from then on the section is always present.
3. **Confirm Daily Brief Log DB has `Type` select** with options `morning-brief`, `day-close`, `weekly-review`. Notion auto-creates options on first append, so first day-close / weekly run will create them if absent — but pre-creating is cleaner for dashboard filters.
4. **Confirm Notion integration has access to Kevin Context page** (Notion permissions are per-page; the morning-brief integration token must also have access to Kevin Context for day-close + weekly-review to write).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 – Bug] mention_events column for decisions hint: `text_content` → `context`**
- **Found during:** Task 1 persist.ts design.
- **Issue:** Plan's `loadDecisionsHint` SQL referenced `text_content` column. Migration 0001 defines `mention_events.context` (not `text_content`); the plan annotation about this was visible in the `<action>` block. Without the fix the query would error at runtime with `column "text_content" does not exist`.
- **Fix:** Use `context` column directly. Updated the test to assert the SQL contains `mention_events` and the regex for decision verbs.
- **Files modified:** `services/day-close/src/persist.ts`, `services/day-close/test/persist.test.ts`.
- **Commit:** `fe4079e`.

**2. [Rule 2 – Missing critical functionality] Weekly-review Phase-4 graceful degrade**
- **Found during:** Task 2 persist.ts design.
- **Issue:** `loadWeekRecapHint` queries `email_drafts`. Phase 4 hasn't shipped its schema — first weekly-review invocation would throw `relation "email_drafts" does not exist` and abort the entire UNION ALL.
- **Fix:** Catch pg SQLSTATE `42P01` → return `[]`. Handler renders a placeholder "(week recap hint unavailable — Phase 4 schema not yet present)" hint and Sonnet still produces a review from Kevin Context + dossier markdown alone. Mirrors the Plan 07-01 morning-brief drafts-ready degrade.
- **Files modified:** `services/weekly-review/src/persist.ts`, `services/weekly-review/test/persist.test.ts`.
- **Commit:** `d9ad547`.

**3. [Rule 1 – Bug] DayClose env var `NOTION_KEVIN_CONTEXT_PAGE_ID` was missing in Plan 07-00 stub**
- **Found during:** Task 3 CDK wiring.
- **Issue:** Plan 07-00's `wireLifecycleAutomation` constructed `dayClose` and `weeklyReview` Lambdas with only `commonEnv` (no `NOTION_KEVIN_CONTEXT_PAGE_ID`). The Plan 07-02 handler reads this env var for both Lambdas; without it the Lambda would crash at first invocation.
- **Fix:** Added `NOTION_KEVIN_CONTEXT_PAGE_ID: notionIds.kevinContext` to both day-close and weekly-review Lambda environments. Also added `NOTION_TODAY_PAGE_ID` to day-close (overwrites 🏠 Today) and `NOTION_DAILY_BRIEF_LOG_DB_ID` + `DASH_URL` to both. Plan 07-00 implicitly anticipated this ("Notion *_PAGE_ID + *_DB_ID env vars are added by Plans 07-01..07-02").
- **Files modified:** `packages/cdk/lib/stacks/integrations-lifecycle.ts`.
- **Commit:** `2c4d913`.

**4. [Rule 3 – Blocking] @kos/azure-search workspace dep added to both services**
- **Found during:** Task 1 + Task 2 GREEN typecheck.
- **Issue:** Both handlers import `hybridQuery` from `@kos/azure-search` (mirroring morning-brief Plan 07-01 wiring). Neither package.json from Plan 07-00 listed this workspace dep. Typecheck would fail module-not-found.
- **Fix:** Added `@kos/azure-search: workspace:*` to both `services/day-close/package.json` and `services/weekly-review/package.json`. `pnpm install` regenerated lockfile.
- **Files modified:** both `package.json`, `pnpm-lock.yaml`.
- **Commits:** `fe4079e` + `d9ad547`.

No architectural changes (Rule 4). No checkpoints triggered. No human-action gates.

## TDD Gate Compliance

Both Tasks 1 and 2 followed RED → GREEN cycles per `tdd="true"` frontmatter:

- **Task 1 (day-close):** RED `aef948b` (`test(07-02): add failing tests for day-close agent, persist, handler`) → GREEN `fe4079e` (`feat(07-02): implement day-close Lambda end-to-end (AUTO-03)`).
- **Task 2 (weekly-review):** RED `e6f8038` (`test(07-02): add failing tests for weekly-review agent, persist, handler, notion`) → GREEN `d9ad547` (`feat(07-02): implement weekly-review Lambda end-to-end (AUTO-04)`).
- **Task 3 (CDK):** Plan declared `type="auto"` (no TDD frontmatter); shipped as `2c4d913` with tests + impl together. CDK tests added alongside the source change.
- No REFACTOR phase needed.

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| `services/day-close test/agent.test.ts` | 3 | All pass |
| `services/day-close test/persist.test.ts` | 4 | All pass |
| `services/day-close test/handler.test.ts` | 2 | All pass |
| `services/day-close — full pnpm test` | 9 | All pass |
| `services/weekly-review test/agent.test.ts` | 3 | All pass |
| `services/weekly-review test/persist.test.ts` | 3 | All pass |
| `services/weekly-review test/handler.test.ts` | 2 | All pass |
| `services/weekly-review test/notion.test.ts` | 3 | All pass |
| `services/weekly-review — full pnpm test` | 11 | All pass |
| `packages/cdk integrations-lifecycle.test.ts` | 17 | All pass |
| `pnpm --filter @kos/service-day-close typecheck` | — | Clean |
| `pnpm --filter @kos/service-weekly-review typecheck` | — | Clean |
| `pnpm --filter @kos/cdk typecheck` | — | Clean |

## Threat Flags

None — Plan 07-02 surface (EventBridge Scheduler → Lambda → Bedrock + RDS + Notion + EventBridge) was fully covered by 07-02-PLAN.md `<threat_model>` (T-07-DAYCLOSE-01..02, T-07-WEEKLY-01..03). The replaceActiveThreadsSection over-archive risk (T-07-WEEKLY-01) is mitigated via case-insensitive `startsWith('active threads')` detection + non-destructive append-at-end fallback + 3-fixture test coverage.

## Self-Check

- **Files exist on disk:**
  - `services/day-close/src/agent.ts` — FOUND (283 lines)
  - `services/day-close/src/handler.ts` — FOUND (338 lines)
  - `services/day-close/src/notion.ts` — FOUND (208 lines)
  - `services/day-close/src/persist.ts` — FOUND (254 lines)
  - `services/day-close/test/agent.test.ts` — FOUND
  - `services/day-close/test/handler.test.ts` — FOUND
  - `services/day-close/test/persist.test.ts` — FOUND
  - `services/weekly-review/src/agent.ts` — FOUND (237 lines)
  - `services/weekly-review/src/handler.ts` — FOUND (308 lines)
  - `services/weekly-review/src/notion.ts` — FOUND (194 lines)
  - `services/weekly-review/src/persist.ts` — FOUND (200 lines)
  - `services/weekly-review/test/agent.test.ts` — FOUND
  - `services/weekly-review/test/handler.test.ts` — FOUND
  - `services/weekly-review/test/notion.test.ts` — FOUND
  - `services/weekly-review/test/persist.test.ts` — FOUND
  - `packages/cdk/lib/stacks/integrations-lifecycle.ts` — MODIFIED
  - `packages/cdk/test/integrations-lifecycle.test.ts` — MODIFIED
- **Commits in git log:** `aef948b`, `fe4079e`, `e6f8038`, `d9ad547`, `2c4d913` — all FOUND.

## Self-Check: PASSED
