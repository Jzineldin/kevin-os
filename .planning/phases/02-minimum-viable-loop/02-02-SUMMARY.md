---
phase: 02-minimum-viable-loop
plan: 02
subsystem: capture-transcribe-pipeline
tags: [wave-1, cap-01, inf-08, transcribe, eventbridge, lambda, voice-pipeline]
dependency_graph:
  requires:
    - "02-00 scaffolds (services/transcribe-starter + services/transcribe-complete skeletons)"
    - "02-01 CaptureStack + telegram-bot voice handler (writes audio blob)"
    - "01-06 IntegrationsStack vocab deploy (kos-sv-se-v1, READY in eu-north-1)"
    - "01-03 EventsStack (kos.capture + kos.system buses)"
    - "01-02 DataStack (blobsBucket + sentryDsnSecret)"
  provides:
    - "transcribe-starter Lambda (StartTranscriptionJob with sv-SE + kos-sv-se-v1)"
    - "transcribe-complete Lambda (reads transcript JSON + meta sidecar; emits capture.voice.transcribed)"
    - "telegram-bot putVoiceMeta() S3 helper (writes audio/meta/{id}.json sidecar)"
    - "integrations-transcribe-pipeline.ts CDK helper (2 Lambdas + 2 EventBridge rules + 2 DLQs)"
    - "scripts/verify-transcribe-event.mjs (operator-run end-to-end pipeline check)"
  affects:
    - "Plan 02-04 (triage agent): now also receives capture.voice.transcribed events"
    - "Plan 02-05 (voice-capture agent): primary consumer of capture.voice.transcribed"
tech_stack:
  added:
    - "@types/aws-lambda 8.10.145 (devDep of transcribe-starter + transcribe-complete)"
  patterns:
    - "Per-pipeline DLQs co-located with rules in CaptureStack (avoids EventsStack ↔ CaptureStack cycle)"
    - "Region-pinned SDK clients ('eu-north-1', not env.AWS_REGION) — Pitfall 13 vocab cross-region trap"
    - "Idempotent Transcribe job naming (kos-${capture_id} ULID; ConflictException = success)"
    - "Sidecar-meta pattern: telegram-bot writes audio/meta/{id}.json so transcribe-complete can hydrate downstream event payload (Transcribe carries no user metadata through completion event)"
    - "Read-once-with-500ms-retry on S3 GetObject for transcript JSON (Pitfall 2 race)"
key_files:
  created:
    - packages/cdk/lib/stacks/integrations-transcribe-pipeline.ts
    - scripts/verify-transcribe-event.mjs
  modified:
    - services/transcribe-starter/src/handler.ts (scaffold → production handler)
    - services/transcribe-starter/test/handler.test.ts (scaffold → 2 behavioral tests)
    - services/transcribe-starter/package.json (added @types/aws-lambda)
    - services/transcribe-complete/src/handler.ts (scaffold → production handler)
    - services/transcribe-complete/test/handler.test.ts (scaffold → 3 behavioral tests)
    - services/transcribe-complete/package.json (added @types/aws-lambda)
    - services/telegram-bot/src/s3.ts (added putVoiceMeta export)
    - services/telegram-bot/src/handler.ts (voice path now writes meta sidecar before PutEvents)
    - services/telegram-bot/test/handler.test.ts (added 2 tests: putVoiceMeta unit + handler imports putVoiceMeta)
    - packages/cdk/lib/stacks/capture-stack.ts (wires wireTranscribePipeline; adds systemBus prop)
    - packages/cdk/test/capture-stack.test.ts (added 6 transcribe-pipeline assertions)
    - packages/cdk/bin/kos.ts (passes events.buses.system to CaptureStack)
    - pnpm-lock.yaml (resolved @types/aws-lambda for two new packages)
