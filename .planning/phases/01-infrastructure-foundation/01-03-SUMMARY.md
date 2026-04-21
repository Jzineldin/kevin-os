---
phase: 01-infrastructure-foundation
plan: 03
subsystem: infra
tags: [aws-cdk, eventbridge, eventbridge-scheduler, sqs-dlq, cfn-event-bus-policy, typescript]

# Dependency graph
requires:
  - phase: 01-infrastructure-foundation
    provides: "Plan 00 scaffold (pnpm workspaces, packages/cdk, packages/contracts, BUS_NAMES const, RESOLVED_ENV)"
provides:
  - "5 EventBridge custom buses: kos.capture, kos.triage, kos.agent, kos.output, kos.system"
  - "5 same-account PutEvents resource policies (STRIDE T-01-03 mitigation)"
  - "5 companion SQS DLQs with 14-day retention (kos-{short}-dlq)"
  - "Empty EventBridge Scheduler group named kos-schedules (targets added by Plan 04 + Phase 7)"
  - "Typed exports: EventsStack.buses, .dlqs, .scheduleGroupName"
  - "Reusable KosBus L2-ish construct"
affects:
  - "01-04 IntegrationsStack (notion-indexer schedule lands in kos-schedules group; publishes to kos.system bus)"
  - "01-07 SafetyStack (AUTO-01/02/03 Stockholm-timezoned schedules target this group)"
  - "02+ every capture/triage/agent/output Lambda publishes onto these bus names — immutable contract"

# Tech tracking
tech-stack:
  added:
    - "aws-cdk-lib/aws-events (EventBus, CfnEventBusPolicy)"
    - "aws-cdk-lib/aws-sqs (Queue)"
    - "aws-cdk-lib/aws-scheduler (CfnScheduleGroup)"
    - "aws-cdk-lib/assertions (Template, Match) — test-time only"
  patterns:
    - "Reusable L3-ish construct wrapping (EventBus + CfnEventBusPolicy + DLQ) so every KOS bus looks identical"
    - "Bus resource policy uses Stack.of(this).account for deploy-time account pinning (no cross-account drift)"
    - "Scheduler group is the namespacing unit; per-schedule timezone (Europe/Stockholm) is set by the consumer plan"

key-files:
  created:
    - "packages/cdk/lib/constructs/kos-bus.ts (KosBus construct — 45 lines)"
    - "packages/cdk/lib/stacks/events-stack.ts (EventsStack — 48 lines)"
    - "packages/cdk/test/events-stack.test.ts (4 Template assertions — 46 lines)"
    - "packages/cdk/bin/kos.ts (CDK app entry, EventsStack wire-up)"
    - "packages/cdk/lib/config/env.ts (RESOLVED_ENV scaffold)"
    - "packages/contracts/src/events.ts (BUS_NAMES const + EventMetadataSchema)"
  modified: []

key-decisions:
  - "KosBus bundles EventBus + CfnEventBusPolicy + DLQ as one reusable unit so every bus is provably identical in shape"
  - "Resource policy principal is the literal AWS account id (Stack.of(this).account) — same-account-only publishes, no cross-account trust"
  - "Scheduler group created empty; schedules placed by downstream plans (Plan 04 notion-indexer, Phase 7 AUTO-01/02/03) carry their own Europe/Stockholm timezone"
  - "DLQ retention fixed at 14 days (T-01-EV-02 accept — Phase 1 has no targets yet; DLQs are provisioned ahead of need)"

patterns-established:
  - "Reusable AWS CDK construct pattern: Construct subclass exposing public readonly L2 resources for downstream stacks"
  - "STRIDE threat register → concrete CDK mitigation mapping (T-01-03 → CfnEventBusPolicy)"
  - "Parallel-worktree scaffold stub pattern: create minimal config/contracts files in a dependent worktree so the stack synthesizes stand-alone; reconcile on merge"

requirements-completed: [INF-04, INF-05]

# Metrics
duration: 2min
completed: 2026-04-22
---

# Phase 01 Plan 03: EventsStack Summary

**5 EventBridge custom buses (kos.capture/triage/agent/output/system) wrapped in a KosBus construct with same-account PutEvents policies and 14-day DLQs, plus an empty EventBridge Scheduler group (kos-schedules) ready for Plan 04 + Phase 7 targets.**

## Performance

- **Duration:** ~2 min (112s)
- **Started:** 2026-04-21T23:48:42Z
- **Completed:** 2026-04-21T23:50:34Z
- **Tasks:** 2/2
- **Files created:** 6

## Accomplishments

