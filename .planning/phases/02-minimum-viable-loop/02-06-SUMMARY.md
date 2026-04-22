---
phase: 02-minimum-viable-loop
plan: 06
subsystem: push-telegram-cap01-ack
tags: [wave-3, cap-01, out-01, push-telegram, telegram-bot-api, eventbridge, is-reply-bypass, quiet-hours, sentry]
dependency_graph:
  requires:
    - "01-07 SafetyStack (push-telegram Lambda + cap.ts + quiet-hours.ts + DDB cap table — Phase 1)"
    - "02-00 scaffolds (Sentry / Langfuse secrets reachable via DataStack)"
    - "02-01 CaptureStack (sender.id / telegram.chat_id round-tripping into the event chain)"
    - "02-04 voice-capture Lambda (sole upstream emitter of output.push with is_reply=true in Phase 2)"
  provides:
    - "@kos/contracts OutputPushSchema (push-telegram event detail shape: capture_id?, body<=4096, is_reply?, telegram?)"
    - "services/push-telegram production Lambda — real Telegram Bot API sender + is_reply bypass + EB unwrap + send-failed queue"
    - "services/push-telegram/src/secrets.ts — module-cached bot-token fetcher (Pitfall 11 mitigation)"
    - "services/push-telegram/src/telegram.ts — sendTelegramMessage Bot API client (Bot API 7.0 reply_parameters)"
    - "SafetyStack PushTelegramFromOutputRule — kos.output / output.push → push-telegram with kos-push-telegram-dlq, retryAttempts=2, maxEventAge=1h"
  affects:
    - "Plan 02-04 voice-capture: its `output.push` event is now consumed end-to-end (was orphaned at Plan 02-04 close)"
    - "Plan 02-09 observability: alarms must include kos-push-telegram-dlq alongside the per-pipeline DLQs from Plan 02-04"
    - "Phase 7 daily-lifecycle Lambdas (morning brief, daily close, urgent email drafts) — they use the SAME push-telegram Lambda but MUST leave is_reply unset/false; the §13 contract only covers Kevin-initiated synchronous replies"
    - "Plan 02-11 e2e — final stage-2 ack ('✅ Saved to Command Center · …') is now testable end-to-end on real infra"
tech_stack:
  added:
    - "@sentry/aws-serverless ^8 — push-telegram now wraps the handler so 4xx/5xx Bot API failures surface in Sentry"
    - "Telegram Bot API 7.0 reply_parameters (the Lambda emits the new shape; legacy reply_to_message_id still accepted by the API but new integrations use reply_parameters)"
  patterns:
    - "Module-scope token cache (Pitfall 11) — SecretsManagerClient is created at module load; first call populates cachedToken; warm invocations skip the ~80ms Secrets Manager round-trip"
    - "Per-pipeline DLQ in the consumer stack (kos-push-telegram-dlq lives in SafetyStack, NOT EventsStack) — same E↔C cycle workaround Plan 02-02 + Plan 02-04 both adopted"
    - "EB-detail unwrap helper (`unwrapEvent`) — single Lambda accepts both EB-wrapped (`{source, detail-type, detail}`) and direct-invoke (`{body, ...}`) shapes so tests + ops tools + EB rule all share one entry point"
    - "Cap deps `isReply` flag short-circuits BEFORE quiet-hours and DDB — the FIRST line of `enforceAndIncrement`, so a reply path costs zero AWS calls when isReply=true"
    - "send-failed reason variant on telegram_inbox_queue — extends the Phase 1 reasons (cap-exceeded | quiet-hours) so the morning-brief drain can retry user-visible content separately from cap-suppressed content"