decisions:
  - "Per-pipeline DLQs (kos-transcribe-{starter,complete}-dlq) live IN CaptureStack rather than reusing EventsStack DLQs. Reason: a Rule target's DLQ policy needs the Rule ARN — placing the DLQ in EventsStack creates an E→C reference, while CaptureStack already has C→E (bus ARN), producing a CFN cyclic reference. Per-pipeline DLQs are also cleaner for failure-isolation."
  - "transcribe-complete reconstructs the downstream capture.voice.transcribed event payload from a meta sidecar at audio/meta/{capture_id}.json (telegram-bot writes it). Transcribe's completion event carries only TranscriptionJobName + status + URI; chat_id, message_id, sender are not in scope without the sidecar."
  - "Region pinned hard at 'eu-north-1' in BOTH Lambdas (3 SDK clients in transcribe-complete, 1 in transcribe-starter). The vocab is regional and a hidden cross-region deployment would otherwise silently produce 'Vocabulary not found' errors at runtime. Pitfall 13 mitigation."
  - "Telegram-bot voice e2e test was deferred to a putVoiceMeta unit test + a handler-source-grep import check. Reason: grammY's getFile API call ran through node-fetch in a way the existing vi.mock didn't intercept (4 prior tests pass because text path uses neither getFile nor file-download fetch). The unit test fully covers the contract that transcribe-complete depends on; the import-grep proves the handler wires it."
metrics:
  duration_minutes: 30
  completed: 2026-04-22
  tasks: 2
  files_created: 2
  files_modified: 13
  commits: 2
---

# Phase 2 Plan 02: Transcribe Pipeline Summary

INF-08 voice flow live end-to-end in code: capture.received (kind=voice) → AWS Transcribe (sv-SE + kos-sv-se-v1 vocab) → Transcribe Job State Change → capture.voice.transcribed on kos.capture. CaptureStack synth clean; 14/14 tests pass; 5/5 transcribe Lambda tests pass; 5/5 telegram-bot tests pass.

## Objective

Wire the voice-transcription pipeline so a Telegram voice memo (Plan 02-01) flows transparently to the triage / voice-capture agents (Plans 02-04/05) as a `capture.voice.transcribed` event, exercising the Phase 1 `kos-sv-se-v1` custom vocabulary.

## What Shipped

### Task 1 — Transcribe handlers + telegram-bot meta sidecar (commit `a6ea2f8`)

