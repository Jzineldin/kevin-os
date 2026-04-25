---
phase: 07-lifecycle-automation
plan: 00
subsystem: lifecycle-scaffold
tags: [auto-01, auto-03, auto-04, scaffold, brief-schemas, top3-membership, migration-0014]
requires:
  - "Phase 1 SafetyStack: capTable + alarmTopic + outputBus"
  - "Phase 6 migration 0012 (entity_index + mention_events present)"
provides:
  - "services/morning-brief, services/day-close, services/weekly-review, services/verify-notification-cap workspaces (scaffold)"
  - "@kos/contracts/brief: MorningBriefSchema + DayCloseBriefSchema + WeeklyReviewSchema + BriefAgentRunOutputSchema"
  - "services/_shared/brief-renderer.ts function signatures (Plan 07-01 fills bodies)"
  - "packages/db/drizzle/0014: top3_membership + dropped_threads_v + acted_on_at trigger"
  - "packages/cdk/lib/stacks/integrations-lifecycle.ts wireLifecycleAutomation(scope, props) helper stub"
  - "scripts/.notion-db-ids.json: todayPage + dailyBriefLog keys (operator-seeded)"
affects:
  - "Plans 07-01..07-04 attach IAM grants + schedules to the helper exports"
tech-stack:
  added:
    - "@arizeai/openinference-instrumentation-claude-agent-sdk on 4 new services"
    - "@langfuse/otel + @opentelemetry/api/instrumentation/sdk-trace-node on 4 new services"
    - "@kos/contracts subpath './brief'"
  patterns:
    - "tsconfig paths mapping @kos/* → ./node_modules/@kos/*/src/index.ts (new pattern; unblocks _shared/* type-only imports under Bundler resolution)"
key-files:
  created:
    - "services/morning-brief/{package.json,tsconfig.json,src/handler.ts}"
    - "services/day-close/{package.json,tsconfig.json,src/handler.ts}"
    - "services/weekly-review/{package.json,tsconfig.json,src/handler.ts}"
    - "services/verify-notification-cap/{package.json,tsconfig.json,src/handler.ts}"
    - "services/_shared/brief-renderer.ts"
    - "packages/contracts/src/brief.ts"
    - "packages/contracts/test/brief.test.ts"
    - "packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql"
    - "packages/cdk/lib/stacks/integrations-lifecycle.ts"
    - "packages/cdk/test/integrations-lifecycle.test.ts"
  modified:
    - "packages/contracts/src/index.ts (re-export brief.js)"
    - "packages/contracts/package.json (./brief subpath export)"
    - "packages/cdk/lib/stacks/integrations-stack.ts (optional Phase 7 props + wireLifecycleAutomation call)"
    - "packages/cdk/lib/stacks/integrations-notion.ts (NotionIds extends with optional todayPage + dailyBriefLog)"
    - "packages/cdk/bin/kos.ts (SafetyStack moved before IntegrationsStack so refs flow forward)"
    - "scripts/.notion-db-ids.json (todayPage + dailyBriefLog keys)"
    - "pnpm-lock.yaml (regenerated for new deps)"
decisions:
  - "Migration number 0014 chosen — Phase 6 took 0012, Phase 4 reserves 0013 (unapplied), 0014 is next-free"
  - "Renamed brief calendar event to BriefCalendarEventSchema to avoid barrel collision with dashboard.ts CalendarEventSchema"
  - "Added @kos/* paths mapping to each new service tsconfig (unblocks _shared/* type-only imports)"
  - "Reordered bin/kos.ts so SafetyStack creates BEFORE IntegrationsStack (capTable + alarmTopic now flow forward)"
  - "Made Phase 7 props optional on IntegrationsStackProps (existing test fixtures keep synthing)"
metrics:
  duration_minutes: 24
  completed_date: "2026-04-25"
  tasks_completed: 4
  files_changed: 21
  tests_added: 13   # 8 brief schemas + 5 CDK lifecycle
  tests_passing: 13