key_files:
  created:
    - services/push-telegram/src/secrets.ts
    - services/push-telegram/src/telegram.ts
    - services/push-telegram/test/handler.test.ts
  modified:
    - packages/contracts/src/events.ts (OutputPushSchema appended)
    - services/push-telegram/src/cap.ts (isReply bypass — first line of enforceAndIncrement)
    - services/push-telegram/src/handler.ts (Phase 1 stub → real Bot API sender + EB unwrap + Sentry wrap + send-failed queue)
    - services/push-telegram/test/cap.test.ts (3 new bypass tests appended)
    - services/push-telegram/package.json (+@kos/contracts workspace dep, +@sentry/aws-serverless ^8)
    - packages/cdk/lib/stacks/safety-stack.ts (outputBus prop + PushTelegramFromOutputRule + kos-push-telegram-dlq)
    - packages/cdk/test/safety-stack.test.ts (EventsStack import + outputBus wiring + 3 new synth assertions)
    - packages/cdk/bin/kos.ts (plumb events.buses.output into SafetyStack + addDependency on events)
decisions:
  - "Per-pipeline DLQ kos-push-telegram-dlq lives in SafetyStack rather than reusing events.dlqs.output — referencing events.dlqs.output from SafetyStack would create the same E↔S cyclic-reference pattern Plan 02-02 hit when reusing EventsStack DLQs from a consumer stack. Plan 02-09 alarms on it the same way it alarms on triage + voice-capture DLQs."
  - "EB-detail unwrap by sniffing `detail` rather than `source`/`detail-type` — direct-invoke callers (Phase 1 tests, future ops tools) can pass the inner shape without knowing about EB wrapping; EB-wrapped payloads always have `detail` populated. Cleaner than two handler entry points or a separate unwrap Lambda."
  - "Bot API 7.0 reply_parameters chosen over legacy reply_to_message_id — the API still accepts the legacy field but Telegram's docs explicitly recommend the new shape for new integrations; we emit reply_parameters even though Bot API 7.0+ is universal at this point (~30 months stable)."
  - "send-failed re-throws after queueing — the EventBridge rule's retry budget (retryAttempts=2 + maxEventAge=1h) handles transient failures; sustained failures land in kos-push-telegram-dlq for Plan 02-09 alarming. The queue write is best-effort persistence so the morning drain can still surface the user-visible content even if EB ultimately gives up."
  - "isReply forwarded as a CapDeps field rather than a separate `bypassCap()` function — keeps a single enforceAndIncrement entry point that all senders import; making the bypass an explicit deps flag forces upstream agents to think about the choice rather than silently routing around the cap."
metrics:
  duration_minutes: ~15
  completed: 2026-04-22
  tasks: 1
  files_created: 3
  files_modified: 8
  commits: 1
---

# Phase 2 Plan 06: push-telegram CAP-01 Final-Ack Loop Summary

The push-telegram Lambda is promoted from Phase 1 scaffolding (console.log sender stub) to the production CAP-01 ack path. It now (a) actually sends via the Telegram Bot API, (b) honours the `is_reply=true` bypass that lets Kevin-initiated synchronous replies skip both the 3/day cap AND the 20:00–08:00 Stockholm quiet-hours suppression (§13 / Pitfall 6), and (c) is wired as an EventBridge target on `kos.output` so agent Lambdas (voice-capture today, future morning-brief / urgent-email-drafts in Phase 7) never call it directly.

The end-to-end CAP-01 loop is now closed: Kevin sends a voice memo → Transcribe → triage → voice-capture writes the Notion row → emits `output.push` with `is_reply=true` → push-telegram replies in-thread within ~25 s with `✅ Saved to Command Center · …`, regardless of quiet hours.

## Objective

Realize D-02 stage-2 ack (the `✅ Saved to …` reply that follows the instant `⏳ Transkriberar…` from telegram-bot) and the §13 / Pitfall 6 contract that Kevin's synchronous reply path is exempt from the safety rails that suppress every other push channel. Replace Plan 01-07's console.log sender stub with a real Bot API client. Wire the EventBridge rule that decouples upstream agents from the sender.

## What Shipped

