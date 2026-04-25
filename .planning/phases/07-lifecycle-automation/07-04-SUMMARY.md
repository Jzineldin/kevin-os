---
phase: 07-lifecycle-automation
plan: 04
subsystem: verify-notification-cap
tags: [auto-01, auto-03, auto-04, gate-compliance, cap-invariant, quiet-hours-invariant, e2e-verification]
requires:
  - "Plan 07-00: services/verify-notification-cap workspace + integrations-lifecycle.ts helper stub + Phase-1 SafetyStack capTable + alarmTopic"
  - "Plan 07-01: morning-brief Lambda end-to-end (agent_runs row shape; output.push contract)"
  - "Plan 07-02: day-close + weekly-review Lambdas (per-Stockholm-day cap arithmetic)"
  - "Plan 07-03: email-triage every-2h scheduler (5th of 5 schedules in the lifecycle helper)"
provides:
  - "services/verify-notification-cap/src/{handler,queries,pool}.ts — weekly cap-invariant + quiet-hours compliance check Lambda"
  - "scripts/verify-notification-cap-14day.mjs — operator CLI cap verifier (exit codes 0/1/2)"
  - "scripts/verify-quiet-hours-invariant.mjs — operator CLI quiet-hours verifier (exit codes 0/1/2)"
  - "scripts/verify-phase-7-e2e.mjs — Phase 7 E2E gate (mock + live modes; mirror of verify-phase-6-e2e.mjs)"
  - "CDK CfnSchedule verify-notification-cap-weekly cron(0 3 ? * SUN *) Europe/Stockholm — fires before Sunday 19:00 weekly-review"
  - "CDK IAM grants on VerifyNotificationCap Lambda: rds-db:connect (kos_admin), telegramCapTable.grantReadData, alarmTopic.grantPublish, systemBus.grantPutEventsTo"
affects:
  - "Phase 7 Gate evidence: any future regression in cap or quiet-hours invariants is caught by the weekly Lambda + dev pre-deploy checks"
  - "SafetyStack alarmTopic now has a second producer (push-telegram cap-deny + verify-notification-cap weekly compliance violations)"
tech-stack:
  added:
    - "@aws-sdk/client-sns 3.691.0 on services/verify-notification-cap"
  patterns:
    - "Stockholm date-window construction in JS via sv-SE locale toLocaleString — mirrors push-telegram/quiet-hours.ts::stockholmDateKey"
    - "Best-effort SNS Publish + EventBridge PutEvents on violation — operator alarm must surface even when downstream services fail"
    - "DynamoDB GetItem with try/catch swallow → null capTableCount; SQL count is source of truth for violation detection"
    - "Mock-mode E2E verifier with structural source-grep checks (no AWS/Notion/Bedrock creds needed) — same pattern as verify-phase-6-e2e.mjs"
key-files:
  created:
    - "services/verify-notification-cap/src/handler.ts (199 lines)"
    - "services/verify-notification-cap/src/queries.ts (173 lines)"
    - "services/verify-notification-cap/src/pool.ts (42 lines)"
    - "services/verify-notification-cap/test/handler.test.ts (160 lines, 3 tests)"
    - "services/verify-notification-cap/test/queries.test.ts (133 lines, 5 tests)"
    - "scripts/verify-notification-cap-14day.mjs (97 lines)"
    - "scripts/verify-quiet-hours-invariant.mjs (66 lines)"
    - "scripts/verify-phase-7-e2e.mjs (350 lines)"
  modified:
    - "services/verify-notification-cap/package.json (added @aws-sdk/client-sns dep)"
    - "packages/cdk/lib/stacks/integrations-lifecycle.ts (+44 lines: verify-cap IAM + schedule)"
    - "packages/cdk/test/integrations-lifecycle.test.ts (+4 Plan 07-04 tests; 21 lifecycle tests total pass)"
    - "pnpm-lock.yaml (regenerated for client-sns)"
