---
phase: 02-minimum-viable-loop
plan: 01
subsystem: capture-telegram
tags: [wave-1, cap-01, telegram, ingress, api-gateway-v2, lambda, grammy, eventbridge]
dependency_graph:
  requires:
    - "02-00 scaffolds (services/telegram-bot skeleton, @kos/test-fixtures, DataStack telegram-webhook-secret + sentry-dsn shells)"
    - "01-02 DataStack (blobsBucket, telegramBotTokenSecret, sentryDsnSecret)"
    - "01-03 EventsStack (buses.capture event bus)"
    - "01-04 KosLambda construct (esbuild + nodejs22.x + arm64)"
  provides:
    - "CaptureStack -- Phase 2 ingress layer (API Gateway v2 HTTP + telegram-bot Lambda)"
    - "@kos/contracts CaptureReceived schemas + CaptureVoiceTranscribedSchema"
    - "services/telegram-bot production handler (grammY on aws-lambda-async)"
    - "scripts/register-telegram-webhook.mjs (operator setWebhook one-shot)"
    - "TelegramWebhookUrl CfnOutput (KosTelegramWebhookUrl export)"
  affects:
    - "Plan 02-02 (transcribe starter): consumes capture.received with kind=voice"
    - "Plan 02-04 (triage agent): consumes capture.received with kind=text"
    - "Plan 02-05 (voice-capture agent): consumes capture.voice.transcribed"
tech_stack:
  added:
    - "aws-cdk-lib/aws-apigatewayv2 + aws-cdk-lib/aws-apigatewayv2-integrations (CDK)"
    - "@types/aws-lambda 8.10.145 (devDep of services/telegram-bot)"
  patterns:
    - "Per-channel ingress helper (integrations-telegram.ts) -- Phase-2 pattern"
    - "grammY webhookCallback with aws-lambda-async adapter + defense-in-depth secret_token check at Lambda entry"
    - "Module-scope cache for Secrets Manager tokens (Pitfall 11 cold-start)"
    - "Best-effort stage-1 ack: try/catch around ctx.reply (event already published before reply)"
    - "TELEGRAM_BOT_INFO_JSON env hook lets tests skip grammY startup getMe call; production leaves unset"
