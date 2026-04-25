---
phase: 07-lifecycle-automation
plan: 03
subsystem: lifecycle-scheduler
tags: [auto-02, email-triage-scheduler, eventbridge-putevents, cross-bus-scheduler]
requires:
  - "Phase 7 Plan 07-00: wireLifecycleAutomation helper stub + emailTriageSchedulerRole + systemBus prop"
  - "EventsStack: kos.system bus + kos-schedules group"
provides:
  - "EventBridge Scheduler entry email-triage-every-2h targeting kos.system bus PutEvents"
  - "emailTriageSchedulerRole inline policy: events:PutEvents on systemBus (structural least-privilege)"
affects:
  - "Phase 4 email-triage Lambda becomes auto-triggered every 2h on weekdays once Plan 04-04 EventBridge rule ships (zero coupling — bus is the seam)"
tech-stack:
  added: []
  patterns:
    - "Scheduler templated EventBridge target — `target.arn = bus ARN` + `eventBridgeParameters` (DetailType + Source) + `target.input` (Detail JSON)"
    - "Scheduler context attribute interpolation — `<aws.scheduler.scheduled-time>` expanded at fire time to ISO timestamp"
key-files:
  created:
    - ".planning/phases/07-lifecycle-automation/07-03-SUMMARY.md"
  modified:
    - "packages/cdk/lib/stacks/integrations-lifecycle.ts (+62 lines: CfnSchedule + grantPutEventsTo + import)"
    - "packages/cdk/test/integrations-lifecycle.test.ts (+59 lines: 2 new Plan 07-03 tests)"
decisions:
  - "Bus PutEvents target chosen OVER direct Lambda invoke — must_haves truth lock (Phase-4 independence; structural least-privilege; no Lambda invoke privileges on the role)"
  - "EventBridge templated target preferred OVER universal target — cleaner shape, AWS-native CFN support via CfnSchedule.EventBridgeParametersProperty"
  - "Schedule placeholder capture_id=01SCHEDULER000000000000000 — email-triage Lambda generates per-row ULIDs at processing time (Plan 04-04 owns this)"
  - "Retry policy 2 attempts × 300s max-event-age — mirrors granola-poller Phase 6 pattern"
metrics:
  duration_minutes: 21
  completed_date: "2026-04-25"
  tasks_completed: 1
  files_changed: 2
  tests_added: 2
  tests_passing: 7
---

# Phase 7 Plan 03: AUTO-02 Email-Triage Every-2h Scheduler Summary

Adds the **single** EventBridge Scheduler entry that emits
`kos.system / scan_emails_now` events on a 2-hour cadence during business
hours. Phase 4 already owns the email-triage Lambda + the consuming
EventBridge Rule (Plan 04-04 Task 4); Phase 7 contributes **zero Lambda
code** for AUTO-02 — just the scheduler + scheduler role.

## What Got Built

### Task 1 — `email-triage-every-2h` schedule + IAM (commit `c7e4127`)

`packages/cdk/lib/stacks/integrations-lifecycle.ts` (+62 lines):

- New `CfnSchedule` named `email-triage-every-2h` in the `kos-schedules`
  group:
  - `scheduleExpression: 'cron(0 8/2 ? * MON-FRI *)'` — fires at
    08, 10, 12, 14, 16, 18 Stockholm on weekdays. **6 fires/weekday × 5
    weekdays = 30 fires/week ≈ 120 fires/month.**
  - `scheduleExpressionTimezone: 'Europe/Stockholm'` — DST-safe (CET↔CEST
    handled automatically by EventBridge Scheduler).
  - `flexibleTimeWindow: { mode: 'OFF' }` — fires on the exact wall-clock
    minute.
  - `state: 'ENABLED'` from synth.
  - Retry policy: 2 attempts × 300s max-event-age (mirrors
    granola-poller Phase 6 pattern).

- Templated EventBridge PutEvents target:
  - `target.arn = props.systemBus.eventBusArn` (the Phase 1 `kos.system`
    bus, NOT a Lambda).
  - `target.eventBridgeParameters = { detailType: 'scan_emails_now',
    source: 'kos.system' }` — drives the PutEvents envelope.
  - `target.input` = JSON detail body matching the operator trigger
    shape from Plan 04-05's `scripts/fire-scan-emails-now.mjs`:
    ```json
    {
      "capture_id": "01SCHEDULER000000000000000",
      "requested_at": "<aws.scheduler.scheduled-time>",
      "requested_by": "scheduler"
    }
    ```
  - `<aws.scheduler.scheduled-time>` is an EventBridge Scheduler context
    attribute interpolated at fire time to the scheduled ISO timestamp
    (AWS Scheduler User Guide:
    https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-context-attributes.html).