decisions:
  - "Plan asked for 6 unit tests; shipped 8 (5 queries + 3 handler) — added a 'returns [] when no quiet-hours pushes' query test + a 'zero-pads missing days' edge-case test for completeness."
  - "Pure pool.ts split out (instead of bundling into handler/queries) — mirrors morning-brief/persist.ts pattern; lets handler.test.ts mock '../src/pool.js' without touching queries.ts logic."
  - "Stockholm 14-day window built in JS (via sv-SE locale) instead of in SQL — guarantees exactly 14 entries even when SQL returns fewer rows; the SQL just provides a date→count Map for lookup."
  - "DynamoDB Get failure swallowed (capTableCount=null) instead of throwing — handler still completes via SQL-only snapshot; T-07-VERIFY-04 mitigation (3-min timeout headroom)."
  - "SNS publish + brief.compliance_violation are BOTH best-effort (try/catch around each); compliance signal must surface even when one path is broken — operator can also run the same logic locally via the CLI script."
  - "verify-phase-7-e2e.mjs mock mode is structural-only (regex on source files); live mode chains 6 SC checks through agent_runs queries + subprocess invocation of the 2 CLI verifiers."
  - "Migration 0014 view detection regex tightened to match quoted identifiers (`\"dropped_threads_v\"`) — initial regex assumed unquoted name; live source uses Postgres-style double-quoted identifiers."
metrics:
  duration_minutes: 30
  completed_date: "2026-04-25"
  tasks_completed: 3
  files_changed: 11
  tests_added: 12
  tests_passing: 12
  cdk_tests_passing: 21   # 17 prior + 4 Plan 07-04 = 21
---

# Phase 7 Plan 04: Verification Harness Summary

The Phase 7 Gate. Closes the loop on the cap (3/day) and quiet-hours
(20:00–08:00 Stockholm) invariants by deploying both ongoing automated
monitoring (a weekly Sunday 03:00 Lambda) and developer pre-deploy
verifiers (3 CLI scripts) — plus a single E2E gate (`verify-phase-7-e2e.mjs`)
that chains every Phase 7 success criterion in one runnable.

## What Got Built

### Task 1 — verify-notification-cap Lambda (commits `74ce8c0` RED, `f96416d` GREEN)

Three source files (414 lines) + two test files (293 lines, 8 tests). All pass.

- **`src/queries.ts` (173 lines):** Pure SQL + DynamoDB query helpers.
  - `loadCapSnapshots14Days(pool, ddb, capTableName, ownerId)` returns
    14 entries (today → 13 days ago, Stockholm-local). SQL groups
    `agent_runs` by Stockholm-local calendar day; we pad to exactly 14
    entries even if SQL returned fewer rows. DynamoDB GetItem on
    `telegram-cap#YYYY-MM-DD` cross-checks each day; failures swallowed
    → `capTableCount=null`. `violation = pushOkCount > 3`.
  - `loadQuietHoursViolations14Days(pool, ownerId)` returns
    `push-telegram` rows whose Stockholm-local hour ∈ [20, 8).

- **`src/handler.ts` (199 lines):** `wrapHandler` with `initSentry` +
  `setupOtelTracingAsync`. Generates a ulid `run_id`; loads cap
  snapshots + quiet-hours violations in parallel; on ANY violation,
  publishes SNS to `ALARM_TOPIC_ARN` (best-effort) AND emits
  EventBridge `kos.system / brief.compliance_violation` (best-effort).
  Always returns `{ healthy, run_id, run_at, cap_violations[],
  quiet_hours_violations[] }`. Never throws — operator alarm best-effort.

- **`src/pool.ts` (42 lines):** RDS Proxy IAM-auth singleton (mirrors
  `morning-brief/persist.ts` pattern).

**Tests (8 pass):**
- `queries.test.ts` (5): zero-pad missing days, violation detection,
  DynamoDB failure tolerance, quiet-hours filter SQL shape, empty result.
- `handler.test.ts` (3): happy path (no SNS), violation (SNS + EB),
  DynamoDB failure tolerated.

### Task 2 — Three verifier scripts (commit `321f386`)

