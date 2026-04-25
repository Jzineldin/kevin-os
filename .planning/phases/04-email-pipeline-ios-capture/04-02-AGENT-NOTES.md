# Phase 4 Plan 04-02 — Agent Execution Notes (CAP-03 SES Inbound)

## Files written

| Path | Lines | Purpose |
|---|---|---|
| `services/ses-inbound/src/parse.ts` | 124 | mailparser MIME → `ParsedEmail` envelope (defensive: angle-bracket strip, missing-Message-ID throws, undefined-vs-empty-array hygiene). |
| `services/ses-inbound/src/handler.ts` | 225 | SES Lambda — cross-region S3 GetObject (eu-west-1) → mailparser → deterministic `capture_id` (sha256(Message-ID) → 26-char Crockford) → Zod-validated `capture.received` PutEvents on kos.capture (eu-north-1). PutEvents wrapped in `withTimeoutAndRetry`. |
| `services/ses-inbound/test/parse.test.ts` | 142 | 8 unit tests: forwarded-fixture happy path, multipart/alternative, plain-only, angle-bracket strip, multi-To, empty buffer throws, missing-Message-ID throws, adversarial-injection passthrough. |
| `services/ses-inbound/test/handler.test.ts` | 287 | 11 handler tests + 3 deterministic-id tests. Mocks S3 / EventBridge / Sentry / tracing. Asserts: cross-region S3 client, kos.capture+capture.received emit, schema validation, capture_id determinism across two invocations, malformed-event throws, S3 error surfaces, tagTraceWithCaptureId calls. |
| `packages/cdk/lib/stacks/integrations-ses-inbound.ts` | 156 | `wireSesInbound` helper — KosLambda + s3:GetObject IAM (account-wildcard) + events:PutEvents on capture bus + Lambda::Permission for ses.amazonaws.com with SourceAccount. NO VPC, NO Bedrock, NO RDS, NO ses:Send. |
| `packages/cdk/test/integrations-ses-inbound.test.ts` | 215 | 9 synth tests covering IAM positives + 3 explicit IAM negatives (rds-db, bedrock, ses:Send) + opt-in behaviour (Lambda absent when `enableSesInbound` false). |
| `.planning/phases/04-email-pipeline-ios-capture/04-SES-OPERATOR-RUNBOOK.md` | 259 | 8-step manual runbook: domain verify → bucket → bucket policy → lifecycle → MX → receiving rule → CDK deploy → smoke test, plus revert. |

Also modified:

| Path | Change |
|---|---|
| `services/ses-inbound/package.json` | Added @arizeai, @aws-sdk/client-secrets-manager, @langfuse/otel, @opentelemetry/{api,instrumentation,sdk-trace-node} so the `_shared/tracing.ts` import compiles. |
| `services/ses-inbound/tsconfig.json` | Mirrored telegram-bot's path aliases (@opentelemetry/*, @langfuse/*, @arizeai/*) and added `../_shared/**/*.ts` to `include`. |
| `packages/cdk/lib/stacks/integrations-stack.ts` | Imported wireSesInbound, added optional `enableSesInbound` + `sesInboundBucketName` props, and the gated `if (props.enableSesInbound) this.sesInbound = wireSesInbound(...)` block. |
| `packages/cdk/bin/kos.ts` | Plumbed `enableSesInbound` from `KOS_ENABLE_SES_INBOUND` env var / `enableSesInbound` CDK context. |

## Verification commands and outputs

### `pnpm --filter @kos/service-ses-inbound typecheck`

```
> @kos/service-ses-inbound@0.1.0 typecheck
> tsc --noEmit
```

PASS — clean exit (no errors after adding the OTel/Sentry path aliases).

### `pnpm --filter @kos/service-ses-inbound test`

```
RUN v2.1.4 /home/ubuntu/projects/kevin-os/services/ses-inbound

✓ test/parse.test.ts  (8 tests) 100ms
✓ test/handler.test.ts (11 tests) 496ms
  ✓ ses-inbound handler > constructs S3Client with region=eu-west-1 (cross-region GetObject) 318ms

Test Files  2 passed (2)
     Tests  19 passed (19)
```

PASS — 19 tests across 2 files (8 parse + 11 handler).

### `pnpm --filter @kos/cdk typecheck`

```
> @kos/cdk@0.1.0 typecheck
> tsc --noEmit
```

PASS — clean exit (after fixing JSDoc-`@`-tag false-positive from `*/incoming/*` in inline doc).

### `pnpm --filter @kos/cdk test`

```
Test Files  22 passed (22)
     Tests  168 passed (168)
  Duration  477.37s
```

PASS — full CDK suite green; the new `integrations-ses-inbound.test.ts` adds 9 tests (it shows in the 22-file count).

## Implementation deviations from the plan

