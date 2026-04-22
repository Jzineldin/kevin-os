---
phase: 02-minimum-viable-loop
plan: 10
subsystem: infra
tags: [observability, sentry, langfuse, opentelemetry, cloudwatch, sns, alarms, cdk]

requires:
  - phase: 02-minimum-viable-loop
    provides: setupOtelTracing + langfuseFlush from services/_shared/tracing.ts (Plan 02-00); 10 Lambda handlers (Plans 02-01 through 02-09); secret shells for SENTRY_DSN + LANGFUSE_PUBLIC/SECRET (DataStack)
provides:
  - services/_shared/sentry.ts shared initSentry() with secret-backed DSN and graceful PLACEHOLDER degradation (D-26)
  - tagTraceWithCaptureId() helper that propagates capture_id as Langfuse session.id for cross-agent correlation (D-25)
  - 10 Lambdas wired uniformly to initSentry + tag + flush
  - ObservabilityStack with SNS topic + 4 CloudWatch alarms (telegram-bot p95 latency + per-agent error rate)
  - scripts/verify-observability.mjs operator script (Langfuse + Sentry assertion)
affects: [03-dashboard, 04-email, all future agent additions, every Phase 2+ runbook]

tech-stack:
  added:
    - "@sentry/aws-serverless ^8 (now in 6 additional services)"
    - "@langfuse/otel + @arizeai/openinference + @opentelemetry/* (now in 6 additional services)"
    - "aws-cdk-lib/aws-cloudwatch + aws-cloudwatch-actions (new ObservabilityStack)"
  patterns:
    - "Shared `_shared/sentry.ts` module — single source of truth for Sentry init across all Lambdas (mirrors Plan 02-00's shared tracing.ts)"
    - "tagTraceWithCaptureId(captureId) called inside handler try-block AFTER idempotency check — every downstream Bedrock call inherits the tag"
    - "Synthetic capture_id for non-event-driven Lambdas: `bulk-{kind}-{yyyymmdd}` and `indexer-{dbName}-{utcMinute}`"
    - "Per-Lambda tsconfig path mapping for `@sentry/*` + `@aws-sdk/*` (mirrors existing @opentelemetry/@langfuse/@arizeai pattern) so _shared resolves through each consuming service's local node_modules"
    - "ObservabilityStack as separate Stack (depends on capture+agents) — distinct from SafetyStack's CostAlarmTopic so cost vs runtime alarm runbooks stay independent"

key-files:
  created:
    - "services/_shared/sentry.ts (initSentry + wrapHandler re-export + Sentry namespace re-export)"
    - "packages/cdk/lib/stacks/observability-stack.ts (SNS topic + 4 alarms)"
    - "packages/cdk/test/observability-stack.test.ts (4 synth-level assertions)"
    - "scripts/verify-observability.mjs (Langfuse + optional Sentry verification)"
  modified:
    - "services/_shared/tracing.ts (added tagTraceWithCaptureId + LangfuseSpanProcessor cast through unknown for v1↔v2 sdk-trace-base drift)"
    - "10× services/{telegram-bot,transcribe-starter,transcribe-complete,triage,voice-capture,entity-resolver,bulk-import-kontakter,bulk-import-granola-gmail,push-telegram,notion-indexer}/src/handler.ts"
    - "10× corresponding test/handler.test.ts (mocks updated for _shared/sentry + tagTraceWithCaptureId)"
    - "10× corresponding tsconfig.json (path mappings + ../_shared include)"
    - "10× corresponding package.json (added @sentry/aws-serverless + @opentelemetry/* + @langfuse/otel + @arizeai/* deps where missing)"
    - "packages/cdk/bin/kos.ts (wires ObservabilityStack with explicit dependencies on capture + agents)"

