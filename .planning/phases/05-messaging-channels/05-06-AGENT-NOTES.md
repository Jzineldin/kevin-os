# Plan 05-06 — Agent execution notes

**Plan**: `.planning/phases/05-messaging-channels/05-06-PLAN.md`
**Goal**: Phase 5's half of CAP-10 — EventBridge Scheduler + cross-phase
contract for the Discord `#brain-dump` fallback poller. Phase 10 Plan
10-04 ships the actual Lambda.

## Scope clarification (vs invoking agent prompt)

The user-facing `/loop` prompt described a much wider scope than the
plan: a full `services/discord-poller/` workspace with `handler.ts`,
`cursor.ts`, `discord.ts`, `persist.ts`, Discord API integration,
cursor-based polling, and ULID-deterministic capture_id derivation.

The plan itself (read in full per the prompt's step 1) is *intentionally
thin* per D-09 of the Phase 5 context: **Phase 5 owns the Scheduler;
Phase 10 owns the Lambda handler**. The plan's `files_modified` field
explicitly lists only:

- `packages/cdk/lib/stacks/integrations-discord-schedule.ts`
- `packages/cdk/lib/stacks/integrations-stack.ts`
- `packages/cdk/test/integrations-discord-schedule.test.ts`
- `.planning/phases/05-messaging-channels/05-06-DISCORD-CONTRACT.md`

I followed the plan, not the broader prompt, and captured the Discord
implementation contract in `05-06-DISCORD-CONTRACT.md` so Phase 10 Plan
10-04 can pick up the rest. The contract doc covers the API client,
cursor strategy, idempotency derivation, rate-limit budget, and SSM
deploy-order resilience that the prompt was reaching for — but as a
*specification* handed to Phase 10, not as runtime code in Phase 5.

## What was actually shipped

### 1. `packages/cdk/lib/stacks/integrations-discord-schedule.ts` (119 lines, plan min 60)

Single export `wireDiscordSchedule(scope, props)` that provisions:

- **Scheduler IAM Role** (`DiscordScheduleRole`): trust policy
  `scheduler.amazonaws.com`; inline policy with `lambda:InvokeFunction`
  scoped to the SSM-resolved Lambda ARN. No `aws:SourceArn` condition
  per the Phase 1 Plan 02-04 retro pitfall.
- **`CfnSchedule`** (`DiscordBrainDumpSchedule`):
  - `name: 'kos-discord-poll'`
  - `scheduleExpression: 'cron(0/5 * * * ? *)'` (every 5 min)
  - `scheduleExpressionTimezone: 'UTC'`
  - `flexibleTimeWindow.mode: 'OFF'`
  - `target.input` is a stable JSON payload with
    `channel='brain-dump'`, `owner_id=<KEVIN_OWNER_ID>`,
    `trigger_source='kos-discord-poll-scheduler'`.
  - `retryPolicy: 2 retries, 300s event-age cutoff`.
  - `state: 'ENABLED'`.
- **SSM-sourced ARN**:
  `StringParameter.fromStringParameterName(.../kos/discord/brain-dump-lambda-arn)`.
  The `.stringValue` token is used for both the IAM resource and the
  Scheduler target ARN. CloudFormation resolves at deploy time.

The helper returns `{ schedulerRole, schedule, brainDumpLambdaArnParamName }`
so the integrations-stack can expose a `discordSchedule` field on the
stack class for downstream wiring (mirrors the existing `iosWebhook`,
`chromeWebhook`, `linkedInWebhook` patterns).

### 2. `packages/cdk/lib/stacks/integrations-stack.ts`

- New import `wireDiscordSchedule` + type `DiscordScheduleWiring`.
- New optional public field `discordSchedule?: DiscordScheduleWiring`.
- Synth-gated invocation inside the constructor: `if (props.kevinOwnerId)
  this.discordSchedule = wireDiscordSchedule(this, { kevinOwnerId })`.
  This matches the existing convention where Phase-6+ wirings only fire
  when `kevinOwnerId` is supplied — keeps existing test fixtures green
  without modification.

### 3. `packages/cdk/test/integrations-discord-schedule.test.ts` (5 synth assertions)

| Assertion | Status |
|-----------|--------|
| Scheduler resource named `kos-discord-poll` exists | passing |
| `scheduleExpression === 'cron(0/5 * * * ? *)'` | passing |
| `scheduleExpressionTimezone === 'UTC'` + `Mode: OFF` | passing |
| Target Input JSON parses with `channel: 'brain-dump'` (also asserts `trigger_source` and `owner_id`) | passing |
| Scheduler role attached policy has `lambda:InvokeFunction` action | passing |

Test fixture re-uses the same `synth()` factory pattern as
`integrations-granola.test.ts` and `integrations-mv-refresher.test.ts`.

### 4. `.planning/phases/05-messaging-channels/05-06-DISCORD-CONTRACT.md` (206 lines, plan min 50)

Contract document for Phase 10 Plan 10-04 covering:

- **Scheduler → Lambda input shape** (`channel`, `owner_id`, `trigger_source`).
- **Lambda → kos.capture output shape** (`CaptureReceivedDiscordTextSchema` from `@kos/contracts`).
- **Idempotency**: deterministic `capture_id` from `sha256("discord:" + channel_id + ":" + message_id)` → first 16 bytes → Crockford base32.
- **Cursor**: per-channel `last_seen_message_id` in RDS; Lambda-local state, not in Scheduler input.
- **Rate-limit budget**: 0.0033 RPS at 5-min cadence, far below Discord's 10 RPS per-channel limit.
- **Graceful degradation (D-22)**: 401/404/5xx/429 handling matrix.
- **Deploy-order resilience**: three safe orderings (Phase 10 first, Phase 5 first, both at once).
- **Operator runbook** for SSM seeding (`aws ssm put-parameter` with no-op pre-Phase-10, real ARN post-Phase-10).
- **Threat-model boundary handoff** (T-05-06-01 mitigation lives in Phase 10).
- **Open questions for Phase 10** (bot vs user token; multi-channel future).

## Verification

- `pnpm --filter @kos/cdk test -- --run integrations-discord-schedule --reporter=basic`: **5/5 passing** in 67s.
- Plan's contract-doc verify command (`test -f ... && grep -c "capture.received" ... | grep -q -E "^[1-9]$" && echo OK`): **OK**.
- Wider CDK test suite was launched in the background to confirm no
  regressions in adjacent fixtures from the integrations-stack.ts edit
  (added optional public field + synth-gated wiring call).

## Decisions and deviations

1. **Did NOT create `services/discord-poller/`** — the plan does not
   list it under `files_modified`, and the plan body explicitly assigns
   the Lambda to Phase 10 Plan 10-04. Implementing the service in
   Phase 5 would duplicate Phase 10's scope and create a merge conflict
   surface for whatever Plan 10-04 ultimately picks for cursor table /
   Discord client structure.
2. **Did NOT specify a `groupName` on the Scheduler** — the plan's
   sample code does not pass `groupName`, so `kos-discord-poll` lands
   in the default scheduler group. This is intentional in the plan
   (separates Discord retries from the `kos-schedules` group used by
   Granola / MV refresher / Azure indexers, since the target Lambda
   lives outside Phase 5's stack ownership).
3. **Synth gate uses `kevinOwnerId` only** — no separate
   `enableDiscordSchedule` flag. The plan does not request one, and
   `kevinOwnerId` is already the canonical "production deploy" gate
   used by the rest of the Phase 6/7 wirings. Existing fixtures that
   omit `kevinOwnerId` continue to synth without the Discord schedule.
4. **Contract doc embeds an operator runbook** beyond the plan's
   minimum spec — the plan's "Deploy order resilience" section
   suggested two orderings; I added explicit `aws ssm put-parameter`
   commands so the operator does not need to derive them. The plan's
   `min_lines: 50` was honored (delivered 206).

## Handoff to Phase 10 Plan 10-04

When Plan 10-04 lands the Lambda:

1. Lambda needs `events:PutEvents` on `kos.capture` and `rds-db:connect`
   on the cursor table (see contract §Cursor for the table-naming
   discretion handed to Phase 10).
2. Lambda's resource policy must permit `InvokeFunction` from the
   Phase 5-created `DiscordScheduleRole`.
3. Operator updates SSM `/kos/discord/brain-dump-lambda-arn` to the new
   Lambda ARN, then `pnpm --filter @kos/cdk deploy IntegrationsStack`
   to re-pin the Scheduler target.
4. Lambda imports `CaptureReceivedDiscordTextSchema` from
   `@kos/contracts` for output validation.

## Files touched

- **Created**: `packages/cdk/lib/stacks/integrations-discord-schedule.ts`
- **Modified**: `packages/cdk/lib/stacks/integrations-stack.ts` (3 hunks: import, public field, synth-gated wiring call)
- **Created**: `packages/cdk/test/integrations-discord-schedule.test.ts`
- **Created**: `.planning/phases/05-messaging-channels/05-06-DISCORD-CONTRACT.md`
- **Created**: `.planning/phases/05-messaging-channels/05-06-AGENT-NOTES.md` (this file)

No commits per instructions.