- **`scripts/verify-notification-cap-14day.mjs` (97 lines):** Operator
  CLI mirror of the Lambda. Reads SQL via `pg` + DynamoDB via
  `@aws-sdk/lib-dynamodb`. Prints a per-day table; exits 1 on violation.

- **`scripts/verify-quiet-hours-invariant.mjs` (66 lines):** Reads
  `agent_runs` filtered to `push-telegram` runs in [20, 8) Stockholm-local
  over the last 14 days. Exits 1 on any violation.

- **`scripts/verify-phase-7-e2e.mjs` (350 lines):** Phase 7 E2E gate.
  Mock mode (default when `AWS_REGION` unset OR `--mock` passed) runs
  13 structural checks on source files alone; live mode chains 6 SC
  checks through `agent_runs` queries + subprocess invocation of the
  two CLI verifiers.

**Mock-mode result: 13/13 PASS** when verify-cap CDK is wired (Task 3).

**Exit-code semantics (all 3 scripts):**
- `0` — invariant holds / all checks pass
- `1` — at least one violation / at least one check failed
- `2` — missing config (DATABASE_URL or CAP_TABLE_NAME unset)

### Task 3 — CDK schedule + IAM + 4 tests (commit `0399bef`)

`packages/cdk/lib/stacks/integrations-lifecycle.ts` (+44 lines):

- **IAM grants on `verifyNotificationCap`:**
  - `addToRolePolicy({ rds-db:connect on kos_admin })` — read-only SQL.
  - `props.telegramCapTable.grantReadData(verifyNotificationCap)` —
    GetItem only (T-07-VERIFY-02 mitigation: write attempts fail at IAM).
  - `props.alarmTopic.grantPublish(verifyNotificationCap)` — operator
    email on violation.
  - `props.systemBus.grantPutEventsTo(verifyNotificationCap)` —
    `brief.compliance_violation` event.

- **`CfnSchedule 'verify-notification-cap-weekly'`:** cron
  `(0 3 ? * SUN *)` Europe/Stockholm + `flexibleTimeWindow OFF` +
  `state ENABLED`. Target = `verifyNotificationCap.functionArn` (not a
  bus); reuses the shared `schedulerRole` with `grantInvoke`. Fires
  Sunday 03:00 Stockholm — 16 hours BEFORE the Sunday 19:00
  weekly-review brief, so any violation surfaces in the same brief
  cycle.

`packages/cdk/test/integrations-lifecycle.test.ts` (+4 Plan 07-04 tests;
21 lifecycle tests total pass):

1. `Plan 07-04: VerifyNotificationCap IAM has rds-db:connect on kos_admin`.
2. `Plan 07-04: VerifyNotificationCap IAM has dynamodb:GetItem on
   TelegramCap (NOT write)` — structural assertion that read-only grant
   prevents IAM drift to write actions.
3. `Plan 07-04: VerifyNotificationCap IAM has sns:Publish on alarmTopic`.
4. `Plan 07-04: CfnSchedule verify-notification-cap-weekly
   cron(0 3 ? * SUN *) Stockholm + OFF + ENABLED` — also asserts target
   is the Lambda functionArn (not a bus).

**Full CDK regression: 159/159 tests pass across 21 test files.**

## Verifier Surface Summary

| Surface | Path | Where it runs |
|---------|------|---------------|
| `verify-notification-cap` Lambda | `services/verify-notification-cap/` | EventBridge Scheduler weekly Sunday 03:00 Stockholm |
| 14-day cap CLI | `scripts/verify-notification-cap-14day.mjs` | Operator's machine pre-deploy |
| Quiet-hours CLI | `scripts/verify-quiet-hours-invariant.mjs` | Operator's machine pre-deploy |
| Phase 7 E2E gate | `scripts/verify-phase-7-e2e.mjs` | CI / pre-deploy / regression check |

## CloudWatch Alarm Path