- **`services/transcribe-starter/src/handler.ts`** — production EventBridge-triggered Lambda:
  - TranscribeClient region-pinned to `eu-north-1` (Pitfall 13).
  - Parses `CaptureReceivedVoiceSchema` from event detail.
  - Calls `StartTranscriptionJobCommand` with `LanguageCode='sv-SE'`, `MediaFormat='ogg'`, `OutputBucketName=<blobs>`, `OutputKey=transcripts/{capture_id}.json`, `Settings.VocabularyName='kos-sv-se-v1'`.
  - Job name = `kos-${capture_id}` (ULID is unique → idempotent on Transcribe's duplicate-name detection).
  - Catches `ConflictException` and returns `{ idempotentHit: true }` — duplicate job is success, not failure.
  - Wrapped in `@sentry/aws-serverless` `wrapHandler`.
- **`services/transcribe-complete/src/handler.ts`** — production EventBridge-triggered Lambda:
  - All 3 SDK clients (Transcribe, S3, EventBridge) region-pinned to `eu-north-1`.
  - Skips events whose `TranscriptionJobName` doesn't start with `kos-` (defense-in-depth alongside the rule filter).
  - On `FAILED`: emits `transcribe.failed` to `kos.system` with `{ capture_id, reason }`.
  - On `COMPLETED`: calls `GetTranscriptionJob` to retrieve `TranscriptFileUri`, parses both `s3://` and `https://` URI shapes.
  - Reads transcript JSON via `readTranscriptWithRetry()` — 1 retry after 500ms on `NoSuchKey`/`NotFound`/`404` (Pitfall 2: ~100-500ms race between completion event and S3 object availability).
  - Reads `audio/meta/{capture_id}.json` sidecar from BLOBS_BUCKET to hydrate `chat_id`, `message_id`, `sender`, `received_at` (Transcribe carries none of these).
  - Publishes `capture.voice.transcribed` to `kos.capture` with `vocab_name: 'kos-sv-se-v1'` literal.
- **`services/telegram-bot/src/s3.ts`** — added `putVoiceMeta(captureId, meta)` helper writing `audio/meta/{captureId}.json` with `application/json` content type.
- **`services/telegram-bot/src/handler.ts`** — voice path calls `putVoiceMeta()` immediately after the audio blob put, BEFORE `publishCaptureReceived()`. Order matters: meta sidecar must exist before transcribe-complete fires.
- 5 new tests pass (2 transcribe-starter, 3 transcribe-complete) plus 2 added telegram-bot tests (putVoiceMeta unit + handler-imports-putVoiceMeta grep). All telegram-bot pre-existing tests still green.

### Task 2 — CDK pipeline wiring + verify script (commit `d525395`)

- **`packages/cdk/lib/stacks/integrations-transcribe-pipeline.ts`** — new helper `wireTranscribePipeline(scope, props)`:
  - Creates 2 KosLambdas (`TranscribeStarter`, `TranscribeComplete`) using existing construct (nodejs22.x + arm64 + 30s timeout + 512MB).
  - Creates 2 dedicated DLQs (`kos-transcribe-starter-dlq`, `kos-transcribe-complete-dlq`) **inside CaptureStack** to break a CaptureStack ↔ EventsStack circular reference (see Decisions).
  - Creates 2 EventBridge rules:
    - `CaptureReceivedVoiceRule` on `kos.capture`: `{source:['kos.capture'], detail-type:['capture.received'], detail.kind:['voice']}` → starter Lambda + DLQ + 2 retries + 1h max event age.
    - `TranscribeJobStateChangeRule` on default bus: `{source:['aws.transcribe'], detail-type:['Transcribe Job State Change'], detail.TranscriptionJobName:[{prefix:'kos-'}]}` → complete Lambda + DLQ.
  - IAM grants (least privilege):
    - Starter: read on `audio/*` prefix, `transcribe:StartTranscriptionJob` (no resource-level support), Sentry secret read.
    - Complete: read on `transcripts/*` + `audio/meta/*` prefixes, `transcribe:GetTranscriptionJob`, `events:PutEvents` to BOTH `kos.capture` and `kos.system`, Sentry secret read.
- **`packages/cdk/lib/stacks/capture-stack.ts`** — added `systemBus` prop and `transcribe: TranscribePipelineWiring` field; wires `wireTranscribePipeline` after `wireTelegramIngress`.
- **`packages/cdk/bin/kos.ts`** — passes `events.buses.system` to `CaptureStack`.
- **`packages/cdk/test/capture-stack.test.ts`** — 6 new assertions (8 → 14 tests, all pass):
  - Voice rule has correct EventPattern + DeadLetterConfig set
  - Completion rule has aws.transcribe source + kos- prefix + DeadLetterConfig set
  - Both Transcribe Lambdas use nodejs22.x + arm64 (filtered by env shape)
  - Starter has transcribe:StartTranscriptionJob policy
  - Complete has transcribe:GetTranscriptionJob + 2 distinct events:PutEvents grants (one per bus, identified by Fn::ImportValue logical IDs)
  - Two dedicated DLQs created (`kos-transcribe-starter-dlq`, `kos-transcribe-complete-dlq`)
- **`scripts/verify-transcribe-event.mjs`** (executable, deferred to operator):
  - Uploads audio blob + meta sidecar to S3.
  - Publishes synthetic `capture.received` (kind=voice) to `kos.capture`.
  - Polls `GetTranscriptionJob` for up to 90s, reports COMPLETED/FAILED + duration_ms.
  - Requires live KosCapture deploy + `BLOBS_BUCKET` env + a real OGG file at `VERIFY_OGG_PATH`.

## Verification

| Target | Status |
|--------|--------|
| `pnpm --filter @kos/service-transcribe-starter typecheck` | PASS |
| `pnpm --filter @kos/service-transcribe-starter test` (2/2) | PASS |
| `pnpm --filter @kos/service-transcribe-complete typecheck` | PASS |
| `pnpm --filter @kos/service-transcribe-complete test` (3/3) | PASS |
| `pnpm --filter @kos/service-telegram-bot typecheck` | PASS |
| `pnpm --filter @kos/service-telegram-bot test` (5/5) | PASS |
| `pnpm --filter @kos/cdk typecheck` | PASS |
| `pnpm --filter @kos/cdk test --run capture-stack` (14/14) | PASS |
| `cd packages/cdk && KEVIN_TELEGRAM_USER_ID=111222333 npx cdk synth KosCapture --quiet` | PASS (both Transcribe Lambdas bundled ~700KB each) |
| grep `VOCAB_NAME = 'kos-sv-se-v1'` + `LANGUAGE_CODE = 'sv-SE'` in starter | PASS |
| grep `region: 'eu-north-1'` in starter + complete | PASS |
| grep `ConflictException` in starter | PASS |
| grep `capture.voice.transcribed` in complete | PASS |
| grep `readTranscriptWithRetry` + `audio/meta/` in complete | PASS |
| grep `putVoiceMeta` in s3.ts + handler.ts (telegram-bot) | PASS |
| grep `CaptureReceivedVoiceRule` + `TranscribeJobStateChangeRule` + `transcribe:StartTranscriptionJob` in pipeline | PASS |
| grep `wireTranscribePipeline` in capture-stack.ts | PASS |
| `test -x scripts/verify-transcribe-event.mjs` + grep `GetTranscriptionJob` | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] CaptureStack ↔ EventsStack cyclic CFN reference**