key-decisions:
  - "Shared sentry.ts AS A MODULE not a workspace package — matches Plan 02-00's choice for tracing.ts; avoids @kos/sentry indirection during Wave 0; consuming services import via relative path ../../_shared/sentry.js."
  - "DSN graceful degradation on empty/PLACEHOLDER secret value — Sentry init failure must NEVER kill a real Lambda invocation (Pitfall 9 spirit applied to error tracking)."
  - "tagTraceWithCaptureId sets THREE attributes: kos.capture_id (KOS-native, greppable), langfuse.trace.id (Langfuse convention), langfuse.session.id (verify script queries this)."
  - "1800ms p95 latency threshold for telegram-bot — chosen over upfront provisioned concurrency (Resolved Open Q4); cheaper alarm-then-react while Phase 2 traffic is bursty + low-volume."
  - "Per-agent error alarms only on triage/voice-capture/entity-resolver — bulk-imports excluded as one-shots where 'errors in 15min window' is not meaningful."
  - "ObservabilityStack ships its OWN SNS topic (kos-observability-alarms) distinct from SafetyStack's CostAlarmTopic — cost and runtime alarm runbooks are unrelated."
  - "LangfuseSpanProcessor cast via `as unknown as never` — bridges sdk-trace-base v1↔v2 type drift between Sentry's @sentry/opentelemetry peer (v1.30.1) and langfuse/otel@5 (v2.7.0). Runtime contract is correct; same pattern as the existing ClaudeAgentSDKInstrumentation cast in tracing.ts."

patterns-established:
  - "Pattern: Every new Lambda from Phase 3+ must `await initSentry()` at handler entry and `tagTraceWithCaptureId(captureId)` after the idempotency check — copy the triage handler shape."
  - "Pattern: Synthetic capture_ids for scheduled/operator Lambdas use the format `{kind}-{discriminator}-{yyyymmdd|utcMinute}` so Langfuse session view stays tidy without explosive cardinality."
  - "Pattern: When adding deps that depend on @opentelemetry/sdk-trace-base, add the path mapping for @sentry/* + @aws-sdk/* alongside the existing @opentelemetry/@langfuse/@arizeai mappings; the cast through unknown in tracing.ts handles the version drift."

requirements-completed: [AGT-01, AGT-02, AGT-03]

duration: ~32min
completed: 2026-04-22
---

# Phase 02 Plan 10: Sentry + Langfuse + CloudWatch Observability Summary

**Shared `_shared/sentry.ts` module + capture_id propagation across 10 Lambdas + ObservabilityStack with 4 CloudWatch alarms (telegram-bot p95 latency + per-agent error rate) + verify-observability.mjs operator script — Phase 2 now ships with full runtime observability instead of debug-blind.**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-04-22T19:50:00Z
- **Completed:** 2026-04-22T20:22:00Z
- **Tasks:** 2
- **Files modified:** 41 (Task 1) + 4 (Task 2) = 45 total

## Accomplishments

- D-25 realized: every Bedrock call across triage → voice-capture → entity-resolver inherits a span tagged with `langfuse.session.id = capture_id`, making cross-agent correlation a single Langfuse session view per Kevin capture.
- D-26 realized: every Phase 2 Lambda (10 total) initialises Sentry via the shared `initSentry()` helper. DSN fetched once per cold start from Secrets Manager; gracefully degrades to no-Sentry if the secret is empty/PLACEHOLDER.
- Resolved Open Q4 realized: `kos-telegram-bot-p95-duration-high` CloudWatch alarm (1800ms threshold, 5-min window, 2 datapoints) is the operator's signal to consider provisioned concurrency — without the upfront cost.
- Per-agent error-rate alarms (`kos-{agent}-error-rate-high`, threshold=5 errors / 15-min) fire on the SNS topic so Kevin gets a CloudWatch console signal before Sentry's free-tier 5k/mo budget ever matters.
- `scripts/verify-observability.mjs` lets Kevin (or CI) prove the loop end-to-end after a real capture: passes a `--capture-id`, asserts Langfuse cloud has ≥1 trace for that session, optionally asserts Sentry has events in the last 60min.

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared sentry.ts + uniform wrapping across 10 Lambdas + capture_id propagation** — `1bb6868` (feat)
2. **Task 2: ObservabilityStack + verify-observability.mjs** — `f6e29d1` (feat)

## Files Created/Modified

**Created (4):**
- `services/_shared/sentry.ts` — initSentry() + wrapHandler + Sentry re-exports
- `packages/cdk/lib/stacks/observability-stack.ts` — SNS topic + 4 alarms
- `packages/cdk/test/observability-stack.test.ts` — 4 synth assertions
- `scripts/verify-observability.mjs` — Langfuse + optional Sentry assertion

