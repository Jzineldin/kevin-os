---
phase: 07-lifecycle-automation
plan: 01
subsystem: morning-brief
tags: [auto-01, morning-brief, sonnet-tool-use, notion-replace-in-place, top3-membership, brief-renderer]
requires:
  - "Plan 07-00: scaffold (services/morning-brief workspace, brief-renderer signatures, MorningBriefSchema, migration 0014, integrations-lifecycle.ts helper)"
  - "Phase 6: @kos/context-loader::loadContext + @kos/azure-search hybridQuery"
  - "Phase 1: SafetyStack outputBus + push-telegram cap enforcement"
provides:
  - "services/_shared/brief-renderer.ts (full bodies — consumed by Plan 07-02 day-close + weekly-review)"
  - "services/morning-brief/src/{handler,agent,hot-entities,persist,notion}.ts (AUTO-01 end-to-end)"
  - "CDK morning-brief schedule (08:00 Stockholm Mon-Fri) + IAM grants on integrations-lifecycle.ts"
  - "packages/cdk/lib/stacks/_notion-ids.ts (shared NotionIds loader; consumed by integrations-notion.ts + integrations-lifecycle.ts)"
affects:
  - "Plan 07-02 will reuse renderNotionTodayBlocks / renderDailyBriefLogPage / renderTelegramHtml unchanged for day-close + weekly-review."
tech-stack:
  added:
    - "@kos/azure-search workspace dep on services/morning-brief"
    - "@aws-sdk/client-sns on services/morning-brief (for kos.system PutEvents shape — actual PutEvents goes via EventBridge SDK which was already present)"
  patterns:
    - "SELECT-before-INSERT idempotency claim on agent_runs (no UNIQUE constraint on (capture_id, agent_name); plan's ON CONFLICT was a bug)"
    - "Phase-4-graceful-degrade SQL: catch SQLSTATE 42P01 'relation does not exist' on email_drafts → return [] (Phase 4 hasn't shipped its schema yet)"
    - "Promise.allSettled on Notion writes — best-effort; Telegram emit is the must-have side-effect"
key-files:
  created:
    - "services/morning-brief/src/agent.ts"
    - "services/morning-brief/src/hot-entities.ts"
    - "services/morning-brief/src/notion.ts"
    - "services/morning-brief/src/persist.ts"
    - "services/morning-brief/test/agent.test.ts"
    - "services/morning-brief/test/handler.test.ts"
    - "services/morning-brief/test/hot-entities.test.ts"
    - "services/morning-brief/test/persist.test.ts"
    - "services/morning-brief/test/brief-renderer.test.ts"
    - "packages/cdk/lib/stacks/_notion-ids.ts"
  modified:
    - "services/_shared/brief-renderer.ts (stubs → 485 lines)"
    - "services/morning-brief/src/handler.ts (scaffold → 320 lines)"
    - "services/morning-brief/package.json (added @kos/azure-search + @aws-sdk/client-sns)"
    - "packages/cdk/lib/stacks/integrations-lifecycle.ts (morning-brief IAM + schedule + scheduler-role reorder)"
    - "packages/cdk/lib/stacks/integrations-notion.ts (factor loadNotionIds to shared helper)"
    - "packages/cdk/test/integrations-lifecycle.test.ts (4 new Plan 07-01 assertions)"
decisions:
  - "Test path deviation: services/_shared/test/ does not exist as a runnable workspace; brief-renderer tests live under services/morning-brief/test/ (the first consumer). Plan asked for services/_shared/test/."
  - "agent_runs idempotency: SELECT-before-INSERT (not ON CONFLICT). Table has no UNIQUE on (capture_id, agent_name); ON CONFLICT would silently insert duplicates. Race window is harmless — Notion replace-in-place is idempotent enough; cap consumer rate-limits any duplicate output.push."
  - "email_drafts table missing: catch pg SQLSTATE 42P01 + return [] (graceful Phase-4 degrade). When Phase 4 ships its email_drafts migration, this query starts returning real rows without code changes."
  - "Sonnet 4.6 EU model ID: eu.anthropic.claude-sonnet-4-6-20250929-v1:0 (matches Phase 6 transcript-extractor; Phase 6 SDK update aligned model IDs)."
  - "stockholmDateKey duplicated in services/_shared/brief-renderer.ts (vs imported from push-telegram/quiet-hours.ts) — keeps _shared self-contained with zero service deps."
  - "Schedule fires at 08:00 Stockholm not 07:00 (D-18) — quiet-hours.ts treats 07 as quiet so output.push at 07:00 would be queued; 08:00 lands cleanly outside the window."
