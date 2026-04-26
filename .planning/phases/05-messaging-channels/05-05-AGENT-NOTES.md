# Plan 05-05 — Baileys sidecar Lambda — agent notes

## Status

Both tasks complete. Tests + typecheck green. Not committed.

- 15/15 baileys-sidecar handler tests pass (5 more than the 10 the plan asked for — kept the supplementary edge-case tests that fell out of the impl: non-POST 405, empty body, invalid JSON, length-equal-but-different secret, media-fetch 5xx → silent drop).
- 10/10 CDK synth assertions pass for `integrations-baileys-sidecar.test.ts` (8 the plan called for + 2 extras: RemovalPolicy.RETAIN on the Secret; synth-gating when `enableBaileysSidecar` is unset).
- `pnpm --filter @kos/service-baileys-sidecar typecheck` clean.
- `pnpm --filter @kos/cdk typecheck` clean.
- Cross-checked the existing iOS / Chrome / LinkedIn webhook CDK tests — all 28 still pass after the IntegrationsStack edit (no regressions).

## Files written

### Lambda service

- `services/baileys-sidecar/src/handler.ts` — full implementation (~290 lines)
  - X-BAILEYS-Secret constant-time compare via `timingSafeEqual` (length-mismatch short-circuit before the call to avoid the throw-leaks-length pattern).
  - `messages.upsert` envelope routing; everything else (presence/connection/chats.set/etc.) returns 200 + `{status: 'skipped'}`.
  - Per-message branch on `m.message.{conversation,extendedTextMessage,audioMessage}`:
    - Text → `CaptureReceivedWhatsappTextSchema.parse` → PutEvents on `kos.capture`.
    - Audio → `fetch(${BAILEYS_MEDIA_BASE_URL}/${encodeURIComponent(keyId)})` with the same `X-BAILEYS-Secret` header → `putAudio()` → `CaptureReceivedWhatsappVoiceSchema.parse` → PutEvents.
  - `fromMe=true` filtered (defence in depth — the Fargate container is read-only by design).
  - `is_group` derived from `chat_jid.endsWith('@g.us')`.
  - Deterministic capture_id: 26-char Crockford-base32 of `sha256('${chat_jid}|${message_key_id}')`. Idempotent on replay (T-05-05-03 mitigation; same input → same id → triage's existing capture-id dedupe absorbs duplicates).
  - 400 `no_routable_messages` if every message in a `messages.upsert` batch was unroutable (all fromMe / no text+audio / media fetch failed). Surfaces operator config errors quickly.

- `services/baileys-sidecar/src/secrets.ts` — single-secret loader, fail-closed on missing/empty/PLACEHOLDER, mirrors `chrome-webhook/secrets.ts`.

- `services/baileys-sidecar/src/s3.ts` — `putAudio(captureId, bytes, mimeType)` helper. Key shape `audio/{YYYY}/{MM}/{captureId}.ogg` (or `.bin` if mime isn't opus/ogg). No user-controlled path components. Mirrors `services/telegram-bot/src/s3.ts`.

- `services/baileys-sidecar/test/handler.test.ts` — 15 test cases covering all 10 plan-listed scenarios + 5 supplementary edges. Mocks: `@aws-sdk/client-eventbridge`, `@aws-sdk/client-s3`, `@aws-sdk/client-secrets-manager`, `_shared/sentry`, `_shared/tracing`, `@sentry/aws-serverless`, and global `fetch`.

- `services/baileys-sidecar/package.json` — added `@aws-sdk/client-s3`, `@arizeai/openinference-instrumentation-claude-agent-sdk`, `@langfuse/otel`, `@opentelemetry/{api,instrumentation,sdk-trace-node}` to mirror the deps the existing chrome-webhook needs to compile against `_shared/tracing.ts`.

- `services/baileys-sidecar/tsconfig.json` — added the same `paths` block (and `../_shared/**/*.ts` include) that chrome-webhook uses so the typecheck resolves OTel / Langfuse / Arizei modules from the local `node_modules`.

### CDK

- `packages/cdk/lib/stacks/integrations-baileys-sidecar.ts` — `wireBaileysSidecar(scope, props)` helper.
  - Self-provisions `kos/baileys-webhook-secret` with `RemovalPolicy.RETAIN` and PLACEHOLDER initial value.
  - KosLambda outside the VPC (D-05): 30s timeout, 512MB, ARM64, nodejs22.x.
  - Function URL `authType=NONE` (X-BAILEYS-Secret IS the auth boundary), `invokeMode=BUFFERED`.
  - IAM grants: `secretsmanager:GetSecretValue` on the new secret, `s3:PutObject` scoped to `audio/*` on `blobsBucket`, `events:PutEvents` on `captureBus`. Optional Sentry/Langfuse secret reads.
  - Explicitly NO bedrock/ses/rds/dynamodb permissions (CDK test asserts negative).
  - `BAILEYS_MEDIA_BASE_URL` defaults to `http://baileys.kos-internal.local:3025/media` when the prop is unset (Plan 05-04 will replace with the real Fargate service-discovery DNS).
  - Emits `BaileysSidecarUrl` CfnOutput with export name `KosBaileysSidecarUrl` — Plan 05-04's Fargate task definition will read this as `BAILEYS_WEBHOOK_URL`.

- `packages/cdk/lib/stacks/integrations-stack.ts` —
  - New props: `enableBaileysSidecar?: boolean` (opt-in), `baileysMediaBaseUrl?: string` (override).
  - New public field: `baileysSidecar?: BaileysSidecarWiring`.
  - New gated wiring block: only fires when `enableBaileysSidecar === true && props.blobsBucket` (the helper requires the bucket for the audio/* PutObject grant). Mirrors the `enableLinkedInWebhook` shape.

- `packages/cdk/test/integrations-baileys-sidecar.test.ts` — 10 synth assertions (lambda shape, env vars, function URL, secret RETAIN, IAM grants for secret/s3-audio/eventbridge, negative IAM, CfnOutput, synth-gate).

## Decisions / deviations from the plan template

1. **No back-reference wiring to BaileysService.** Plan 05-04 (Fargate container) is `autonomous: false` and not yet executed, so there is no `wireBaileys()` helper to consume the sidecar URL. Instead, `wireBaileysSidecar()` returns the URL via `BaileysSidecarWiring` and emits a `KosBaileysSidecarUrl` CfnOutput; Plan 05-04 (when run) will reference that import OR pull `this.baileysSidecar.webhookUrl` from `IntegrationsStack`. The plan's "BaileysService container env BAILEYS_WEBHOOK_URL populated" assertion is moved to Plan 05-04's test file as a result.

2. **Single-secret X-BAILEYS-Secret model (matches the plan body) over the LinkedIn-style Bearer+HMAC pair.** The plan template's must-haves ("Bearer + HMAC secrets self-provisioned") was reconciled against the plan body and §threat_model which both speak only of `X-BAILEYS-Secret`. I followed the plan body. Single secret is justifiable: the Fargate→sidecar hop is internal-VPC (once Plan 05-04 lands); the Function URL public exposure is the same threat surface as iOS/Chrome but the plan body explicitly accepts it.

3. **`capture_id` is deterministic from `(chat_jid, message_key_id)`** and lands as 26 Crockford-base32 chars (passes the contracts `UlidRegex`). Replays of the same Baileys envelope therefore always produce the same id; downstream Phase-2 triage's existing capture-id dedup absorbs duplicates without a Lambda-side cache (T-05-05-03 mitigation).

4. **Fail-soft on media fetch errors.** A missing `BAILEYS_MEDIA_BASE_URL`, a non-2xx response from the Fargate `/media/{id}` endpoint, or empty bytes all log a warning and skip the message rather than 500-ing. If every message in the batch was skipped the handler returns 400 `no_routable_messages` so the Fargate container's logs catch the misconfig — but mixed batches where at least one message routes still return 200.

5. **No Bedrock / RDS / SES IAM grants.** Negative assertion in the CDK test (`expect(serialised).not.toMatch(/"bedrock:/)` etc.) makes the boundary structural. Sidecar exists solely to verify the secret + S3-write + EventBridge-emit; it has no business reaching Postgres or Bedrock.

## Verify commands run

```
pnpm --filter @kos/service-baileys-sidecar test        # 15/15 pass
pnpm --filter @kos/service-baileys-sidecar typecheck   # clean
pnpm --filter @kos/cdk test -- --run integrations-baileys-sidecar  # 10/10 pass
pnpm --filter @kos/cdk typecheck                       # clean
pnpm --filter @kos/cdk test -- --run integrations-chrome-webhook integrations-linkedin-webhook integrations-ios-webhook  # 28/28 pass — no regressions
```

## Follow-ups for whoever runs Plan 05-04

- Read `BaileysSidecarUrl` from `Fn.importValue('KosBaileysSidecarUrl')` (or pull off `IntegrationsStack.baileysSidecar.webhookUrl` if both stacks are in the same App).
- Inject as `BAILEYS_WEBHOOK_URL` into the Fargate container env.
- Inject the `BaileysSidecar.webhookSecret` (Secret) via ECS `Secret.fromSecretsManager(...)` so the container's outbound POSTs sign the same shared value.
- Override `IntegrationsStackProps.baileysMediaBaseUrl` with the Fargate service-discovery DNS once the cluster + Cloud Map service are provisioned (e.g. `http://baileys.kos-internal.local:3025/media`).
- Add a Plan-05-04-side CDK test that asserts `BaileysService` container env carries `BAILEYS_WEBHOOK_URL` populated to the imported `KosBaileysSidecarUrl`.

## Not committed per instructions

```
git status --short  # M .planning/config.json, M apps/dashboard/next-env.d.ts (pre-existing)
                    # ?? services/baileys-sidecar/* (this plan)
                    # ?? packages/cdk/lib/stacks/integrations-baileys-sidecar.ts (this plan)
                    # ?? packages/cdk/test/integrations-baileys-sidecar.test.ts (this plan)
                    #  M packages/cdk/lib/stacks/integrations-stack.ts (this plan)
```