```
verify-notification-cap Lambda (weekly Sunday 03:00 Stockholm)
   │
   ├── violation detected
   │      │
   │      ├──▶ SNS Publish ────▶ SafetyStack alarmTopic ────▶ Kevin's email
   │      │
   │      └──▶ EventBridge PutEvents ───▶ kos.system bus ───▶ (future
   │                                                          downstream
   │                                                          subscribers,
   │                                                          e.g. Lambda
   │                                                          that updates
   │                                                          a Notion
   │                                                          compliance
   │                                                          dashboard)
   │
   └── healthy → CloudWatch log + return { healthy: true } (no SNS, no event)
```

The alarmTopic is the same SNS topic SafetyStack already wires for
push-telegram cap-deny telemetry; Kevin's email subscription was
established in Plan 01-07.

## Operator Runbook

### Pre-deploy verification (before each `cdk deploy` for Phase 7)

```bash
# Set DATABASE_URL to the kos RDS Proxy connection string
export DATABASE_URL=postgres://kos_admin@<proxy-endpoint>:5432/kos
export CAP_TABLE_NAME=KosTelegramCap-prod
export AWS_REGION=eu-north-1
export KEVIN_OWNER_ID=9e4be978-cc7d-571b-98ec-a1e92373682c

# 1. 14-day cap invariant
node scripts/verify-notification-cap-14day.mjs

# 2. Quiet-hours invariant
node scripts/verify-quiet-hours-invariant.mjs

# 3. Full Phase 7 E2E (chains 1+2+SC1-SC4 SQL checks)
node scripts/verify-phase-7-e2e.mjs --live
```

### CI / regression (no AWS creds required)

```bash
# Mock mode — pure source-grep structural checks
node scripts/verify-phase-7-e2e.mjs --mock
```

### Manual Lambda invocation (for testing)

```bash
aws lambda invoke \
  --function-name VerifyNotificationCap-... \
  --payload '{"kind":"weekly-compliance-check"}' \
  /tmp/verify-cap-out.json && cat /tmp/verify-cap-out.json
```

## Phase 7 Gate Evidence (dev-audit trail)

`07-04-SUMMARY.md` (this file) serves as the dev-audit trail for the
Phase 7 Gate. There is no explicit ROADMAP Gate for Phase 7, but the
deliverables here ensure:

- **SC5 (cap invariant 14d)** — `verify-notification-cap-14day.mjs` +
  weekly Lambda.
- **SC6 (quiet-hours invariant)** — `verify-quiet-hours-invariant.mjs` +
  weekly Lambda quiet-hours check.
- **SC7 (top3_membership populated daily)** — `verify-phase-7-e2e.mjs`
  live-mode SC4 check.
- **SC1-SC3 (briefs ran in their windows)** — `verify-phase-7-e2e.mjs`
  live-mode SC1-SC3 checks against `agent_runs`.

Future phase enhancements (Phase 9+) can extend `verify-phase-7-e2e.mjs`
with additional checks; the harness is composable.

## Cost Estimate

verify-notification-cap Lambda runs 4 times/month (weekly Sunday
03:00). 512 MB × ~30s execution = 15 GB-s × 4 = 60 GB-s/month.
Free tier covers 400,000 GB-s/month → **$0/month** in steady state.

EventBridge Scheduler: 4 fires/month → **<$0.01/month**.

DynamoDB GetItem: 14 GetItems × 4/month = 56/month × $0.25/M reads =
**$0.000014/month** — negligible.

SNS Publish: at most 4/month (only on violation) → **<$0.001/month**.

**Total Plan 07-04 monthly cost: ~$0** (well under D-19 envelope).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] @aws-sdk/client-sns dep added to verify-notification-cap**
- **Found during:** Task 1 RED phase.
- **Issue:** Plan 07-00 scaffold's package.json carried
  `@aws-sdk/client-eventbridge` + `@aws-sdk/client-secrets-manager` +
  `@aws-sdk/lib-dynamodb` but NOT `@aws-sdk/client-sns`. Handler tests
  mock SNSClient/PublishCommand from `@aws-sdk/client-sns`, so the dep
  must exist at install time.