**Modified (41):**
- `services/_shared/tracing.ts` — added `tagTraceWithCaptureId` + LangfuseSpanProcessor cast for v1↔v2 type drift
- `services/{10 Lambdas}/src/handler.ts` — replaced inline `sentryInit` with `await initSentry()`, added `tagTraceWithCaptureId` call after idempotency check
- `services/{10 Lambdas}/test/handler.test.ts` — mock `_shared/sentry.js` + add `tagTraceWithCaptureId` to `_shared/tracing.js` mock
- `services/{10 Lambdas}/tsconfig.json` — added `@sentry/*` + `@aws-sdk/*` path mappings; included `../_shared/**/*.ts`
- `services/{10 Lambdas}/package.json` — added missing observability deps (`@sentry/aws-serverless`, `@opentelemetry/*`, `@langfuse/otel`, `@arizeai/openinference-instrumentation-claude-agent-sdk`)
- `packages/cdk/bin/kos.ts` — wires ObservabilityStack with explicit dependencies
- `pnpm-lock.yaml` — re-resolved with new deps
- `.planning/phases/02-minimum-viable-loop/deferred-items.md` — logged 2 pre-existing typecheck failures

## Decisions Made

See frontmatter `key-decisions`. Highlights:
- **Shared sentry.ts as a module, not a workspace package** — matches Plan 02-00's `_shared/tracing.ts` choice; consuming services import via relative path.
- **Graceful degradation on PLACEHOLDER DSN** — Sentry init failure must NEVER block a Lambda invocation (Pitfall 9 spirit).
- **1800ms p95 threshold over provisioned concurrency** — Resolved Open Q4; cheaper alarm-then-react while traffic is bursty + low-volume.
- **Distinct SNS topic per concern** — kos-observability-alarms vs SafetyStack's CostAlarmTopic; runtime vs cost runbooks are unrelated.
- **LangfuseSpanProcessor cast through `unknown`** — bridges the v1.30.1 (Sentry chain) vs v2.7.0 (langfuse/otel@5) sdk-trace-base type drift without forcing peer-version changes that would break Sentry runtime.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tsconfig path mappings missing for `@sentry/*` and `@aws-sdk/*`**
- **Found during:** Task 1 (Step C — first typecheck after handler edits)
- **Issue:** `_shared/sentry.ts` imports `@sentry/aws-serverless` and `@aws-sdk/client-secrets-manager`. The existing per-service tsconfigs only mapped `@opentelemetry/*`, `@langfuse/*`, `@arizeai/*` to local node_modules. With `paths` set, TS module resolution from `services/_shared/` couldn't find `@sentry` (no node_modules in `_shared/`).
- **Fix:** Added `@sentry/*: ./node_modules/@sentry/*` and `@aws-sdk/*: ./node_modules/@aws-sdk/*` to all 10 services' tsconfig.json (3 existing + 7 newly extended).
- **Files modified:** all 10 service tsconfig.json files
- **Verification:** `pnpm --filter @kos/service-{X} typecheck` green for the 8 services I own; pre-existing failures in telegram-bot/notion-indexer logged to deferred-items.md as out-of-scope.
- **Committed in:** 1bb6868

**2. [Rule 3 - Blocking] sdk-trace-base v1↔v2 type conflict in `_shared/tracing.ts`**
- **Found during:** Task 1 (Step C — bulk-import-kontakter typecheck)
- **Issue:** `@sentry/aws-serverless` → `@sentry/node` → `@sentry/opentelemetry` peer-deps OTel core to v1.30.1, while `@langfuse/otel@5` peer-deps to v2.7.0. pnpm resolved different versions per service, causing `LangfuseSpanProcessor` (v2-typed) to fail assignability against `SpanProcessor` (v1-typed) in services like bulk-import-kontakter.
- **Fix:** Cast `new LangfuseSpanProcessor({...})` to `as unknown as never` in `_shared/tracing.ts` — same pattern the existing `ClaudeAgentSDKInstrumentation` cast uses. Runtime contract unchanged; only type drift bridged.
- **Files modified:** services/_shared/tracing.ts
- **Verification:** All 10 services typecheck (excluding 2 pre-existing failures unrelated to Plan 02-10).
- **Committed in:** 1bb6868