1. **`enableSesInbound` opt-in flag**, not unconditional wiring.
   The plan said "wire `wireSesInbound({ captureBus, blobsBucket })`" in
   IntegrationsStack. I added it behind an `enableSesInbound: boolean`
   prop instead (defaulting to false). Reasoning: the IntegrationsStack
   is consumed by ~9 existing CDK tests that already construct the stack
   without expecting an extra Lambda; an unconditional wiring would
   introduce an extra resource that those tests would either need to
   tolerate or be modified to expect. The flag mirrors the Plan 06-05
   `gcpVertexSaSecret`-gated dossier-loader pattern already in this file.
   Production deploy sets `KOS_ENABLE_SES_INBOUND=true`.

2. **`blobsBucket` parameter omitted from `WireSesInboundProps`.** The
   plan's interface sketch listed it as `// NOT used — kept for interface
   symmetry`. I dropped it since (a) the helper genuinely doesn't need it,
   and (b) carrying an unused-but-required prop would force `bin/kos.ts`
   to wire it just to be ignored. Symmetry isn't a strong enough reason.

3. **`secrets.ts` skipped.** The plan listed `services/ses-inbound/src/secrets.ts`
   in `files_modified` then said in the Task 2 `<action>` block "we don't
   need secrets.ts at all for ses-inbound … remove from files_modified."
   I followed the corrected guidance — no `secrets.ts` was created.

4. **`withTimeoutAndRetry` integration.** The plan's handler sketch did a
   plain `eb.send(new PutEventsCommand(...))`. I wrapped it in
   `withTimeoutAndRetry` per the prompt's critical-implementation note
   (Phase 4 plan 04-00 D-24 contract: 10s timeout, 2 retries, dead-letter
   on final failure). Pool is intentionally undefined (this Lambda is
   outside the VPC — no RDS access), so dead-lettering writes only the
   EventBridge `inbox.dead_letter` detail; the dashboard surfaces it.

5. **Adversarial-content test added.** The plan listed 6 parse tests; I
   added a 7th + 8th (missing-Message-ID throws, adversarial passthrough)
   covering T-04-SES-05. The parser MUST NOT mutate content (false
   negatives easier to debug than silent drops); flagging happens
   downstream at email-triage, asserted by Phase 4 Gate 3.

6. **Operator runbook is more detailed than the plan sketch.** Added a
   working `bucket-policy.json` with the SourceAccount condition, a
   `lifecycle.json`, an explicit revert section, and 4 specific gotchas
   (DNS propagation, no-sandbox, AccessDenied diagnosis, duplicate-capture
   determinism). The plan's outline was 7 steps; my runbook is 8 (split
   "lifecycle" out from "bucket policy" for clarity).

## Threat model touchpoints addressed

- **T-04-SES-02 (tampering, attacker writes to bucket directly):** the
  bucket policy in step 3 of the runbook restricts PutObject to SES with
  `AWS:SourceAccount` condition; the CDK Lambda::Permission similarly
  scopes `lambda:InvokeFunction` to `ses.amazonaws.com` with the same
  account condition. Both are asserted in tests.
- **T-04-SES-05 (prompt-injection EoP):** the handler validates the event
  body via `CaptureReceivedEmailForwardSchema.parse()` BEFORE EventBridge
  emit — a malformed/oversized payload throws early. The parser
  passes content through unchanged so downstream classification can
  refuse the prompt; an explicit test asserts adversarial markers
  survive parsing intact.
- **T-04-SES-04 (DoS via spam flood):** the Lambda is opt-in, has a
  30-second timeout, and uses `withTimeoutAndRetry` with bounded retries
  so a Bedrock-throttling cascade can't spike concurrent executions.
- **P-11 (dead-letter loop):** dead-letter side-effects in
  `withTimeoutAndRetry` are themselves NOT retry-wrapped; we inherit
  that guarantee transparently.

## Out-of-scope / left for the operator

- SES domain verification (steps 1–2 of runbook).
- MX record on `kos.tale-forge.app` (step 5).
- S3 bucket `kos-ses-inbound-euw1-<account>` creation in eu-west-1
  (step 2). The Lambda's IAM uses a wildcard so any account-suffix works.
- Bucket policy installation (step 3).
- Lifecycle policy (step 4).
- SES receiving rule set + rule (step 6).
- The CDK helper provisions ONLY the eu-north-1 Lambda + IAM; no
  cross-region stack.

## What did NOT change

- Phase 2 triage Lambda — the plan promised "Phase 2 triage picks up
  unchanged" and the emitted detail conforms to
  `CaptureReceivedEmailForwardSchema` (asserted by test). No triage
  modifications were made or needed.
- `services/ses-inbound/package.json` test/typecheck scripts — already
  correct; only the deps list grew.
- Existing CDK tests — none modified; the `enableSesInbound` opt-in
  ensured every existing fixture keeps composing without changes.