- **Fix:** Added `"@aws-sdk/client-sns": "3.691.0"` to package.json
  (matches morning-brief's pinned version). `pnpm install` regenerated
  lockfile.
- **Files modified:** `services/verify-notification-cap/package.json`,
  `pnpm-lock.yaml`.
- **Commit:** `74ce8c0` (RED).

**2. [Rule 1 — Bug] Stockholm 14-day window built in JS (not SQL)**
- **Found during:** Task 1 GREEN.
- **Issue:** Plan's SQL groups by `date_trunc(...AT TIME ZONE 'Europe/
  Stockholm')` but doesn't pad missing days. If 5 days had zero
  push-telegram runs, SQL returns 9 rows; the operator output would
  silently lose days. Verifier must show ALL 14 days for confidence.
- **Fix:** SQL becomes a date→count Map; JS builds the 14-day
  Stockholm-local window via `sv-SE` locale (mirrors
  `services/push-telegram/src/quiet-hours.ts::stockholmDateKey`); each
  day's pushOkCount looked up from the Map (default 0). Always exactly
  14 entries regardless of SQL row count.
- **Files modified:** `services/verify-notification-cap/src/queries.ts`.
- **Commit:** `f96416d`.

**3. [Rule 1 — Bug] verify-phase-7-e2e.mjs view-detection regex tightened**
- **Found during:** Task 2 first run.
- **Issue:** `/CREATE OR REPLACE VIEW dropped_threads_v\b/i` failed
  because migration 0014 quotes the view name (`"dropped_threads_v"`).
  E2E reported "VIEW not found" even though the view exists.
- **Fix:** Tightened regex to `/CREATE OR REPLACE VIEW\s+"?dropped_threads_v"?/i`
  — handles both quoted and unquoted forms.
- **Files modified:** `scripts/verify-phase-7-e2e.mjs`.
- **Commit:** `321f386` (caught at first script run; fixed before commit).

**4. [Rule 2 — Missing critical functionality] pool.ts split from queries.ts**
- **Found during:** Task 1 design.
- **Issue:** Plan suggested all RDS pool logic inline in queries.ts. But
  handler.test.ts mocks pool helper to inject a fake pg.Pool — keeping
  pool creation in a separate `pool.ts` lets tests `vi.mock('../src/pool.js')`
  cleanly without touching queries.ts internals (which take Pool as a
  parameter). This mirrors the morning-brief / day-close / weekly-review
  pattern (persist.ts has its own `getPool` export).
- **Fix:** Created `services/verify-notification-cap/src/pool.ts` (42
  lines) with the standard RDS Proxy IAM-auth pool factory.
- **Files modified:** new `pool.ts`, handler.ts imports from it.
- **Commit:** `f96416d`.

**5. [Rule 1 — Bug] Worktree base out-of-date — fast-forward merge required**
- **Found during:** Plan startup.
- **Issue:** Worktree branch `worktree-agent-a4d1601b2b515d4de` was on
  base `b45f47a` (pre-Phase-7 PR merge) which lacked the 07-00..07-03
  scaffolding commits. Plan 07-04 depends on the verify-notification-cap
  scaffold + integrations-lifecycle.ts helper.
- **Fix:** `git merge phase-02-wave-5-gaps --no-edit` brought all
  Phase 7 prior plans forward. No file conflicts.
- **Rationale:** Same fix-up Plan 07-03 documented in its summary; per
  `<destructive_git_prohibition>` merge is the safe alternative to
  `git reset --hard`.

### Specification observations (no auto-fix needed)

**6. Plan asked for 6 unit tests; shipped 8.** Added two extras:
queries.test "returns [] when no quiet-hours pushes" + queries.test
"zero-pads missing days". Plan's `min_lines: 80` for queries.ts was
already satisfied (173 lines); plan's per-test count was a floor.

**7. Plan's draft worktree-agent path showed running pnpm in the
worktree filesystem.** The worktree exists but pnpm dependencies are
installed in the main-repo workspace. All testing + commits went to
the main-repo branch `phase-02-wave-5-gaps` per the same pattern Plan
07-03 documented (worktree may not have node_modules; main-repo
workspace is the canonical test environment).

No architectural changes (Rule 4). No checkpoints triggered. No human-
action gates.

## Auth Gates

None encountered. Plan 07-04 is pure infrastructure + offline tests; no
live AWS calls or third-party secret retrieval.

## TDD Gate Compliance

**Task 1** followed RED → GREEN cycle per `tdd="true"` frontmatter:
- RED commit: `74ce8c0` (`test(07-04): add failing tests for
  verify-notification-cap queries + handler`)
- GREEN commit: `f96416d` (`feat(07-04): implement
  verify-notification-cap Lambda end-to-end (D-07)`)
- No REFACTOR phase needed.

**Tasks 2 + 3** declared `type="auto"` (no TDD frontmatter); shipped
as combined commits with tests + impl together (allowed for
`type: auto`):
- Task 2: `321f386` (3 verifier scripts + their parse validation)
- Task 3: `0399bef` (CDK wiring + 4 CDK tests in same commit)

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| `services/verify-notification-cap test/queries.test.ts` | 5 | All pass |
| `services/verify-notification-cap test/handler.test.ts` | 3 | All pass |
| `services/verify-notification-cap — full pnpm test` | 8 | All pass |
| `pnpm --filter @kos/service-verify-notification-cap typecheck` | — | Clean |
| `node --check scripts/verify-notification-cap-14day.mjs` | — | Parses OK |
| `node --check scripts/verify-quiet-hours-invariant.mjs` | — | Parses OK |
| `node --check scripts/verify-phase-7-e2e.mjs` | — | Parses OK |
| `node scripts/verify-phase-7-e2e.mjs --mock` | 13 checks | 13/13 PASS |
| `packages/cdk integrations-lifecycle.test.ts` (Plan 07-04 alone) | 4 new | All pass |
| `packages/cdk integrations-lifecycle.test.ts` (full) | 21 | All pass |
| `pnpm --filter @kos/cdk test` (full regression) | 159 | All pass (21 files) |
| `pnpm --filter @kos/cdk typecheck` | — | Clean |

## Threat Flags

None — Plan 07-04 surface (EventBridge Scheduler → Lambda → SQL +
DynamoDB Get + SNS Publish + EventBridge PutEvents) was fully covered
by the plan's `<threat_model>`:

- **T-07-VERIFY-01 (info disclosure via alarm email)** — accept; alarm
  email is Kevin's own.
- **T-07-VERIFY-02 (tampering: write to DynamoDB)** — mitigate;
  `grantReadData` (NOT `grantReadWriteData`); CDK test #2 asserts no
  `dynamodb:Put*` action grant.
- **T-07-VERIFY-03 (verifier doesn't fire)** — mitigate; weekly
  Scheduler + CloudWatch Lambda Errors alarm picks up Lambda failures
  via the same alarmTopic.
- **T-07-VERIFY-04 (3min timeout DoS)** — accept; queries scoped to 14
  days; agent_runs has `(owner_id, started_at)` index from Phase 1
  migration 0001.

## Self-Check

- **Files exist on disk:**
  - `services/verify-notification-cap/src/handler.ts` — FOUND (199 lines)
  - `services/verify-notification-cap/src/queries.ts` — FOUND (173 lines)
  - `services/verify-notification-cap/src/pool.ts` — FOUND (42 lines)
  - `services/verify-notification-cap/test/handler.test.ts` — FOUND
  - `services/verify-notification-cap/test/queries.test.ts` — FOUND
  - `scripts/verify-notification-cap-14day.mjs` — FOUND
  - `scripts/verify-quiet-hours-invariant.mjs` — FOUND
  - `scripts/verify-phase-7-e2e.mjs` — FOUND
  - `packages/cdk/lib/stacks/integrations-lifecycle.ts` — MODIFIED (+44 lines)
  - `packages/cdk/test/integrations-lifecycle.test.ts` — MODIFIED (+4 tests)
- **Commits in git log:** `74ce8c0`, `f96416d`, `321f386`, `0399bef` — all FOUND.
- **Final acceptance:** `node scripts/verify-phase-7-e2e.mjs --mock` exits 0 (13/13 PASS).

## Self-Check: PASSED