**3. [Rule 3 - Blocking] Test mocks in 5 services still mocked the OLD `@sentry/aws-serverless` import path**
- **Found during:** Task 1 (preparing tests for re-run after handler swap)
- **Issue:** triage/voice-capture/entity-resolver/push-telegram/telegram-bot/transcribe-starter/transcribe-complete tests mocked `@sentry/aws-serverless` directly, but handlers now import via `_shared/sentry.js`. Without the new mock, vitest would attempt to instantiate the real Sentry SDK (and try real Secrets Manager calls).
- **Fix:** Added `vi.mock('../../_shared/sentry.js', () => ({ initSentry, wrapHandler, Sentry }))` and updated existing `_shared/tracing.js` mocks to include `tagTraceWithCaptureId`. Added the same mocks to bulk-import-kontakter, bulk-import-granola-gmail, and notion-indexer test files (those import the handler module which now triggers _shared/sentry.js loading).
- **Files modified:** all 10 service test/handler.test.ts files
- **Verification:** All 73 service tests pass (across 8 services I own; telegram-bot test pre-existing broken via @kos/test-fixtures resolution; notion-indexer 14/14 pass).
- **Committed in:** 1bb6868

---

**Total deviations:** 3 auto-fixed (all Rule 3 — blocking infrastructure required to land the planned changes)
**Impact on plan:** All three deviations were necessary mechanics of integrating the shared module. No scope creep — the alarm thresholds, attribute names, and verify-script contract all match the plan as written.

## Issues Encountered

- **Worktree HEAD drift on entry:** Worktree was checked out to commit `5441b61` (project init) instead of the expected base `4bf7c16` (Wave 1+2+3 complete). Followed the plan's worktree-branch-check protocol: `git reset --hard 4bf7c1610de...` to align before any edits.
- **Pre-existing typecheck failures in unrelated services:** `services/telegram-bot/test/handler.test.ts` cannot resolve `@kos/test-fixtures`; `services/notion-indexer/test/entities-embedding.test.ts` has 2 strict-null errors. Both reproduce on the Wave-3 base commit before any Plan 02-10 edits. Documented in `deferred-items.md`; out of scope for this plan.

## Verification Results

| Check | Result |
|-------|--------|
| `services/_shared/sentry.ts` exists, contains `initSentry`, `PLACEHOLDER` graceful path | PASS |
| `services/_shared/tracing.ts` exports `tagTraceWithCaptureId` + sets `langfuse.trace.id` | PASS |
| All 10 Lambda handlers reference `initSentry`/`_shared/sentry` | PASS |
| All 10 Lambda handlers call `tagTraceWithCaptureId` | PASS |
| `packages/cdk/lib/stacks/observability-stack.ts` exists with `TelegramBotP95LatencyHigh` + `KosAlarmTopic` + threshold=1800 | PASS |
| `packages/cdk/bin/kos.ts` instantiates `new ObservabilityStack` with `addDependency(capture)` | PASS |
| `scripts/verify-observability.mjs` exists, executable, queries Langfuse by `sessionId` | PASS |
| `cdk synth KosObservability` succeeds | PASS |
| `pnpm --filter @kos/cdk test -- --run observability-stack` → 4/4 tests pass | PASS |
| Full CDK suite: 89/89 tests pass | PASS |
| Services (8 owned by Plan 02-10) typecheck + tests pass: 73/73 tests | PASS |

## Threat Flags

None — no new network surface, auth path, or trust-boundary changes introduced. Egress to api.langfuse.com + ingest.sentry.io was already declared in T-02-OBS-01/02 of the threat model and does not change.

## Next Phase Readiness

- Phase 3 dashboard work can use the same `_shared/sentry.ts` + `tagTraceWithCaptureId` pattern for any new Lambdas it adds.
- ObservabilityStack is the canonical place to add per-Phase alarms going forward — Phase 3+ should append to `agentLambdas` (or add new alarm classes) instead of creating parallel stacks.
- After first deploy: operator runs `aws sns subscribe --topic-arn $(aws cloudformation describe-stacks --stack-name KosObservability --query "Stacks[0].Outputs[?OutputKey=='KosAlarmTopicArn'].OutputValue" --output text) --protocol email --notification-endpoint kevin@tale-forge.app` (or via console).
- After first capture: operator runs `node scripts/verify-observability.mjs --capture-id <ulid>` to confirm Langfuse received the trace.

## Self-Check: PASSED

Verified all created files exist and both task commits are present in `git log`.

---
*Phase: 02-minimum-viable-loop*
*Completed: 2026-04-22*