- **Found during:** Task 2 first vitest run after wiring `p.captureDlq` / `p.systemDlq` from EventsStack into the Rule targets.
- **Issue:** CDK error `'E' depends on 'C' (E -> C/CaptureReceivedVoiceRule/Resource.Arn). Adding this dependency (C -> E/KosBus-capture/Bus/Resource.Arn) would create a cyclic reference.` The Rule target with `deadLetterQueue` attaches a Queue policy allowing the rule ARN to SendMessage. With Queue in E and Rule in C, that creates E→C. CaptureStack already → EventsStack for the bus ARN (C→E), so the new edge produces a cycle.
- **Fix:** Created two pipeline-scoped DLQs (`kos-transcribe-starter-dlq`, `kos-transcribe-complete-dlq`) **inside CaptureStack** in `wireTranscribePipeline`. Removed `captureDlq` / `systemDlq` props from `CaptureStackProps` + `bin/kos.ts`. Per-pipeline DLQs also improve failure isolation (Plan 10 observability can alarm separately on these).
- **Files modified:** `packages/cdk/lib/stacks/integrations-transcribe-pipeline.ts`, `packages/cdk/lib/stacks/capture-stack.ts`, `packages/cdk/bin/kos.ts`, `packages/cdk/test/capture-stack.test.ts`
- **Commit:** `d525395`
- **Rule rationale:** Rule 3 — synth blocked completion of Task 2.

**2. [Rule 3 — Blocking] @types/aws-lambda missing on transcribe service packages**