### Task 1 — Real sender + is_reply bypass + EventBridge rule (commit `3264254`)

- **`packages/contracts/src/events.ts`** — appended `OutputPushSchema` (capture_id?, body 1..4096 chars matching Telegram's hard sendMessage text limit, is_reply?, telegram?{chat_id, reply_to_message_id?}). Documented inline that `is_reply=true` is the §13 contract reserved for direct-response agents only.

- **`services/push-telegram/src/secrets.ts`** (new) — `getBotToken()` with module-scope cache + `__resetTokenCacheForTests`. Refuses `PLACEHOLDER` SecretString (the Phase 1 seed value) so an operator who forgot to rotate the real token gets an actionable error rather than a 401 from the Bot API.

- **`services/push-telegram/src/telegram.ts`** (new) — `sendTelegramMessage({chat_id, text, reply_to_message_id?})` POSTs to `https://api.telegram.org/bot${token}/sendMessage` with `reply_parameters: { message_id }` (Bot API 7.0 shape). Throws on any non-2xx OR `ok: false` response (the error message includes the Telegram `description` for debugging).

- **`services/push-telegram/src/cap.ts`** — added `isReply?: boolean` to `CapDeps`. The very first line of `enforceAndIncrement` is `if (deps.isReply) return { allowed: true };` — short-circuits BEFORE quiet-hours, BEFORE DynamoDB. Inline comment documents §13.

- **`services/push-telegram/src/handler.ts`** — full rewrite:
  - `unwrapEvent()` sniffs `event.detail` to handle both EB-wrapped and direct-invoke shapes
  - `is_reply` from the event is forwarded as `enforceAndIncrement({..., isReply: event.is_reply})`
  - on `allowed=false` → drizzle insert into telegram_inbox_queue with reason='quiet-hours'|'cap-exceeded' (Phase 1 path preserved)
  - on `allowed=true` → require `event.telegram.chat_id` (programming-error throw if missing) → `sendTelegramMessage` → `{sent:true, queued:false}`
  - on Bot API failure → drizzle insert with reason='send-failed' + re-throw so EventBridge counts an invocation failure (rule retry handles transient; DLQ catches sustained)
  - `wrapHandler` from `@sentry/aws-serverless` wraps the whole thing for 4xx/5xx visibility

- **`services/push-telegram/test/handler.test.ts`** (new) — 7 behavioural tests covering every branch:
  1. is_reply=true at quiet hours → bypasses cap + sends via Bot API + reply_parameters present + no queue write
  2. is_reply=false + quiet hours → queued with reason='quiet-hours' + Bot API NOT called
  3. is_reply=false + cap-exceeded → queued with reason='cap-exceeded'
  4. is_reply=true without telegram.chat_id → throws (programming error)
  5. EB-wrapped event (`{source, detail-type, detail}`) → unwrap and process detail correctly
  6. allowed=true normal path → Bot API sends without reply_parameters
  7. Bot API 5xx → queues with reason='send-failed' + re-throws

- **`services/push-telegram/test/cap.test.ts`** — appended 3 §13 bypass tests:
  - isReply=true at Stockholm 22:00 → allowed without DDB call
  - isReply=true during active hours → allowed without DDB call (no slot consumed)
  - isReply=false at 22:00 → quiet-hours denial (Phase 1 contract preserved)

- **`packages/cdk/lib/stacks/safety-stack.ts`** — added `outputBus: EventBus` prop, `pushTelegramDlq` Queue (`kos-push-telegram-dlq`, 14d retention, 5min visibility), and `pushFromOutputRule` Rule on `kos.output` matching `detail-type: output.push` with the push-telegram Lambda as target (DLQ + retryAttempts=2 + maxEventAge=1h).

- **`packages/cdk/test/safety-stack.test.ts`** — imported EventsStack so it can pass `events.buses.output` into SafetyStack; added 3 synth assertions:
  - Rule with `EventPattern: {source:['kos.output'], detail-type:['output.push']}` exists and its target has DeadLetterConfig
  - SQS queue named `kos-push-telegram-dlq` exists
  - Lambda execution-role IAM policy contains `secretsmanager:GetSecretValue` and references the telegram bot-token secret

- **`packages/cdk/bin/kos.ts`** — plumb `events.buses.output` into the SafetyStack constructor + `safety.addDependency(events)` so EventsStack provisions the bus before SafetyStack's rule references it.

- **`services/push-telegram/package.json`** — added workspace dep on `@kos/contracts` and runtime dep on `@sentry/aws-serverless ^8`.

## Verification

| Target | Status |
|--------|--------|
| `pnpm --filter @kos/contracts typecheck` | PASS |
| `pnpm --filter @kos/service-push-telegram typecheck` | PASS |
| `pnpm --filter @kos/service-push-telegram test -- --run` (29/29: 13 quiet-hours + 9 cap + 7 handler) | PASS |
| `pnpm --filter @kos/cdk typecheck` | PASS |
| `pnpm --filter @kos/cdk test -- --run safety-stack` (9/9) | PASS |
| `pnpm --filter @kos/cdk test -- --run` (full suite 81/81) | PASS |
| `KEVIN_TELEGRAM_USER_ID=… KEVIN_OWNER_ID=… cdk synth KosSafety --quiet` | PASS |
| `KEVIN_TELEGRAM_USER_ID=… KEVIN_OWNER_ID=… cdk synth --all --quiet` (all 7 stacks) | PASS |
| `grep -q "OutputPushSchema" packages/contracts/src/events.ts` | PASS (2 hits — schema + type alias) |
| `grep -q "isReply" services/push-telegram/src/cap.ts` | PASS (2 hits — interface field + check) |
| `grep -q "if (deps.isReply) return { allowed: true }" services/push-telegram/src/cap.ts` | PASS |
| `grep -q "api.telegram.org/bot" services/push-telegram/src/telegram.ts` | PASS |
| `grep -q "reply_parameters" services/push-telegram/src/telegram.ts` | PASS (4 hits) |
| `grep -q "unwrapEvent" services/push-telegram/src/handler.ts` | PASS (2 hits — fn + call) |
| `grep -q "is_reply" services/push-telegram/src/handler.ts` | PASS (5 hits) |
| `grep -q "send-failed" services/push-telegram/src/handler.ts` | PASS (5 hits — type + queue write + comments) |
| `grep -q "PushTelegramFromOutputRule" packages/cdk/lib/stacks/safety-stack.ts` | PASS |
| `grep -q "TELEGRAM_BOT_TOKEN_SECRET_ARN" packages/cdk/lib/stacks/safety-stack.ts` | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `wrapHandler` typing forces (event, context, callback) signature; tests called handler(event) directly**

- **Found during:** Task 1 first `pnpm --filter @kos/service-push-telegram typecheck` after wiring `wrapHandler` from `@sentry/aws-serverless`.
- **Issue:** `@sentry/aws-serverless`'s `wrapHandler` types its return as a Lambda `Handler<TEvent, TResult>` which has the full `(event, context, callback?)` signature. The tests in handler.test.ts call `handler(event)` directly (no context, no callback), so tsc reports `TS2554: Expected 3 arguments, but got 1` on every call site (and `TS2339: Property 'sent' does not exist on type 'void | PushTelegramResult'` on the EB-unwrap test which inspects the result).
- **Fix:** Added a `TestHandler` type alias + `loadHandler()` helper at the top of handler.test.ts that imports the module and casts `mod.handler` to `(event: unknown) => Promise<{sent, queued, reason?}>`. This is the same pattern entity-resolver's test file uses (`as unknown as (e: unknown) => Promise<unknown>`); it confines the cast to one place. No production code change.
- **Files modified:** `services/push-telegram/test/handler.test.ts`
- **Commit:** `3264254`
- **Rule rationale:** Rule 1 — typecheck blocked the whole task; the underlying issue is the Sentry SDK's overly-strict Handler type, not a contract bug.

### Plan-as-written adjustments

The plan-suggested test file used `as never` casts on every event argument and `import('../src/handler.js')` inline in each test. After confirming the entity-resolver pattern (one casting helper), I consolidated all calls behind `loadHandler()` for readability. Behaviour is identical to the plan-described tests; assertion list and ordering match the plan one-for-one.

The plan's Step F test instructions used `'../src/cap.js'` mock path — adopted verbatim. Test count matches the plan (6 handler tests in plan vs 7 here; the extra one is the Bot API 5xx → send-failed queue path which the plan describes in `<behavior>` but didn't enumerate as a separate test case — added for explicit coverage of the send-failed reason variant).