---

# Phase 7 Plan 00: Lifecycle Automation Scaffolding Summary

Wave 0 foundation for Phase 7. Lays down package skeletons for the 4 new
Lambdas (morning-brief / day-close / weekly-review / verify-notification-cap),
the shared brief-renderer signatures, the Zod brief schemas (tool_use
contracts), the migration for top3_membership + dropped_threads_v +
acted_on_at trigger, and the CDK helper stub — Plans 07-01..07-04 only need
to fill bodies + attach IAM/schedules.

## What Got Built

### Task 1 — Service scaffolds (commit `d09a229`, fix-up `fde1f72`)

Four new pnpm workspaces under `services/`. Each has:
- `package.json` (`@kos/service-<name>`, ESM, vitest test script,
  workspace `@kos/contracts`/`@kos/db`/`@kos/context-loader` deps).
- `tsconfig.json` mirroring the Phase 6 pattern + a new `@kos/*` paths
  mapping so `_shared/brief-renderer.ts` (which type-imports
  `@kos/contracts`) resolves cleanly under Bundler module resolution.
- `src/handler.ts` — placeholder returning `{ skipped: 'scaffold', service }`.
- Same Sentry / OpenTelemetry / Langfuse / Arize-OpenInference deps as
  Phase 6 services so Plan 07-01..07-04 can wire `initSentry` /
  `tagTraceWithCaptureId` per D-10.

`services/_shared/brief-renderer.ts` exports three signature-only helpers
(`renderNotionTodayBlocks`, `renderDailyBriefLogPage`, `renderTelegramHtml`).
Bodies arrive in Plan 07-01 Task 1.

### Task 2 — Brief schemas (commits `da7cf5f` RED, `4e5addb` GREEN)

`packages/contracts/src/brief.ts` (160 lines) — the load-bearing tool_use
contracts:
- `BriefCommonFieldsSchema` — prose_summary (≤600 chars) + top_three[0..3]
  + dropped_threads[0..5].
- `MorningBriefSchema` — extends common fields with calendar_today /
  calendar_tomorrow (BriefCalendarEventSchema, max 20 each) + drafts_ready
  (max 10).
- `DayCloseBriefSchema` — extends common with slipped_items[0..5] +
  recent_decisions[0..5] + active_threads_delta[0..10].
- `WeeklyReviewSchema` — own shape (no Top 3, prose_summary ≤1000) with
  week_recap[0..10] + next_week_candidates[0..7] +
  active_threads_snapshot[0..20].
- `BriefAgentRunOutputSchema` — envelope wrapping any of the three
  (brief_kind discriminator + ULID brief_capture_id + ISO rendered_at +
  nested data union).

`packages/contracts/test/brief.test.ts` — **8 tests, all passing** (plan
asked for 6; added 2 extras: BriefCommonFieldsSchema discrete + bad-ULID
rejection in BriefAgentRunOutputSchema).

`packages/contracts/src/index.ts` re-exports `brief.js`. `package.json`
adds `./brief` subpath export.

### Task 3 — Migration 0014 (commit `c3053b6`)

`packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql`:
- `top3_membership` table (1 row per (brief, entity) pair), 3 indexes
  (by_owner_date, by_entity, partial-pending).
- `dropped_threads_v` view — joins top3_membership + entity_index +
  mention_events; surfaces unmembered Top-3 entities older than 24h.
- `mark_top3_acted_on()` plpgsql function + AFTER INSERT trigger on
  `mention_events` — auto-stamps `acted_on_at` when matching mention
  arrives.
- Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE VIEW/FUNCTION`,
  `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`).

**Migration number chosen: 0014.** Collision check confirmed only 0012
(Phase 6) currently applied; Phase 4 reserves 0013 per D-14. Next-free
slot is 0014.

### Task 4 — CDK helper + IntegrationsStack threading (commit `10c09ad`)

`packages/cdk/lib/stacks/integrations-lifecycle.ts` — new helper exporting:
- `WireLifecycleAutomationProps` interface (vpc, RDS refs, Notion +
  Azure secrets, telegramCapTable, alarmTopic, 4 buses, scheduleGroupName).
- `LifecycleAutomationWiring` interface (4 KosLambdas + 2 Roles).
- `wireLifecycleAutomation()` — creates the 4 Lambdas with D-11 memory
  + timeout (morning 1024/10min, day-close 1024/10min, weekly 1536/10min,
  verify-cap 512/3min), VPC-attached to PRIVATE_WITH_EGRESS subnets +
  rdsSecurityGroup, common env (RDS_PROXY_ENDPOINT, KEVIN_OWNER_ID,
  Notion + Azure secret ARNs, OUTPUT_BUS_NAME, SYSTEM_BUS_NAME). Body is
  stub — schedules + IAM grants accrete in Plans 07-01..07-04.

`packages/cdk/lib/stacks/integrations-stack.ts` — added optional
`telegramCapTable`, `alarmTopic`, `outputBus` props. When all three
present, fires `wireLifecycleAutomation` and exposes the wiring on
`IntegrationsStack.lifecycle`. Existing test fixtures (no SafetyStack
refs) continue to synth.

`packages/cdk/bin/kos.ts` — SafetyStack creation moved BEFORE
IntegrationsStack so capTable + alarmTopic flow forward. Added
`integrations.addDependency(safety)` for deploy ordering.

`packages/cdk/lib/stacks/integrations-notion.ts` — `NotionIds` type
extended with optional `todayPage: string` + `dailyBriefLog: string`
keys (synth-time empty string allowed; runtime brief Lambdas surface
actionable errors if unset, mirroring `kosInbox` precedent).

`scripts/.notion-db-ids.json` — adds `todayPage: ""` + `dailyBriefLog: ""`.

`packages/cdk/test/integrations-lifecycle.test.ts` — **5 tests, all passing**
(plan asked for 4; added a regression test verifying IntegrationsStack
synthesises with NO Phase 7 Lambdas when SafetyStack refs are unset).

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| `packages/contracts/test/brief.test.ts` | 8 | All pass |
| `packages/cdk/test/integrations-lifecycle.test.ts` | 5 | All pass |
| `pnpm --filter @kos/cdk test` (full regression) | 143 | All pass (21 files) |
| `pnpm --filter @kos/contracts typecheck` | — | Clean |
| `pnpm --filter @kos/cdk typecheck` | — | Clean |
| `pnpm --filter @kos/service-morning-brief --filter @kos/service-day-close --filter @kos/service-weekly-review --filter @kos/service-verify-notification-cap typecheck` | — | All clean |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] BriefCalendarEventSchema rename to avoid barrel collision**
- **Found during:** Task 2 GREEN typecheck.
- **Issue:** `packages/contracts/src/index.ts` re-exports both
  `dashboard.js` and `brief.js`; both originally exported
  `CalendarEventSchema`/`CalendarEvent`. TS error TS2308.
- **Fix:** Renamed brief's calendar schema to
  `BriefCalendarEventSchema`/`BriefCalendarEvent`. Dashboard's stays
  unchanged (Phase 3 consumers untouched).
- **Files modified:** `packages/contracts/src/brief.ts`.
- **Commit:** `4e5addb`.

**2. [Rule 1 - Bug] tsconfig paths mapping for @kos/* unblocks _shared resolution**
- **Found during:** Task 1 typecheck.
- **Issue:** `services/_shared/brief-renderer.ts` type-imports
  `@kos/contracts`. Bundler module resolution from `services/_shared/`
  cannot find `@kos/contracts` (no node_modules under `_shared/`; rootDir
  blocks upward escape).
- **Fix:** Added `"@kos/*": ["./node_modules/@kos/*/src/index.ts",
  "./node_modules/@kos/*"]` to each new service tsconfig.json so the
  bundler resolves the symlinked workspace package.
- **Files modified:** 4 tsconfig.json files in new services.
- **Commit:** `fde1f72`.

**3. [Rule 2 - Missing critical functionality] OpenTelemetry/Langfuse/Sentry deps proactively added**
- **Found during:** Task 1 typecheck.
- **Issue:** `services/_shared/tracing.ts` (existing pre-Phase-7 file) is
  pulled into typecheck via `tsconfig include: ["../_shared/**/*.ts"]`.
  Without `@opentelemetry/*` + `@langfuse/otel` + `@arizeai/...` deps,
  scaffold typecheck fails.
- **Fix:** Added the same deps Phase 6 services carry. Plan 07-01..07-04
  will use them per D-10 (Sentry init + Langfuse trace tagging).
- **Files modified:** 4 service package.json files; pnpm-lock.yaml.
- **Commit:** `fde1f72`.

**4. [Rule 1 - Bug] Removed `as const` from vpcConfig in integrations-lifecycle.ts**
- **Found during:** Task 4 typecheck.
- **Issue:** `as const` made `securityGroups: readonly [ISecurityGroup]`,
  but `KosLambdaProps.securityGroups` is mutable `ISecurityGroup[]`.
- **Fix:** Dropped `as const` (matches existing `integrations-notion.ts`
  pattern which doesn't use it either).
- **Files modified:** `packages/cdk/lib/stacks/integrations-lifecycle.ts`.
- **Commit:** `10c09ad`.

**5. [Rule 1 - Bug] bin/kos.ts SafetyStack reordered before IntegrationsStack**
- **Found during:** Task 4 design.
- **Issue:** Plan asks IntegrationsStack to consume SafetyStack's capTable
  + alarmTopic. Original bin/kos.ts created IntegrationsStack first.
- **Fix:** Moved SafetyStack creation BEFORE IntegrationsStack; added
  `integrations.addDependency(safety)`. SafetyStack only depends on
  EventsStack + DataStack (no IntegrationsStack ref), so the reorder
  is safe.
- **Files modified:** `packages/cdk/bin/kos.ts`.
- **Commit:** `10c09ad`.

No architectural changes needed. No checkpoints triggered.

## TDD Gate Compliance

Task 2 followed the RED → GREEN cycle:
- RED commit: `da7cf5f` (`test(07-00): add failing tests…`)
- GREEN commit: `4e5addb` (`feat(07-00): @kos/contracts/brief…`)
- No REFACTOR phase needed (schema already minimal).

## Operator Pre-Deploy Notes

Before Plans 07-01..07-04 deploy:

1. **Seed `scripts/.notion-db-ids.json`:**
   - `todayPage`: ID of the 🏠 Today Notion page (replace-in-place target
     for morning-brief + day-close).
   - `dailyBriefLog`: ID of the Daily Brief Log Notion DB (one append per
     brief run).
2. **Confirm Daily Brief Log DB schema** has at minimum:
   - `Type` (select with values `morning` / `day-close` / `weekly-review`).
   - `Date` (date column for the Stockholm calendar date).

If either ID is left empty at deploy time, the brief Lambdas will surface
an actionable runtime error on first invocation (mirroring the
`NOTION_KOS_INBOX_DB_ID` empty-fallback pattern from Plan 02-07).

## Threat Flags

None — Wave 0 introduces no new network surface beyond what's already
covered in 07-CONTEXT `<threat_model>` (T-07-00-01..04 all addressed by
the implementation: Zod strict schemas, idempotent migrations, view
windowed to 7 days).

## Self-Check: PASSED

- All 21 listed `files_modified` paths exist on disk and contain
  content per the plan.
- Per-task commits (`d09a229`, `da7cf5f`, `4e5addb`, `fde1f72`,
  `c3053b6`, `10c09ad`) all present in `git log`.
- All scaffold + schema + migration + CDK acceptance verifications
  echoed `*-OK`.
- Tests: 8 (contracts) + 5 (CDK lifecycle) + 143 (CDK regression) =
  156 total pass; 0 fail.
