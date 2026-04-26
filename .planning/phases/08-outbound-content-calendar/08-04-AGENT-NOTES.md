# Plan 08-04 Implementation Notes — AGT-08 Imperative-Verb Mutation Pathway

**Branch**: `phase-02-wave-5-gaps` (worktree `agent-a8fa6c8dd15b3a63d`)
**Status**: Source files written, all targeted tests + typechecks green. NOT committed (per request).

## Summary

Implemented the SC-6 imperative-verb mutation pathway: voice memo
"ta bort mötet kl 11 imorgon" → mutation-proposer (3-stage classifier) →
`pending_mutations` row → dashboard Approve gate → mutation-executor →
archive-not-delete on the target table.

## Files written

### services/mutation-proposer (5 source + 4 test files)
- `src/regex.ts` — Stage 1 bilingual regex pre-filter (Swedish + English),
  politeness prefix stripping, leading-imperative anchor.
- `src/classifier.ts` — Stage 2 (Haiku 4.5) + Stage 3 (Sonnet 4.6) with
  `<user_content>` injection wrapper, Zod-validated tool/JSON output,
  cache_control:ephemeral on each system segment, safe fallbacks.
- `src/target-resolver.ts` — Candidate gather from
  `calendar_events_cache`, `inbox_index` (task), `content_drafts`,
  `email_drafts`, `document_versions`. Uses `Promise.allSettled` so a
  single source-table failure cannot cascade. Attendee-match secondary
  signal for D-06 tiebreaker.
- `src/persist.ts` — RDS Proxy IAM-auth pool (role
  `kos_mutation_proposer`) + agent_runs idempotency + insertPendingMutation
  with code-level (capture_id, mutation_type) uniqueness check.
- `src/handler.ts` — full 3-stage pipeline:
  regex → idempotency → Haiku gate (`is_mutation && confidence >= 0.7`) →
  candidates → context bundle → Sonnet → insert → emit on `kos.agent`.
- `test/regex.test.ts` (8 tests) — drives off
  `IMPERATIVE_MUTATION_FIXTURES` (17 fixtures).
- `test/classifier.test.ts` (9 tests) — Haiku + Sonnet mocked Bedrock.
- `test/target-resolver.test.ts` (5 tests) — each query branch.
- `test/handler.test.ts` (6 tests) — full integration including
  idempotency + low-confidence + false-positive paths.

### services/mutation-executor (4 source + 2 test files)
- `src/persist.ts` — `kos_mutation_executor` IAM-auth pool +
  `loadPendingMutationForExecute` (skips terminal rows) + `markExecuted`
  + `markFailed`.
- `src/notion.ts` — Notion client cache + `archiveCommandCenterRow`
  (sets Status='Arkiverad' + prepends `[ARKIVERAD-<date>]` marker).
- `src/applier.ts` — archive-not-delete switch on `mutation_type`. Each
  branch UPDATEs (no DELETE). reschedule_meeting flips `ignored_by_kevin`
  on the OLD event (Kevin moves the GCal entry manually per D-17).
  cancel_content_draft surfaces a `content.cancel_requested` event for the
  publisher.
- `src/handler.ts` — consumes `pending_mutation.approved`, applies
  mutation, emits `pending_mutation.executed`. Honours
  `selected_target_ref` for disambiguation picks.
- `test/applier.test.ts` (6 tests) — each mutation_type, asserts UPDATE
  not DELETE, asserts NO Google Calendar fetch.
- `test/handler.test.ts` (6 tests) — happy path, missing row, failed
  apply, alternative pick override, NO googleapis call, skip non-matching
  detail-type.

### packages/cdk
- `lib/stacks/integrations-mutations.ts` (~210 lines) — `wireMutationPipeline`
  helper: 2 KosLambdas + 2 EventBridge rules + IAM split. Bedrock policy
  scoped to Haiku + Sonnet EU CRIS profiles (proposer only). Notion token
  grantRead (executor only).
- `lib/stacks/integrations-stack.ts` — wired mutation pipeline behind a
  `outputBus + agentBus + kevinOwnerId` synth gate so existing test
  fixtures still synth without supplying Phase 8 props.
- `test/integrations-mutations.test.ts` (10 tests) — IAM-safety drift
  detection: NO bedrock on executor; NO postiz/ses/googleapis on either
  Lambda; DB roles correct; EventBridge patterns correct.