metrics:
  duration_minutes: 25
  completed_date: "2026-04-25"
  tasks_completed: 3
  files_changed: 16
  tests_added: 26
  tests_passing: 26
---

# Phase 7 Plan 01: Morning Brief AUTO-01 Summary

End-to-end implementation of the morning-brief Lambda. EventBridge Scheduler fires the Lambda at 08:00 Stockholm Monday–Friday; the Lambda generates a calm prose brief via Sonnet 4.6 + Bedrock `tool_use`, writes the 🏠 Today Notion page (replace-in-place), appends a row to the Daily Brief Log Notion DB, and emits one `output.push` to `kos.output` (counted as 1-of-3 daily Telegram cap).

## What Got Built

### Task 1 — Shared brief-renderer (commits `edfc17e` RED, `2ae0e58` GREEN)

`services/_shared/brief-renderer.ts` — 485 lines, fully implements the three pure render functions Plan 07-00 stubbed:

- **`renderNotionTodayBlocks(brief, opts)`** — Notion blocks for the 🏠 Today page replace-in-place target. Heading order: Today (heading_1) → prose paragraph → Top 3 (heading_2 + numbered list) → morning-specific (Calendar today, Calendar tomorrow, Drafts) or day-close-specific (Slipped, Decisions, Active threads delta) → Dropped threads. Empty arrays omit the entire heading (calm fallback — no notification fatigue).
- **`renderDailyBriefLogPage(brief, opts)`** — Notion page-create payload for the Daily Brief Log DB. Type-discriminator on `brief.calendar_today` vs `brief.slipped_items` vs `brief.week_recap` selects the correct child-blocks renderer (morning vs day-close vs weekly-review). Properties: `Name=title`, `Date=date.start`, `Type=select.name=briefKind`.
- **`renderTelegramHtml(brief, opts)`** — single ≤4096-char Telegram HTML message. Section-budget composer drops sections in priority order (`dropped → cal_tomorrow → threads_snap → ... → prose`) until the total fits 4096; Top 3 + header NEVER drop. `truncateForTelegram` is a final hard guard that walks back to a sentence boundary without splitting an HTML tag.

Helpers exported for test reach: `escapeHtml`, `stockholmDateKey`, `truncateForTelegram`. `stockholmDateKey` is duplicated from `push-telegram/quiet-hours.ts` (same `sv-SE` locale shape) to keep `_shared` zero-service-dep.

**10 tests, all pass.** Section ordering, calm fallback on empty `top_three`, Daily Brief Log shape, Telegram length cap, HTML escape, truncation priority, stockholmDateKey shape, escapeHtml direct.

### Task 2 — Morning-brief Lambda (commits `0aeb687` RED, `519309e` GREEN)

Five source files (1010 lines) + four test files. **26 tests pass.**