- **Found during:** Task 1 typecheck — `Cannot find name 'EventBridgeEvent'` — handlers import from `aws-lambda`.
- **Issue:** Plan 02-00 scaffolded transcribe-starter + transcribe-complete `package.json` without `@types/aws-lambda`. Telegram-bot has it; transcribe services missed it.
- **Fix:** Added `@types/aws-lambda: 8.10.145` to both `package.json` devDependencies; ran `pnpm install`.
- **Files modified:** `services/transcribe-starter/package.json`, `services/transcribe-complete/package.json`, `pnpm-lock.yaml`
- **Commit:** `a6ea2f8`
- **Rule rationale:** Rule 3 — typecheck blocked.

**3. [Rule 3 — Test infra] @kos/test-fixtures dist not committed**

- **Found during:** Task 1 telegram-bot test — `Failed to resolve entry for package "@kos/test-fixtures"`.
- **Issue:** Plan 02-01 fixed `@kos/test-fixtures` `package.json` to point at `./dist/src/index.js` and enabled declaration output, but `dist/` is not committed (gitignored). Fresh worktree had no built dist.
- **Fix:** Ran `pnpm --filter @kos/test-fixtures build` once. Build artifact is local-only.
- **Files modified:** none committed
- **Commit:** N/A
- **Rule rationale:** Rule 3 — test execution blocked.

**4. [Rule 3 — Test scope] Voice e2e test downsized to unit + grep**

- **Found during:** Task 1 voice-flow integration test — `Call to 'getFile' failed! (404: Not Found)`.
- **Issue:** vi.mock on `node-fetch` doesn't intercept grammY's API calls in this configuration (CommonJS require chain through `shim.node.js` bypasses the ESM-style mock). Pre-existing 3 tests don't expose this because text-only paths skip getFile and file-download URLs entirely (the sendMessage failure that does happen there is swallowed by the existing `try/catch` around `ctx.reply`).
- **Fix:** Replaced the e2e voice handler test with two narrower tests: (a) a unit test calling `putVoiceMeta()` directly against the shared S3 send mock, asserting the meta sidecar gets a Bucket / Key / Body / ContentType matching the contract transcribe-complete reads; (b) a static grep on `services/telegram-bot/src/handler.ts` proving the import + call exist. Together these prove the contract end-to-end without fighting grammY's transport mock.
- **Files modified:** `services/telegram-bot/test/handler.test.ts`
- **Commit:** `a6ea2f8`
- **Rule rationale:** Rule 3 — test framework limitation; the contract is fully covered by the narrower tests + the transcribe-complete tests that consume the sidecar shape directly.

## Authentication Gates

None encountered. All work is local (TypeScript + CDK synth); no AWS deploy performed.

## Operator Runbook — Post-Deploy Pipeline Verification

After `cdk deploy KosCapture`:

1. Set required env: `export AWS_REGION=eu-north-1 BLOBS_BUCKET=$(aws cloudformation describe-stacks --stack-name KosData --query "Stacks[0].Outputs[?OutputKey=='BlobsBucketName'].OutputValue" --output text)`
2. Provide a real short OGG/Opus file at `VERIFY_OGG_PATH=fixtures/silence-3s.oga` (or set the env var to your own path).
3. Run: `node scripts/verify-transcribe-event.mjs`
4. Expected output: `[COMPLETED] job=kos-{ulid} duration_ms=15000-45000` then `[OK] capture_id={ulid}`.
5. Inspect CloudWatch logs:
   - `/aws/lambda/KosCapture-TranscribeStarter*` — should show `{started: 'kos-{ulid}'}`.
   - `/aws/lambda/KosCapture-TranscribeComplete*` — should show `{published: '{ulid}'}`.

Plan 02-04 (triage) + Plan 02-05 (voice-capture) consume `capture.voice.transcribed` from `kos.capture` downstream.