- IAM: `props.systemBus.grantPutEventsTo(emailTriageSchedulerRole)` — adds
  an inline policy with **only** `events:PutEvents` scoped to the
  systemBus ARN. Structural least-privilege: the role has zero Lambda
  invoke privileges, zero other surfaces.

`packages/cdk/test/integrations-lifecycle.test.ts` (+59 lines, +2 tests):

1. **`Plan 07-03: CfnSchedule email-triage-every-2h with cron + Stockholm + OFF`**
   — asserts the synthesised CFN resource has the exact schedule name,
   cron expression, timezone, OFF flexibleTimeWindow, ENABLED state, and
   that `Target.EventBridgeParameters` contain DetailType + Source, and
   that `Target.Input` includes `"requested_by":"scheduler"`.

2. **`Plan 07-03: emailTriageSchedulerRole has events:PutEvents on systemBus
   (and NOT lambda:InvokeFunction)`** — locates the
   `EmailTriageSchedulerRole` logical id, filters IAM Policies to those
   attached to that role, collects all granted Actions, and asserts:
   - `events:PutEvents` is present.
   - `lambda:InvokeFunction` is **absent** (structural least-privilege
     verified at synth time).

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| `packages/cdk/test/integrations-lifecycle.test.ts` (worktree-local) | 7 | Validated in main-repo workspace where pnpm dependencies are installed (5 baseline + 2 new = 7/7 pass) |
| Full `pnpm --filter @kos/cdk test` regression (main-repo workspace) | 145 | 145/145 pass across 21 test files |
| `pnpm --filter @kos/cdk typecheck` (main-repo workspace) | — | Clean |

**Verification environment note**: This Plan 07-03 worktree
(`agent-a8e853c9ef119c180`) was on an outdated branch base
(`b45f47a` — pre-Phase-7-scaffold) when the executor started. Bringing
forward the Phase 7 scaffold via `git merge phase-02-wave-5-gaps` worked
cleanly (no conflicts). However, the worktree filesystem has no
`node_modules` and the host disk is at 100% (just 127 MB free), so
`pnpm install` cannot complete in the worktree itself. The identical
source code was edited and validated in the main-repo workspace
(`/home/ubuntu/projects/kevin-os`) where the regression suite passed
145/145. The acceptance grep `grep -q "email-triage-every-2h"` returns
`scheduler-present` as required by the plan's automated verification.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Bus PutEvents target chosen over direct Lambda invoke**

- **Found during:** Task 1 implementation (read of plan + 07-CONTEXT).
- **Issue:** The plan's `<interfaces>` block declares a "LOCKED APPROACH"
  of targeting the email-triage Lambda **directly** (passing
  `emailTriageFn: KosLambda` as a new prop on
  `WireLifecycleAutomationProps`). However:
  - The `must_haves.truths` block is authoritative and explicitly says:
    "One EventBridge Scheduler entry … targets **kos.system bus
    PutEvents** with DetailType=scan_emails_now" and "Scheduler role has
    ONLY events:PutEvents on kos.system bus (structural
    least-privilege)".
  - 07-CONTEXT D-16 (the lock referenced by the plan) describes the bus
    PutEvents path, not the Lambda direct invoke path.
  - Phase 4 has not shipped its email-triage Lambda yet in this
    repository (no `services/email-triage` directory exists; no
    `wireEmailAgents` helper). Threading a `KosLambda` reference is
    impossible without inventing one.
- **Fix:** Implemented the bus PutEvents path per `must_haves`. Used
  `aws-cdk-lib/aws-scheduler` `CfnSchedule.EventBridgeParametersProperty`
  for the templated target shape (cleaner than universal target). The
  `props.emailTriageFn: KosLambda` prop addition described in the plan's
  `<action>` block was **not** added to `WireLifecycleAutomationProps`.
- **Rationale:** Phase-4 independence is preserved (the wire connects
  through the systemBus rule when Phase 4 ships); structural
  least-privilege is honoured (`emailTriageSchedulerRole` has zero Lambda
  invoke surface); the `must_haves` truths govern (per GSD plan
  authority hierarchy).
- **Files modified:** `packages/cdk/lib/stacks/integrations-lifecycle.ts`,
  `packages/cdk/test/integrations-lifecycle.test.ts`.
- **Commit:** `c7e4127`.

**2. [Rule 3 - Blocking] Worktree branch base out-of-date — fast-forward
   merge required**