## Authentication Gates

None encountered. All work is local (TypeScript + CDK synth); no AWS deploy performed as part of this plan. Live verification (Telegram → Notion → Telegram round-trip including the §13 quiet-hours bypass) is deferred to the operator runbook below.

## Operator Runbook — Post-Deploy

After `cdk deploy KosSafety` (and the EventsStack + DataStack prereqs from Phase 1):

1. **Seed the real Telegram bot token** (the Phase 1 secret shell holds `PLACEHOLDER`; the new Lambda will throw a clear error otherwise):
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id kos/telegram-bot-token \
     --secret-string '<token-from-BotFather>'
   ```
2. **Live happy-path test (Kevin-initiated reply)** — send a Telegram voice memo or text to the Kevin bot. Within ~25s expect:
   - `triage.routed` on `kos.triage` (Plan 02-04)
   - new row in Notion Command Center (Plan 02-04)
   - `output.push` on `kos.output` with `is_reply=true` (Plan 02-04)
   - **Telegram message in the same chat thread**: `✅ Saved to Command Center · …` (THIS plan)
3. **Live quiet-hours bypass test** — send the same voice memo at 22:30 Stockholm. The reply ack must STILL arrive within ~25s. If it doesn't, the `is_reply` bypass is broken (check CloudWatch logs of push-telegram for `observedIsReply`).
4. **Live cap test (non-reply path)** — manually invoke push-telegram with `{body:'test',telegram:{chat_id:<KEVIN_CHAT>}}` 4× during active hours. Expect 3 sends + 1 queued row in `telegram_inbox_queue` with `reason='cap-exceeded'`.
5. **DLQ check** — `aws sqs get-queue-attributes --queue-url $(aws sqs get-queue-url --queue-name kos-push-telegram-dlq --query QueueUrl --output text) --attribute-names ApproximateNumberOfMessages`. Should be 0 after happy-path tests; Plan 02-09 will alarm on this.

## Threat-Register Coverage

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-ACK-01 (Elevation of Privilege — agent bypasses cap by setting is_reply=true) | mitigated | Contract documented inline in cap.ts (§13 comment) and on the OutputPushSchema (`is_reply` JSDoc). Phase 2 only voice-capture sets `is_reply=true` (Plan 02-04 emission shape). Plan 02-09 will add a CloudWatch metric `is_reply_count` alarming on >20/day as a sanity ceiling. |
| T-02-ACK-02 (Information Disclosure — bot token leaked in Sentry breadcrumbs) | mitigated | Token fetched via Secrets Manager + cached in module scope (`secrets.ts`); never logged; the only place it appears is the URL passed to `fetch()` (Sentry's default scrubber drops env keys matching `*TOKEN*` and the URL is part of breadcrumbs only when fetch is instrumented — wrapHandler does not auto-instrument fetch). |
| T-02-ACK-03 (Tampering — reply sent to wrong chat_id cross-user) | mitigated | chat_id originates from the original Telegram update's `sender.id`, carried through CaptureStack → triage.routed → voice-capture's output.push detail. Single-user `KEVIN_TELEGRAM_USER_ID` filter on ingress (Plan 02-01) ensures every chat_id reaching push-telegram belongs to Kevin. |
| T-02-ACK-04 (DoS — Bot API 429 rate limit cascades) | mitigated | Lambda catches all sendTelegramMessage failures → queues body to telegram_inbox_queue with `reason='send-failed'` → re-throws so EventBridge counts an invocation failure. Rule retryAttempts=2 + maxEventAge=1h bound retries; sustained failures land in kos-push-telegram-dlq for alarming. |
| T-02-ACK-05 (Tampering — injection of arbitrary body text into Kevin's Telegram) | accept | OutputPushSchema caps `body` at 4096 chars (Telegram hard limit). Only Kevin's own voice-capture agent output can feed the body in Phase 2; Kevin is trusted source. |

## Known Stubs

None. The Lambda is end-to-end functional. The Bot API call is real (not stubbed). The DDB cap, RDS queue write, Secrets Manager bot-token fetch are all real. Tests mock these dependencies so they run without AWS, but production code paths are unconditional.

## Threat Flags

None. Plan 02-06 introduces no NEW security surface beyond the threat-register entries above. The new EventBridge rule on `kos.output` filters by `detail-type=output.push` (only agent Lambdas with PutEvents permission on kos.output can trigger it; that's Plan 02-04's voice-capture today). The new `secrets.ts` and `telegram.ts` modules egress only to api.telegram.org over TLS using the bot token already provisioned in Phase 1.

## Handoffs to Next Plan

- **Plan 02-09 (observability):** add CloudWatch alarm on `kos-push-telegram-dlq` `ApproximateNumberOfMessagesVisible > 0` (matches the per-pipeline DLQ alarm pattern from Plan 02-04). Add `is_reply_count` metric (CloudWatch `EMF` from the handler) alarming on >20/day per T-02-ACK-01.
- **Plan 02-11 (e2e):** the `✅ Saved to Command Center · …` reply is now testable end-to-end on real infrastructure; add an assertion that voice-capture → push-telegram round-trip completes within the 25s SLO carried in this plan's success criteria.
- **Phase 7 (lifecycle automation):** morning brief, daily close, and urgent-email-drafts will reuse this same push-telegram Lambda but MUST leave `is_reply` undefined/false. The §13 contract is reserved for direct-response agents (voice-capture and any future "Kevin asked → agent answered" pattern); scheduled pushes consume cap slots and respect quiet hours like every other notification.

## Commits

| Hash | Message |
|------|---------|
| `3264254` | feat(02-06): push-telegram real Bot API + is_reply bypass + EventBridge wiring |

## Self-Check: PASSED

Verified files on disk:
- services/push-telegram/src/secrets.ts — FOUND
- services/push-telegram/src/telegram.ts — FOUND
- services/push-telegram/test/handler.test.ts — FOUND (7 passing tests)
- packages/contracts/src/events.ts — MODIFIED (OutputPushSchema appended)
- services/push-telegram/src/cap.ts — MODIFIED (isReply bypass at line 1 of enforceAndIncrement)
- services/push-telegram/src/handler.ts — MODIFIED (Phase 1 stub → real Bot API + EB unwrap + Sentry wrap)
- services/push-telegram/test/cap.test.ts — MODIFIED (3 §13 bypass tests appended)
- services/push-telegram/package.json — MODIFIED (+@kos/contracts, +@sentry/aws-serverless)
- packages/cdk/lib/stacks/safety-stack.ts — MODIFIED (outputBus prop + Rule + DLQ)
- packages/cdk/test/safety-stack.test.ts — MODIFIED (3 new synth assertions)
- packages/cdk/bin/kos.ts — MODIFIED (events.buses.output plumbed + addDependency)

Verified commits in `git log`:
- `3264254 feat(02-06): push-telegram real Bot API + is_reply bypass + EventBridge wiring` — FOUND