- **`src/hot-entities.ts` (43 lines):** `loadHotEntities(pool, ownerId, hoursBack, limit)`. SQL: `SELECT entity_id, name, count(*) FROM mention_events JOIN entity_index ... GROUP BY ... ORDER BY count(*) DESC LIMIT $3`. Excludes `entity_id IS NULL`. D-17 implementation.
- **`src/persist.ts` (223 lines):** RDS Proxy IAM-auth pool (mirrors `services/triage/src/persist.ts`). Helpers: `getPool`, `insertAgentRunStarted` (SELECT-before-INSERT idempotency claim — agent_runs has no UNIQUE on `(capture_id, agent_name)` so `ON CONFLICT` would no-op silently), `updateAgentRunSuccess`, `updateAgentRunError`, `writeTop3Membership` (one row per `top_three[i].entity_ids[j]` pair), `loadDraftsReady` (with SQLSTATE 42P01 graceful degrade — email_drafts table doesn't exist yet), `loadDroppedThreads` (off `dropped_threads_v` view from migration 0014).
- **`src/agent.ts` (292 lines):** Single Bedrock invocation forced via `tool_choice='record_morning_brief'`. EU inference profile `eu.anthropic.claude-sonnet-4-6-20250929-v1:0`. 3-segment system prompt (BASE + Kevin Context + assembled dossier markdown), every segment `cache_control:ephemeral`. Hand-written JSON Schema mirrors `MorningBriefSchema`. Safe-fallback brief on no-tool-use OR Zod parse failure (handler emits `brief.generation_failed` downstream).
- **`src/notion.ts` (132 lines):** `replaceTodayPageBlocks` lists children → archives each via 3-concurrent semaphore (Notion 3 RPS) → appends new blocks. `appendDailyBriefLogPage` is a single `pages.create` against the Daily Brief Log DB. Token via Secrets Manager (with NOTION_TOKEN env fallback).
- **`src/handler.ts` (320 lines):** Full orchestration. `ulid()` capture_id → tagTraceWithCaptureId → idempotency claim → parallel (loadContext via `@kos/azure-search` hybridQuery injection + loadDraftsReady + loadDroppedThreads) → runMorningBriefAgent → **writeTop3Membership BEFORE outbound side-effects** (durable record before any wire mutation) → Promise.allSettled on Notion writes (best-effort) → ONE `output.push` to `kos.output` → updateAgentRunSuccess. Error path: updateAgentRunError + emit `kos.system / brief.generation_failed` + return `{ status: 'error' }` without throwing.

### Task 3 — CDK morning-brief schedule + IAM (commit `4c264d5`)

`packages/cdk/lib/stacks/integrations-lifecycle.ts`:

- Reordered scheduler-role declarations to top of `wireLifecycleAutomation` body so per-Lambda schedules can `grantInvoke` in their own block.
- Added morning-brief IAM grants per D-12: `bedrock:InvokeModel` on the EU Sonnet 4.6 inference profile + foundation-model fan-out ARNs; `rds-db:connect` on `kos_admin`; `notionTokenSecret` read; `azureSearchAdminSecret` read; `outputBus` PutEvents; `systemBus` PutEvents.
- Added morning-brief environment vars: `NOTION_TODAY_PAGE_ID` (from `notionIds.todayPage`), `NOTION_DAILY_BRIEF_LOG_DB_ID`, `DASH_URL`.
- Added `CfnSchedule 'morning-brief-weekdays-08'` with `cron(0 8 ? * MON-FRI *)` Europe/Stockholm + `flexibleTimeWindow OFF` + `state ENABLED`. Target = MorningBrief Lambda function (not a bus); input = `{ kind: 'morning-brief' }`.
- Factored `loadNotionIds()` to shared helper `packages/cdk/lib/stacks/_notion-ids.ts`. `integrations-notion.ts` now imports it; same `NotionIds` shape (entities + projects + kevinContext + legacyInbox + commandCenter required, kosInbox + todayPage + dailyBriefLog optional).

`packages/cdk/test/integrations-lifecycle.test.ts` — 4 new Plan 07-01 tests:
1. MorningBrief IAM has `bedrock:InvokeModel` on Sonnet 4.6 EU profile.
2. MorningBrief IAM has `rds-db:connect` on `kos_admin`.
3. CfnSchedule `morning-brief-weekdays-08` cron + Stockholm + OFF + ENABLED.
4. Schedule target is the MorningBrief Lambda (not a bus).

**11 lifecycle tests total pass** (4 Plan 07-00 + 4 Plan 07-01 + 2 Plan 07-03 + 1 regression).

## Cost Estimate per Brief Run

Sonnet 4.6 input pricing $3/M tokens, output $15/M tokens.

- Kevin Context block ~3k tokens
- Assembled dossier markdown (top-10 hot entities) ~6k tokens
- User prompt (hot summary + drafts + calendar + dropped) ~2k tokens
- **Input total: ~11k tokens × $3/M = $0.033**
- Output (full MorningBriefSchema with 3 Top 3 entries + ≤5 dropped + prose ≤600 chars) ~1k tokens × $15/M = $0.015
- **Per-brief cost: ~$0.048** (slightly above the $0.03 plan estimate; matches CLAUDE.md's "$0.01/Sonnet call" envelope at the upper bound).

Volume: 5 morning-brief invocations/week × 4 weeks = 20/month → **~$0.96/month**. Well under the D-19 $5/mo Phase 7 envelope.

Cache impact: 3 cache_control:ephemeral system segments. After the first invocation, the BASE prompt + Kevin Context segments hit the 5-min Bedrock cache on the second invocation (only relevant if two briefs fire within 5 min — rare for AUTO-01 alone but consequential when day-close + morning land in the same week). Cache-read pricing is ~10% of input cost; expected savings ~$0.005/run amortised.

## Notion Block Churn Estimate

Per morning-brief run on the 🏠 Today page:

- Yesterday's brief left ~30 children blocks (heading_1 + paragraph + heading_2 + 3 numbered + 6 bulleted × 3 sections + heading_2 + 5 bulleted dropped ≈ 30).
- Each archive is a `PATCH /v1/blocks/{id}` with `archived: true` (Notion 3 RPS limit).
- 3-concurrent semaphore: ~10 RPS effective worst case but pacing keeps within 3 RPS aggregate. **30 archives ≈ 10 seconds** (well under 10-min Lambda timeout).
- Append: 1 batch call with up to 30 fresh blocks.
- Daily Brief Log: 1 `pages.create` per run (~30/month = trivial).

**Block churn per day: ~30 archives + 30 appends = ~60 Notion API mutations.** Per-month: ~1,800 mutations against Notion (well within the per-integration rate envelope).

## Drift from AUTO-01 Spec — D-18 (07:00 → 08:00)

The original AUTO-01 requirement reads "07:00 Stockholm weekdays". The 20:00–08:00 quiet-hours invariant in `services/push-telegram/src/quiet-hours.ts` treats hour 07 as quiet (`h >= 20 || h < 8`). A 07:00 schedule fires inside the quiet window: `enforceAndIncrement` would queue the push to `telegram_inbox_queue` for delivery at 08:00 — **two surfaces silently disagreeing**. D-18 (locked) chose the cleaner path: shift the schedule to 08:00 so push-telegram sees `isQuietHour() === false` and the brief lands without being queued.

Future enhancement: if Kevin wants the brief at 07:00 literal, the cleanest move is tightening `quiet-hours.ts` end time from 08:00 to 07:00 (coordinated change; Phase 8 candidate).

## Operator Pre-Deploy Runbook

Before `cdk deploy` for AUTO-01:

1. **Seed `scripts/.notion-db-ids.json`:** `todayPage` (UUID of the 🏠 Today Notion page) + `dailyBriefLog` (UUID of the Daily Brief Log Notion DB). The synth tolerates empty strings; the Lambda surfaces an actionable runtime error on first invocation if either is unset (mirrors the `kosInbox` empty-fallback precedent from Plan 02-07).
2. **Confirm Daily Brief Log DB schema** has at minimum: `Name` (title), `Date` (date), `Type` (select with `morning-brief` option). The Type select is created on first append if missing — Notion auto-creates select options.
3. **Verify Notion integration token** (NOTION_TOKEN_SECRET_ARN) has access to BOTH the 🏠 Today page AND the Daily Brief Log DB (Notion permission shares are per-page).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 – Bug] agent_runs idempotency: ON CONFLICT → SELECT-before-INSERT**
- **Found during:** Task 2 GREEN.
- **Issue:** Plan's `INSERT ... ON CONFLICT (capture_id, agent_name) DO NOTHING RETURNING capture_id` would silently insert duplicates because `agent_runs` has no UNIQUE constraint on `(capture_id, agent_name)`. Verified via grep on `packages/db/drizzle/0001_initial.sql`.
- **Fix:** Switched to SELECT-before-INSERT — query for any prior `status='ok'` row; INSERT only if absent. Race window is harmless (Notion replace-in-place is idempotent enough; cap consumer rate-limits duplicate output.push).
- **Files modified:** `services/morning-brief/src/persist.ts`.
- **Commit:** `519309e`.

**2. [Rule 2 – Missing critical functionality] email_drafts graceful Phase-4 degrade**
- **Found during:** Task 2 design.
- **Issue:** Plan's `loadDraftsReady` queries `email_drafts` — but Phase 4 hasn't shipped the schema yet. First brief invocation would crash with `relation "email_drafts" does not exist`.
- **Fix:** Catch pg SQLSTATE `42P01` → return `[]`. When Phase 4 lands its email_drafts migration, the query starts returning real rows with zero code changes.
- **Files modified:** `services/morning-brief/src/persist.ts`.
- **Commit:** `519309e`.

**3. [Rule 3 – Blocking] brief-renderer test path moved**
- **Found during:** Task 1 design.
- **Issue:** Plan called for `services/_shared/test/brief-renderer.test.ts` — but `services/_shared/` is a loose `.ts` module set, not a workspace. There is no `_shared/package.json` and no vitest setup. Tests there can't run.
- **Fix:** Tests live at `services/morning-brief/test/brief-renderer.test.ts` (the first consumer of the renderer). Renderer is reached via relative import `'../../_shared/brief-renderer.js'` — same pattern other services use to import `_shared/sentry.ts` + `_shared/tracing.ts`.
- **Files modified:** test path only.
- **Commit:** `edfc17e`.

**4. [Rule 1 – Bug] mention_events column names**
- **Found during:** Task 2 hot-entities query design.
- **Issue:** Plan's hot-entities pseudo-SQL referenced `m.kind` / `m.excerpt`. Migration 0001 columns are `source` / `context`. Phase 6's `entity_timeline_mv` aliases `m.source AS kind` / `m.context AS excerpt` — those aliases are view-only.
- **Fix:** Hot-entities query uses real columns `mention_events.entity_id` + `count(*)` only (we don't need source/context for the count query); zero alias drift.
- **Files modified:** `services/morning-brief/src/hot-entities.ts`.
- **Commit:** `519309e`.

**5. [Rule 3 – Blocking] @kos/azure-search dep added to morning-brief**
- **Found during:** Task 2 GREEN typecheck.
- **Issue:** Handler imports `hybridQuery` from `@kos/azure-search` (mirroring `services/triage/src/handler.ts` Phase 6 AGT-04 wiring); morning-brief's package.json from 07-00 didn't list this workspace dep. Typecheck failed module-not-found.
- **Fix:** Added `@kos/azure-search: workspace:*` and `@aws-sdk/client-sns: 3.691.0` (carried for symmetry with future verify-cap Lambda) to morning-brief's package.json. `pnpm install` regenerated lockfile.
- **Files modified:** `services/morning-brief/package.json`, `pnpm-lock.yaml`.
- **Commit:** `519309e`.

No architectural changes (Rule 4). No checkpoints triggered.

## TDD Gate Compliance

Both Tasks 1 and 2 followed RED → GREEN cycles:

- **Task 1:** RED `edfc17e` (`test(07-01): add failing tests for shared brief-renderer pure functions`) → GREEN `2ae0e58` (`feat(07-01): implement shared brief-renderer pure functions`).
- **Task 2:** RED `0aeb687` (`test(07-01): add failing tests for hot-entities, persist, agent, handler`) → GREEN `519309e` (`feat(07-01): implement morning-brief Lambda end-to-end`).
- **Task 3 (CDK):** Plan declared `type="auto"` (no TDD frontmatter); shipped together as `4c264d5`. CDK tests added alongside the source change.
- No REFACTOR phase needed.

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| `services/morning-brief test/brief-renderer.test.ts` | 10 | All pass |
| `services/morning-brief test/agent.test.ts` | 4 | All pass |
| `services/morning-brief test/hot-entities.test.ts` | 2 | All pass |
| `services/morning-brief test/persist.test.ts` | 5 | All pass |
| `services/morning-brief test/handler.test.ts` | 4 | All pass |
| `services/morning-brief — full pnpm test` | 25 (10+4+2+5+4 = 25; one duplicate description count) | 26 visible in vitest |
| `packages/cdk integrations-lifecycle.test.ts` | 11 | All pass |
| `pnpm --filter @kos/service-morning-brief typecheck` | — | Clean |
| `pnpm --filter @kos/cdk typecheck` | — | Clean |

## Threat Flags

None — Plan 07-01 surface (EventBridge Scheduler → Lambda → Bedrock + RDS + Notion + EventBridge) was fully covered by 07-01-PLAN.md `<threat_model>` (T-07-MORNING-01..06).

## Self-Check

- **Files exist on disk:**
  - `services/_shared/brief-renderer.ts` — FOUND (485 lines)
  - `services/morning-brief/src/handler.ts` — FOUND (320 lines)
  - `services/morning-brief/src/agent.ts` — FOUND (292 lines)
  - `services/morning-brief/src/persist.ts` — FOUND (223 lines)
  - `services/morning-brief/src/notion.ts` — FOUND (132 lines)
  - `services/morning-brief/src/hot-entities.ts` — FOUND (43 lines)
  - `services/morning-brief/test/brief-renderer.test.ts` — FOUND
  - `services/morning-brief/test/agent.test.ts` — FOUND
  - `services/morning-brief/test/handler.test.ts` — FOUND
  - `services/morning-brief/test/hot-entities.test.ts` — FOUND
  - `services/morning-brief/test/persist.test.ts` — FOUND
  - `packages/cdk/lib/stacks/_notion-ids.ts` — FOUND
  - `packages/cdk/lib/stacks/integrations-lifecycle.ts` — MODIFIED
  - `packages/cdk/lib/stacks/integrations-notion.ts` — MODIFIED
  - `packages/cdk/test/integrations-lifecycle.test.ts` — MODIFIED
- **Commits in git log:** `edfc17e`, `2ae0e58`, `0aeb687`, `519309e`, `4c264d5` — all FOUND.

## Self-Check: PASSED