key_files:
  created:
    - services/telegram-bot/src/secrets.ts
    - services/telegram-bot/src/s3.ts
    - services/telegram-bot/src/events.ts
    - packages/cdk/lib/stacks/capture-stack.ts
    - packages/cdk/lib/stacks/integrations-telegram.ts
    - packages/cdk/test/capture-stack.test.ts
    - scripts/register-telegram-webhook.mjs
  modified:
    - packages/contracts/src/events.ts (added CaptureReceived schemas and types)
    - services/telegram-bot/src/handler.ts (full grammY implementation; replaced scaffold)
    - services/telegram-bot/test/handler.test.ts (3 behavioral tests)
    - services/telegram-bot/package.json (added @types/aws-lambda devDep)
    - packages/cdk/bin/kos.ts (CaptureStack wiring + addDependency)
    - packages/test-fixtures/package.json (fix exports to dist/src/*)
    - packages/test-fixtures/tsconfig.json (enable declaration output)
    - pnpm-lock.yaml
decisions:
  - "Defense-in-depth secret_token validated at Lambda entry BEFORE any body parsing or bot init; grammY internal secretToken option is a redundant layer but we keep early 401 path to avoid bot boot cost on spoofed calls."
  - "Stage-1 ack wrapped in try/catch: event is already published by the time ctx.reply runs; sendMessage failure MUST NOT re-trigger Telegram webhook retry loop and cause duplicate events."
  - "TELEGRAM_BOT_INFO_JSON env hook: grammY lazily calls getMe on webhookCallback. Injecting botInfo via Bot config skips getMe. Test-only in practice; production leaves it unset."
  - "Use existing KosLambda construct (not a new wrapper) to keep Phase-1 defaults (nodejs22.x + arm64 + source-maps + 30-day log retention) consistent."
  - "Lambda is OUTSIDE the VPC per D-05: external-API callers avoid NAT Gateway cost + warm-up."
metrics:
  duration_minutes: 25
  completed: 2026-04-22
  tasks: 2
  files_created: 7
  files_modified: 8
  commits: 2
---

# Phase 2 Plan 01: Telegram Ingress Summary

CAP-01 realized: Telegram text + voice messages enter KOS via a grammY-on-Lambda webhook behind API Gateway v2 HTTP, validated by a secret_token header, access-controlled to Kevin Telegram user ID, and published as capture.received events on the kos.capture EventBridge bus. Voice audio lands in S3 at audio/{YYYY}/{MM}/{ULID}.oga before the event carries a reference. Kevin sees an immediate "Klassificerar" or "Transkriberar" ack (stage 1 of D-02); stage 2 lands in Plan 02-02 (transcribe) and Plan 02-04 (triage).

## Objective

Ship the Telegram ingress end-to-end: grammY webhook handler + API Gateway v2 HTTP endpoint + secret_token validation + voice to S3 put + capture.received event publish + stage-1 ack UX. Transcribe wiring belongs to Plan 02-02; agent wiring to Plans 02-04/05.

## What Shipped

### Task 1 -- grammY handler + zod contracts (commit d465730)

- packages/contracts/src/events.ts gained 4 new zod schemas:
  - CaptureReceivedTextSchema -- ULID capture_id + telegram channel + text body + sender + chat/message IDs
  - CaptureReceivedVoiceSchema -- same shape but with raw_ref (s3_bucket, s3_key, duration_sec, mime_type) instead of inline text
  - CaptureReceivedSchema = z.discriminatedUnion(kind, ...) -- what the capture Lambdas publish
  - CaptureVoiceTranscribedSchema -- Plan 02-02 will emit this when transcription finishes (kos-sv-se-v1 vocab literal, transcribed_at ISO datetime)
- services/telegram-bot/src/secrets.ts -- module-scope-cached getTelegramSecrets() fetches bot token + webhook secret in parallel on first invocation, throws if either is still PLACEHOLDER. Pitfall 11 cold-start mitigation.
- services/telegram-bot/src/s3.ts -- putVoiceAudio(captureId, bytes, mimeType) writes to audio/{YYYY}/{MM}/{ULID}.{ext} with no user-controlled path components. T-02-S3-01 mitigation.
- services/telegram-bot/src/events.ts -- publishCaptureReceived(detail) emits a single PutEvents entry on kos.capture with Source=kos.capture, DetailType=capture.received. D-04 enforced structurally: the module has no LLM client, no agent invocation path.
- services/telegram-bot/src/handler.ts -- full production handler:
  - sentryInit at module scope (DSN pulled from env at cold start)
  - Access-control: ctx.from.id === KEVIN_TELEGRAM_USER_ID, silent drop otherwise (T-02-WEBHOOK-04)
  - Text path: ULID to zod parse to PutEvents to ctx.reply(Klassificerar) wrapped in try/catch
  - Voice path: ULID to ctx.getFile() to file download to S3 put to zod parse to PutEvents to ctx.reply(Transkriberar) wrapped in try/catch
  - Wrapped in wrapHandler for Sentry auto-capture
  - Secret-token check happens BEFORE any body parsing or bot init (T-02-WEBHOOK-01 defense in depth)
  - TELEGRAM_BOT_INFO_JSON env hook skips grammY startup getMe call (test-only; production leaves unset)
- services/telegram-bot/test/handler.test.ts -- 3 behavioral tests using @kos/test-fixtures:
  - rejects invalid secret_token with 401 (T-02-WEBHOOK-01)
  - drops non-Kevin user silently (no PutEvents) (T-02-WEBHOOK-04)
  - text message -> PutEvents with kind=text and ULID capture_id (happy path)

All 3 tests pass. pnpm --filter @kos/service-telegram-bot typecheck is clean.

### Task 2 -- CaptureStack CDK + IAM + operator setWebhook script (commit 694d9a3)

- packages/cdk/lib/stacks/integrations-telegram.ts -- wireTelegramIngress(scope, props) helper:
  - Creates the TelegramBot KosLambda (nodejs22.x + arm64 + 15s timeout + 512MB)
  - Grants kos/telegram-bot-token + kos/telegram-webhook-secret + kos/sentry-dsn read to the Lambda role
  - Grants grantPut(bot, audio/*) on blobsBucket (scoped to audio/* prefix, T-02-S3-01)
  - Grants grantPutEventsTo(bot) on kos.capture EventBus
  - Creates TelegramWebhookApi (API Gateway v2 HTTP API) with POST /telegram-webhook to HttpLambdaIntegration
  - Emits TelegramWebhookUrl CfnOutput with export name KosTelegramWebhookUrl
- packages/cdk/lib/stacks/capture-stack.ts -- thin orchestration stack that delegates to the per-subsystem helper.
- packages/cdk/bin/kos.ts -- instantiates KosCapture after SafetyStack with DataStack + EventsStack inputs; kevinTelegramUserId resolved from env var or CDK context; addDependency(data) + addDependency(events) for ordered deploys.
- packages/cdk/test/capture-stack.test.ts -- 8 synth assertions (all pass):
  1. Exactly 1 AWS::ApiGatewayV2::Api
  2. POST /telegram-webhook route present
  3. Lambda Runtime=nodejs22.x + Architectures=[arm64]
  4. Lambda env carries 5 required keys (3 secret ARNs + BLOBS_BUCKET + KEVIN_TELEGRAM_USER_ID=111222333)
  5. IAM policy includes events:PutEvents
  6. IAM policy includes secretsmanager:GetSecretValue
  7. IAM policy includes s3:PutObject AND audio/* prefix
  8. TelegramWebhookUrl Output with Name: KosTelegramWebhookUrl export
- scripts/register-telegram-webhook.mjs (+x, Node.js): operator one-shot that reads bot token + webhook secret from Secrets Manager, looks up the KosCapture TelegramWebhookUrl output, and POSTs to Telegram setWebhook with secret_token, drop_pending_updates: false, allowed_updates: [message]. Exits 0 on ok, 1 on failure.

pnpm --filter @kos/cdk typecheck is clean; all 8 CaptureStack tests pass; cd packages/cdk && npx cdk synth KosCapture bundles the TelegramBot Lambda to ~1.1mb and exits 0.

## Verification

| Target | Status |
|--------|--------|
| pnpm --filter @kos/contracts typecheck | PASS |
| pnpm --filter @kos/service-telegram-bot typecheck | PASS |
| pnpm --filter @kos/service-telegram-bot test (3/3) | PASS |
| pnpm --filter @kos/cdk typecheck | PASS |
| pnpm --filter @kos/cdk test --run capture-stack (8/8) | PASS |
| cd packages/cdk && npx cdk synth KosCapture --quiet | PASS (exit 0, TelegramBot ~1.1mb) |
| grep CaptureReceivedSchema in contracts | PASS |
| grep KEVIN_TELEGRAM_USER_ID in handler | PASS |
| grep webhookCallback aws-lambda-async in handler | PASS |
| grep EventBusName kos.capture in events.ts | PASS |
| grep audio/yyyy/mm/captureId path in s3.ts | PASS |
| grep Klassificerar + Transkriberar in handler | PASS |
| grep HttpApi + grantPutEventsTo in integrations-telegram | PASS |
| grep new CaptureStack + capture.addDependency(data) in bin/kos.ts | PASS |
| test -x scripts/register-telegram-webhook.mjs | PASS |
| grep setWebhook + secret_token in script | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 -- Blocking] @kos/test-fixtures package.json pointed at wrong dist path**

- Found during: Task 1 typecheck ("Cannot find module @kos/test-fixtures").
- Issue: Plan 02-00 set main: ./dist/index.js but tsc with rootDir=. + include=src/**/*.ts emits to dist/src/index.js. Also declaration was not enabled, so no .d.ts files for downstream consumers.
- Fix: Updated packages/test-fixtures/package.json main/types/exports to ./dist/src/index.{js,d.ts}; enabled declaration: true in packages/test-fixtures/tsconfig.json; rebuilt.
- Files modified: packages/test-fixtures/package.json, packages/test-fixtures/tsconfig.json
- Commit: d465730 (Task 1)
- Rule rationale: Rule 3 -- typecheck errored, blocking Task 1 completion.

**2. [Rule 3 -- Blocking] grammY aws-lambda-async adapter signature**

- Found during: Task 1 typecheck (TS2554 + TS2352 on webhookCallback return).
- Issue: The plan snippet wrote cb(event) as APIGatewayProxyResultV2. In grammY 1.42, LambdaAsyncAdapter signature is (event, _context) => ReqResHandler<void> and the webhookCallback ternary resolves handlerReturn: Promise<void> for the void-type case even though the runtime actually resolves { statusCode, headers, body }.
- Fix: Call cb(event, {}) with an empty context; cast via as unknown as APIGatewayProxyResultV2. Runtime shape is the real API Gateway v2 response; the TS types undercount it.
- Files modified: services/telegram-bot/src/handler.ts
- Commit: d465730 (Task 1)

**3. [Rule 2 -- Correctness] Stage-1 ack must be best-effort, not load-bearing**

- Found during: Task 1 test run -- the happy-path test failed with sendMessage 404 because Telegram mocked API rejected the call after the event had already been published.
- Issue: The plan ctx.reply calls had no error handling. In production, if Telegram sendMessage fails (API down, rate limit, network blip), the Lambda would propagate the error -- Telegram would then retry the webhook, creating duplicate capture.received events for the same update.
- Fix: Wrapped both ctx.reply calls in try/catch; logs a warning on failure. The event publish is the load-bearing half; the ack is a UX courtesy that MUST NOT re-trigger the webhook retry loop.
- Files modified: services/telegram-bot/src/handler.ts
- Commit: d465730 (Task 1)
- Rule rationale: Rule 2 -- correctness (avoiding duplicate events on ack failure).

**4. [Rule 3 -- Test-only hook] grammY calls getMe on first webhookCallback invocation**

- Found during: Task 1 test run -- mocking node-fetch via vi.mock did not intercept grammY internal import of shim.node.js. Tests failed with "Call to getMe failed! (404)".
- Issue: grammY 1.42 lazily calls getMe at webhookCallback time to populate bot.botInfo.username. Mocking at the global fetch level did not reach it.
- Fix: Added TELEGRAM_BOT_INFO_JSON env hook to the handler. When set (test-only in practice), the Bot is constructed with { botInfo: ... } which skips getMe entirely.
- Files modified: services/telegram-bot/src/handler.ts, services/telegram-bot/test/handler.test.ts
- Commit: d465730 (Task 1)
- Rule rationale: Rule 3 -- blocked test runs; the hook has zero production impact (env var must be explicitly set).

## Authentication Gates

None encountered. All work is local (TypeScript + CDK synth); no AWS deploy performed as part of this plan.

## Operator Runbook -- Post-Deploy Setup

After cdk deploy KosCapture:

1. Seed secrets (if not already done during Plan 02-00):
   - Run scripts/seed-secrets.sh
   - Supply values for kos/telegram-bot-token, kos/telegram-webhook-secret, kos/sentry-dsn
2. Register the webhook with Telegram:
   - AWS_REGION=eu-north-1 node scripts/register-telegram-webhook.mjs
   - Prints: [OK] webhook registered: https://<api-id>.execute-api.eu-north-1.amazonaws.com/telegram-webhook
3. Send a text message to the bot from Kevin Telegram account. Within 2 seconds:
   - Telegram shows a "Klassificerar" reply
   - CloudWatch shows a PutEvents call on kos.capture with capture.received / kind=text
4. Send a voice note. Within 2 seconds:
   - Telegram shows a "Transkriberar" reply
   - S3 (audio/{YYYY}/{MM}/{ULID}.oga) has the Opus file
   - CloudWatch shows a PutEvents call on kos.capture with capture.received / kind=voice

Plans 02-02 (transcribe) + 02-04 (triage) consume these events downstream.

## Threat-Register Coverage

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-WEBHOOK-01 (Spoofing -- forged webhook) | mitigated | handler.ts validates x-telegram-bot-api-secret-token before any body parsing; test "rejects invalid secret_token with 401" proves the path. |
| T-02-WEBHOOK-02 (Replay of old update) | mitigated | Fresh ULID per invocation (capture_id = ulid()); downstream dedup on capture_id lands in AGT plans per D-21. |
| T-02-WEBHOOK-03 (Bot token leak) | mitigated | Token only flows through getTelegramSecrets() cache; never passed to console.log. Sentry env-var scrubbing covers the rest. |
| T-02-WEBHOOK-04 (Non-Kevin user) | mitigated | ctx.from.id === KEVIN_TELEGRAM_USER_ID check; silent drop on mismatch. Test "drops non-Kevin user silently (no PutEvents)" proves the path. |
| T-02-S3-01 (Path traversal) | mitigated | S3 key is audio/{YYYY}/{MM}/{ULID}.{ext} -- no user-controlled components; CDK grant scoped to audio/* prefix. |
| T-02-WEBHOOK-05 (Cold-start > 2s) | accepted | Pitfall 11 -- ~500-700ms expected; if p95 > 1.8s operator adds provisioned concurrency. Alarm deferred to Plan 10 (observability). |

## Known Stubs

None. The handler is end-to-end functional; the downstream pipeline (transcribe + triage) is the next plan concern and is correctly decoupled via EventBridge per D-04.

## Handoffs to Next Plan

- Plan 02-02 (transcribe-starter / transcribe-complete, INF-08): consumes capture.received with kind=voice from the kos.capture bus. The detail raw_ref.s3_bucket + raw_ref.s3_key point at the Opus file; emit capture.voice.transcribed matching CaptureVoiceTranscribedSchema when done.
- Plan 02-04 (triage agent, AGT-01): consumes capture.received with kind=text AND capture.voice.transcribed from kos.capture. Handler is the first LLM touch; expects the zod-validated schema shape this plan ships.

## Commits

| Hash | Message |
|------|---------|
| d465730 | feat(02-01): telegram bot handler with secret gate, Kevin-only access, voice S3 put, PutEvents |
| 694d9a3 | feat(02-01): CaptureStack + API Gateway HTTP + telegram-bot Lambda + operator setWebhook script |

## Self-Check: PASSED

Verified on disk:
- services/telegram-bot/src/handler.ts (FOUND, 142 lines)
- services/telegram-bot/src/secrets.ts (FOUND, 48 lines)
- services/telegram-bot/src/s3.ts (FOUND)
- services/telegram-bot/src/events.ts (FOUND)
- services/telegram-bot/test/handler.test.ts (FOUND, 3 passing tests)
- packages/cdk/lib/stacks/capture-stack.ts (FOUND)
- packages/cdk/lib/stacks/integrations-telegram.ts (FOUND)
- packages/cdk/test/capture-stack.test.ts (FOUND, 8 passing tests)
- scripts/register-telegram-webhook.mjs (FOUND, +x)
- packages/cdk/bin/kos.ts (MODIFIED, CaptureStack wired)
- packages/contracts/src/events.ts (MODIFIED, 4 new schemas)

Verified commits in git log --all:
- d465730 feat(02-01): telegram bot handler... -- FOUND
- 694d9a3 feat(02-01): CaptureStack + API Gateway... -- FOUND