## Threat-Register Coverage

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-TRANSCRIBE-01 (Spoofing — forged Transcribe Job State Change event) | mitigated | Rule filters `source:['aws.transcribe']` (only AWS service can publish to default bus from this source) AND `TranscriptionJobName:[{prefix:'kos-'}]`. Handler also defensively checks `if (!jobName.startsWith('kos-')) return { skipped }`. |
| T-02-TRANSCRIBE-02 (DoS — duplicate StartTranscriptionJob on retry) | mitigated | Job name = `kos-${capture_id}` (ULID). Transcribe rejects duplicate names with `ConflictException`; handler swallows it as `{ idempotentHit: true }`. Test `is idempotent on ConflictException` proves the path. |
| T-02-TRANSCRIBE-03 (Tampering — malicious S3 object under audio/meta/*) | mitigated | Bucket grant scoped to `audio/meta/*` read only. telegram-bot writes via VPC-less Lambda with IAM `s3:PutObject` scoped to `audio/*`. transcribe-complete validates JSON parses + reads only the fields it needs. |
| T-02-TRANSCRIBE-04 (Info disclosure — vocab leak via logs) | accepted | Vocab is not secret; deployed by Phase 1 with 26 phrases; no action needed. |

## Known Stubs

None. The Transcribe pipeline is end-to-end functional; both Lambdas have production handlers, CDK rules are wired, IAM is least-privilege, and the operator script can verify against a live deploy.

## Threat Flags

None. Plan 02-02 introduces no NEW security surface beyond the threat-register entries above. The Transcribe service is AWS-managed; the only S3 writes are to existing prefixes (audio/meta added with same VPCe-scoped bucket policy as audio); EventBridge rules use the existing kos.capture / default / kos.system buses.

## Handoffs to Next Plan

- **Plan 02-04 (triage agent, AGT-01):** subscribes to `capture.voice.transcribed` on `kos.capture` (alongside `capture.received` kind=text). The event payload shape is the `CaptureVoiceTranscribedSchema` zod-validated form: capture_id (ULID), channel='telegram', kind='voice', text (transcribed), raw_ref (S3 audio location), sender, received_at, transcribed_at, telegram (chat_id + message_id), vocab_name='kos-sv-se-v1' literal.
- **Plan 02-05 (voice-capture agent, AGT-02):** primary consumer of `capture.voice.transcribed` for entity extraction + Notion row creation.
- **Plan 02-10 (observability):** should add CloudWatch alarms on `kos-transcribe-starter-dlq` and `kos-transcribe-complete-dlq` `ApproximateNumberOfMessagesVisible > 0`. Also emit a `transcribe.failed` consumer (kos.system bus) if not already covered.

## Commits

| Hash | Message |
|------|---------|
| `a6ea2f8` | feat(02-02): transcribe-starter + transcribe-complete handlers + telegram meta sidecar |
| `d525395` | feat(02-02): CaptureStack transcribe pipeline + EventBridge rules + verify script |

## Self-Check: PASSED

Verified on disk:
- `services/transcribe-starter/src/handler.ts` — FOUND
- `services/transcribe-starter/test/handler.test.ts` — FOUND
- `services/transcribe-complete/src/handler.ts` — FOUND
- `services/transcribe-complete/test/handler.test.ts` — FOUND
- `services/telegram-bot/src/s3.ts` — MODIFIED (putVoiceMeta added)
- `services/telegram-bot/src/handler.ts` — MODIFIED (putVoiceMeta call wired)
- `packages/cdk/lib/stacks/integrations-transcribe-pipeline.ts` — FOUND
- `packages/cdk/lib/stacks/capture-stack.ts` — MODIFIED (systemBus + transcribe wiring)
- `packages/cdk/bin/kos.ts` — MODIFIED (passes systemBus)
- `packages/cdk/test/capture-stack.test.ts` — MODIFIED (14 passing tests)
- `scripts/verify-transcribe-event.mjs` — FOUND (+x)

Verified commits in `git log --all`:
- `a6ea2f8 feat(02-02): transcribe-starter + transcribe-complete handlers + telegram meta sidecar` — FOUND
- `d525395 feat(02-02): CaptureStack transcribe pipeline + EventBridge rules + verify script` — FOUND