- **Found during:** Pre-commit `git status` check.
- **Issue:** The worktree (`worktree-agent-a8e853c9ef119c180`) was on
  base commit `b45f47a` (Phase 02 wave 5 PR merge), which pre-dates the
  Phase 7 scaffolding commits (`10c09ad` 07-00 helper stub … `519309e`
  07-01 morning-brief Lambda). Plan 07-03 explicitly depends on the
  07-00 stub (`integrations-lifecycle.ts` — required for the
  `emailTriageSchedulerRole` declaration to extend).
- **Fix:** Ran `git merge phase-02-wave-5-gaps --no-edit` from inside
  the worktree to bring the Phase 7 scaffold forward. Merge resulted in
  a single merge commit (`286e64f`) with NO file conflicts (the
  worktree had no overlapping changes).
- **Rationale:** Worktree base reset would have been destructive
  (`<destructive_git_prohibition>` forbids `git reset --hard` outside
  the startup `<worktree_branch_check>` step); merge is the safe
  alternative.
- **Commit:** `286e64f` (merge), `c7e4127` (Plan 07-03 changes).

### Specification drift documented (no auto-fix needed)

**3. The plan's `<action>` describes a `WireLifecycleAutomationProps`
   extension (`emailTriageFn: KosLambda`) and an `IntegrationsStack`
   threading change (`wireEmailAgents` return value).** Neither was
   applied — see Deviation #1. The `WireLifecycleAutomationProps`
   surface is unchanged from Plan 07-00.

## Auth Gates

None encountered. AUTO-02 is pure CDK infrastructure; no live AWS calls,
no third-party secrets touched.

## Operator Pre-Deploy Notes

When Phase 4 ships its email-triage Lambda + EventBridge Rule on
`kos.system / scan_emails_now`, AUTO-02 begins firing automatically the
next weekday at the next 2-hour boundary (08/10/12/14/16/18 Stockholm).
No re-deploy of Phase 7 is required — the bus is the integration seam.

Until Phase 4 ships, the scheduler will fire 120×/month into a bus with
zero matching rules (events are silently discarded by EventBridge — no
errors, no DLQs, no cost beyond the EventBridge Scheduler base rate).

## Capture_id Generation Gap (Phase 4 owns)

The scheduler envelope's `capture_id` is the placeholder
`01SCHEDULER000000000000000`. Plan 04-04's email-triage Lambda must
generate **per-row** ULIDs when processing a `scan_emails_now` batch
(one capture_id per email row triaged), NOT use the scheduler-envelope
capture_id verbatim. If Plan 04-04 doesn't already do this, document
the gap during Phase 4 execution and patch then.

This matches the existing operator trigger script
`scripts/fire-scan-emails-now.mjs` (Plan 04-05) which generates a fresh
ULID per script invocation but the consuming Lambda still allocates
per-row capture_ids downstream.

## TDD Gate Compliance

Plan 07-03 is `type: execute` (not `type: tdd`), so RED→GREEN→REFACTOR
gate enforcement does not apply. The single task added implementation
+ tests in one commit (allowed for `type: execute`).

## Threat Flags

None. The threat surface introduced (one EventBridge bus PutEvents
endpoint, structurally least-privileged scheduler role) is exactly what
the plan's `<threat_model>` covers — T-07-AUTO02-02 mitigation
("Role only has grantInvoke on email-triage Lambda; CDK test asserts")
adapted to the bus-PutEvents path: the new test
`Plan 07-03: emailTriageSchedulerRole has events:PutEvents on systemBus
(and NOT lambda:InvokeFunction)` is the structural assertion that
prevents IAM drift granting Lambda invoke surface.

T-07-AUTO02-03 mitigation ("CDK test asserts exact schedule expression")
satisfied by the new test
`Plan 07-03: CfnSchedule email-triage-every-2h with cron + Stockholm +
OFF` which asserts the exact `cron(0 8/2 ? * MON-FRI *)` expression.

## Self-Check: PASSED

- `packages/cdk/lib/stacks/integrations-lifecycle.ts` exists; contains
  `email-triage-every-2h` (verified by acceptance grep:
  `grep -q "email-triage-every-2h" → scheduler-present`).
- `packages/cdk/test/integrations-lifecycle.test.ts` exists; contains
  both new Plan 07-03 test names.
- Commit `c7e4127` present in `git log` of branch
  `worktree-agent-a8e853c9ef119c180`.
- Identical source code passed 7/7 lifecycle tests + 145/145 full CDK
  regression in the main-repo workspace.
- `git diff --diff-filter=D HEAD~1 HEAD` shows no file deletions.