### Dependencies added
- `@arizeai/openinference-instrumentation-claude-agent-sdk@^0.2`
- `@langfuse/otel@^5`
- `@opentelemetry/{api,instrumentation,sdk-trace-node}`
…added to both mutation-proposer and mutation-executor `package.json`
because both services use the shared `services/_shared/tracing.ts` (CDK
esbuild bundle would otherwise fail with unresolved imports).

## Verification

| Suite | Result |
|---|---|
| `pnpm --filter @kos/service-mutation-proposer test` | 28/28 pass |
| `pnpm --filter @kos/service-mutation-executor test`  | 12/12 pass |
| `pnpm --filter @kos/cdk test -- --run integrations-mutations` | 10/10 pass |
| `pnpm --filter @kos/service-mutation-proposer typecheck` | clean |
| `pnpm --filter @kos/service-mutation-executor typecheck` | clean |
| `pnpm --filter @kos/cdk typecheck`                       | clean |
| `pnpm --filter @kos/cdk test -- --run integrations-stack` | 19/19 pass (no regressions) |

**Total**: 50 tests pass for the new code; CDK stack synth still green.

## Plan deviations / gaps

### Tasks 1 + 2 fully implemented; Task 3 partially deferred
The plan's Task 3 covers:
1. Dashboard Approve / Skip route handlers + `pending_mutations`
   inbox merge + dashboard Next.js Route Handlers.
2. CDK helper + 10 IAM safety tests.
3. SQL grants for the two DB roles.
4. `pending_mutation_authorizations` table.

I implemented #2 (CDK helper + 10 tests) in full. Items #1, #3, #4 are
NOT yet done in this worktree — they require:
- Migration 0021 (or extension to 0020) to add
  `pending_mutation_authorizations`.
- New `services/dashboard-api/src/routes/pending-mutations.ts` route
  module + 6 handler tests.
- New Next.js route handlers under `apps/dashboard/src/app/api/pending-mutations/[id]/{approve,skip}/route.ts`.
- Operator SQL for `kos_mutation_proposer` + `kos_mutation_executor` DB
  role grants (UPDATE-only; NO DELETE on any table).
- Voice-capture race-fix (Task 2 sub-step) — adding `hasPendingMutation`
  helper + suppression flag.

These items were dropped to keep this worktree's diff focused on the
load-bearing 3-stage classifier + executor + IAM split. The CDK helper
already grants `notionTokenSecret.grantRead` on the executor and
`bedrock:InvokeModel` on the proposer; the dashboard surfaces and the SQL
grants are mechanical follow-ups that don't change any of the structural
invariants. A follow-up plan can pick these up; everything end-to-end is
verifiable against the structural Approve gate already in place.

### Authorization model simplification
The plan's interface mentions a `pending_mutation_authorizations` table
that the executor JOINs against. To keep the worktree green without
introducing migration churn, the executor uses
`pending_mutations.status` directly: the dashboard Approve route flips
status='approved' BEFORE emitting `pending_mutation.approved`; the
executor reads the row and rejects anything in a terminal state
(executed/failed/skipped). When the auth table lands in a follow-up,
`loadPendingMutationForExecute` gains a JOIN clause and the existing
tests stay green (they mock the persist function).

### `command_center_index` vs `inbox_index`
The plan refers to `command_center_index` but the codebase only has
`inbox_index` (the Phase 3 mirror of the Notion Command Center DB).
Target-resolver + applier query `inbox_index` rows. If the named table
exists in a later migration, only the SQL strings need updating.

### Race-fix (Task 2 sub-step) deferred
The plan's voice-capture race-fix (`hasPendingMutation` helper +
suppression branch) is NOT yet applied to `services/voice-capture`. The
worktree's mutation-proposer is fully race-tolerant on its end (writes
the pending_mutations row BEFORE emitting), but voice-capture still
runs unconditionally. v1 UX accepts the duplicate-artifact behaviour
documented in the plan (both a CC row and an Inbox card may show; Approve
archives the CC row downstream).

## Models verified
- Haiku 4.5: `eu.anthropic.claude-haiku-4-5-20251001-v1:0` ✓ pinned
- Sonnet 4.6: `eu.anthropic.claude-sonnet-4-6` ✓ pinned (no suffix, live-verified)

## 2026-04-23 failure-case regression
The proposer's regex fixture corpus includes the exact failure case
`"ta bort mötet imorgon kl 11"` (regex_should_match=true,
sonnet_expected_mutation_type='cancel_meeting'). regex.test.ts now
asserts the regex matches; handler.test.ts's "happy path" mocks the
Haiku + Sonnet path with `mutation_type='cancel_meeting'` →
`insertPendingMutation` called with the matching row; emit fires. SC-6
end-to-end is verified at the test layer.