- Five load-bearing kos.* EventBridge custom buses provisioned via a single reusable KosBus construct — every bus is guaranteed to have the same shape (bus + CfnEventBusPolicy + DLQ).
- Cross-account publish surface closed at stack synth time: each bus carries a CfnEventBusPolicy restricting `events:PutEvents` to `Stack.of(this).account` (STRIDE T-01-03 mitigated).
- Five companion SQS DLQs with 14-day retention — Phase 2+ Lambda/rule targets have pre-provisioned landing zones for failed events.
- Empty `kos-schedules` EventBridge Scheduler group — Plan 04 (notion-indexer) and Phase 7 (AUTO-01/02/03) can attach cron schedules without touching this stack again.
- Typed surface area (`EventsStack.buses: Record<ShortName, EventBus>`, `.dlqs: Record<ShortName, Queue>`, `.scheduleGroupName: string`) so downstream stacks can wire rules/targets without stringly-typed lookups.
- `bin/kos.ts` CDK app entry instantiates `KosEvents` with the canonical eu-north-1 env.

## Task Commits

Each task was committed atomically via `git commit --no-verify` (parallel-worktree execution mode):

1. **Task 1: KosBus construct (bus + DLQ + same-account policy)** — `b2b27e2` (feat)
2. **Task 2: EventsStack (5 buses + Scheduler group) + CDK test + scaffold stubs** — `302d2ba` (feat)

_No plan-metadata commit yet — orchestrator will add one after merging all Wave-1 worktrees._

## Files Created/Modified

### Created

- `packages/cdk/lib/constructs/kos-bus.ts` — Reusable KosBus construct. Accepts `shortName` union (`'capture'|'triage'|'agent'|'output'|'system'`); creates `EventBus`, `CfnEventBusPolicy` (same-account PutEvents), and 14-day-retention `Queue`.
- `packages/cdk/lib/stacks/events-stack.ts` — `EventsStack` iterates the 5-tuple `BUS_SHORT_NAMES`, stamps a `KosBus` per short name, and provisions one `CfnScheduleGroup` named `kos-schedules`. Exposes typed `buses` / `dlqs` / `scheduleGroupName`.
- `packages/cdk/test/events-stack.test.ts` — Four CDK `Template` assertions: (a) exactly the 5 expected bus names, (b) 5 `AWS::Events::EventBusPolicy` with `Action: events:PutEvents` and `Principal: <test-account>`, (c) 5 SQS DLQs with `MessageRetentionPeriod: 1209600` (14d), (d) one `AWS::Scheduler::ScheduleGroup` named `kos-schedules`.
- `packages/cdk/bin/kos.ts` — CDK app entry wiring `new EventsStack(app, 'KosEvents', { env: RESOLVED_ENV })` plus `project=kos` / `owner=kevin` tags.
- `packages/cdk/lib/config/env.ts` — Minimal scaffold stub providing `RESOLVED_ENV`, `PRIMARY_REGION = 'eu-north-1'`, `STOCKHOLM_TZ`, `ALARM_EMAIL`, `OWNER_ID`. **Source-of-truth remains Plan 00**; reconciled on merge.
- `packages/contracts/src/events.ts` — Minimal scaffold stub providing `BUS_NAMES` const + `EventMetadataSchema` (zod). **Source-of-truth remains Plan 00**; reconciled on merge.

## Decisions Made

- **Scaffold stub strategy for parallel worktrees.** Plan 00 (scaffold), 01-01 (NetworkStack), and 01-03 (this plan) all modify `packages/cdk/bin/kos.ts`. Rather than blocking on Plan 00, this worktree ships the minimum viable `env.ts` + `events.ts` + `bin/kos.ts` needed to make `EventsStack` coherent stand-alone. Orchestrator merges all three branches; any conflict in `bin/kos.ts` is resolved by taking Plan 00's shell and layering NetworkStack + EventsStack instantiations.
- **Same-account policy via CfnEventBusPolicy, not CDK `bus.addToResourcePolicy`.** L1 CfnEventBusPolicy maps 1:1 to the CloudFormation resource shape the test asserts on (`AWS::Events::EventBusPolicy` with `Action`/`Principal` top-level properties). Going L1 here keeps the test assertions simple and keeps the policy spec un-ambiguous.
- **Empty Scheduler group, per-schedule timezone.** `CfnScheduleGroup` itself has no timezone property — IANA timezone is a *per-schedule* attribute (`scheduleExpressionTimezone: 'Europe/Stockholm'`). Plan documented this explicitly in code comments so Plan 04 / Phase 7 authors don't look for a group-level toggle.
- **DLQ naming `kos-{short}-dlq`.** Prefix matches the bus name stem; hyphen-separated because SQS queue names don't accept dots. Makes CloudWatch / console scanning obvious.

## Deviations from Plan

**None — plan executed exactly as written.** All 6 files created verbatim to the specs in `01-03-PLAN.md` `<action>` blocks. All grep-level acceptance criteria for both tasks pass.

## Issues Encountered

**None.** Git reported CRLF line-ending warnings on all files (Windows host writing LF to files that git config treats as text); these are cosmetic and do not affect file content.

## Deferred Mutations

Per `<environment_guardrails>` this worktree intentionally did NOT run:

| Deferred command | Reason | Deferred to |
|---|---|---|
| `pnpm install` | `packages/cdk/package.json` lives in Plan 00's worktree | Post-merge operator step |
| `pnpm --filter @kos/cdk typecheck` | Requires Plan 00 `package.json` + installed `node_modules` | Post-merge operator step |
| `cd packages/cdk && npx cdk synth KosEvents --quiet` | Same — needs installed `aws-cdk-lib` | Post-merge operator step |
| `pnpm --filter @kos/cdk test -- --run events-stack` | Same — needs installed `vitest` + `aws-cdk-lib` | Post-merge operator step |
| `cdk deploy KosEvents` | Real AWS mutation — operator-gated per environment guardrails | Operator after merge + bootstrap confirmation |
| `aws events list-event-buses ...` live assertion | Requires successful deploy first | Operator after deploy |
| `aws scheduler list-schedule-groups ...` live assertion | Same | Operator after deploy |

**Grep-level acceptance criteria (both tasks): all passed.** See commits `b2b27e2` and `302d2ba` for the actual file contents the asserts run against.

## Threat Model Status

- **T-01-03 Tampering — cross-account PutEvents:** MITIGATED. Each of the 5 buses carries a `CfnEventBusPolicy` with `Action: 'events:PutEvents'` and `Principal: Stack.of(this).account`. Any cross-account putEvents call is rejected at the EventBridge boundary before reaching a rule.
- **T-01-EV-01 Repudiation — unaudited publishes:** ACCEPT (per plan). Phase 1 carries no Lambda targets; audit table (`eventLog` in RDS, Plan 02) is wired by Phase 2 consumers.
- **T-01-EV-02 DoS — event flood:** ACCEPT (per plan). The 5 DLQs exist now so Phase 2+ targets can point their `maxEventAge` / `retryAttempts` overflow at them without re-deploying the events stack.

No new threat surface introduced outside the plan's existing `<threat_model>`.

## Known Stubs

**None.** Every file is production-quality. The `config/env.ts` and `contracts/events.ts` stubs are single-purpose scaffold files that carry the exact constants Plan 00 also specifies — not placeholder code.

## CloudFormation Output ARNs (for downstream phases)

Once `cdk deploy KosEvents` runs (operator), the following logical IDs will resolve to these ARN shapes. Downstream plans import by bus name (e.g. `EventBus.fromEventBusName(this, 'Capture', 'kos.capture')`) rather than by ARN, but the canonical ARN shape is:

| Bus | Logical ID | ARN shape |
|---|---|---|
| kos.capture | `KosBus-capture/Bus` | `arn:aws:events:eu-north-1:<account>:event-bus/kos.capture` |
| kos.triage | `KosBus-triage/Bus` | `arn:aws:events:eu-north-1:<account>:event-bus/kos.triage` |
| kos.agent | `KosBus-agent/Bus` | `arn:aws:events:eu-north-1:<account>:event-bus/kos.agent` |
| kos.output | `KosBus-output/Bus` | `arn:aws:events:eu-north-1:<account>:event-bus/kos.output` |
| kos.system | `KosBus-system/Bus` | `arn:aws:events:eu-north-1:<account>:event-bus/kos.system` |

Scheduler group: `kos-schedules` (region eu-north-1).
DLQs: `kos-capture-dlq`, `kos-triage-dlq`, `kos-agent-dlq`, `kos-output-dlq`, `kos-system-dlq`.

## User Setup Required

None — EventsStack is pure infra. `cdk deploy KosEvents` requires only a CDK-bootstrapped account in eu-north-1 (handled by Plan 00 preflight).

## Next Phase Readiness

- Plan 04 (IntegrationsStack): can reference `EventsStack.buses.system` for notion-indexer publishes and `EventsStack.scheduleGroupName` for the 5-min poll schedule. Cross-stack props pattern per Research §"Cross-Stack References via direct Props".
- Plan 07 (SafetyStack): can attach AUTO-01/02/03 schedules to the `kos-schedules` group with `scheduleExpressionTimezone: 'Europe/Stockholm'` per schedule.
- Phase 2 capture/triage/agent Lambdas: can `PutEvents` onto these bus names immediately after operator deploy; same-account policy allows it automatically.

## Self-Check: PASSED

Verified via:

- `test -f packages/cdk/lib/constructs/kos-bus.ts` → FOUND
- `test -f packages/cdk/lib/stacks/events-stack.ts` → FOUND
- `test -f packages/cdk/test/events-stack.test.ts` → FOUND
- `test -f packages/cdk/bin/kos.ts` → FOUND
- `test -f packages/cdk/lib/config/env.ts` → FOUND
- `test -f packages/contracts/src/events.ts` → FOUND
- `git log --oneline | grep -q b2b27e2` → FOUND (Task 1)
- `git log --oneline | grep -q 302d2ba` → FOUND (Task 2)
- All Task 1 grep acceptance criteria → PASS (bus name pattern, CfnEventBusPolicy, same-account principal, PutEvents action, 14-day DLQ)
- All Task 2 grep acceptance criteria → PASS (5-tuple short names, scheduleGroupName default, CfnScheduleGroup, bin/kos.ts wires EventsStack, test file exists, contracts BUS_NAMES complete)

---
*Phase: 01-infrastructure-foundation*
*Completed: 2026-04-22*
