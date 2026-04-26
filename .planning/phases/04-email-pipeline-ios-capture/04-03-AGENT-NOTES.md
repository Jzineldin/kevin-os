# Phase 4 Plan 04-03 — Agent Execution Notes

## What landed

### Service code (Tasks 1, 2, 3, 4)

- `services/emailengine-webhook/src/handler.ts` — replaces stub. POST-only,
  X-EE-Secret guarded via `crypto.timingSafeEqual` (length-mismatch
  short-circuit precedes the equality test so a length mismatch rejects in
  constant time without leaking via thrown error). Zod-parses payload,
  filters to `messageNew` events only (others ack 200 + skipped), emits
  `capture.received` on `kos.capture` wrapped in `withTimeoutAndRetry`
  (5s per-attempt timeout, 1 retry on transient 5xx/throttle).
- `services/emailengine-webhook/src/secrets.ts` — module-scope cache,
  PLACEHOLDER fail-closed.
- `services/emailengine-webhook/test/handler.test.ts` — 9 tests covering
  happy path, missing-secret, wrong-secret (equal AND unequal length),
  non-messageNew skip, missing messageId, deterministic capture_id idempotency,
  Zod schema round-trip, and the withTimeoutAndRetry transient-failure path.
- `services/emailengine-webhook/package.json` + `tsconfig.json` — added
  the same OTel/Langfuse/Arize peer set as ios-webhook so `tracing.ts`
  resolves.
- `services/emailengine-admin/src/handler.ts` — replaces stub. Discriminated
  union on `command` (register/unregister/list-accounts). For register,
  IMAP creds come ONLY from the named Secrets Manager entry — caller
  payload `imap` field is ignored by Zod (extra fields stripped). PLACEHOLDER
  fail-closed for both api-key and per-account secrets.
- `services/emailengine-admin/test/handler.test.ts` — 7 tests covering
  register/unregister/list paths, unknown command, EE 4xx pass-through,
  PLACEHOLDER fail-closed, and the "caller IMAP creds ignored" property.

### CDK helper (Task 5)

- `packages/cdk/lib/stacks/integrations-emailengine.ts` — single helper
  `wireEmailEngine` returning `EmailEngineWiring`. Composes:
  - ElastiCache Serverless Redis `kos-emailengine-redis` (engine redis 7+,
    1 GB max storage, 1000 ECPU/s) in PRIVATE_WITH_EGRESS subnets, plus
    `CfnSubnetGroup`. Redis SG has ingress on :6379 from the EE task SG only.
  - Fargate task def: ARM64, 1024 CPU / 2048 MB. Container env carries
    `EENGINE_PORT/WORKERS/LOG_LEVEL/REDIS/NOTIFY_URL`; ECS secrets carry
    `EENGINE_LICENSE/API_KEY/NOTIFY_HEADERS_X_EE_SECRET`. wget-based
    `/v1/health` HC.
  - FargateService: `desiredCount=1`, `min/maxHealthy=0/100`. Runs on the
    existing kos-cluster. PrivateDnsNamespace `kos-internal.local` with
    `cloudMapOptions.name=emailengine` so admin Lambda dials
    `http://emailengine.kos-internal.local:3000`.
  - emailengine-webhook Lambda — Function URL `authType=NONE`, outside the
    VPC. Grants: webhook secret read, captureBus PutEvents.
  - emailengine-admin Lambda — Function URL `authType=AWS_IAM`, VPC-attached
    to the same EE SG so it can reach Cloud Map DNS. Grants: api-key + 2
    imap secrets read.
  - LogGroup `/ecs/emailengine` (30-day retention) + MetricFilter on
    `"auth failure"` → `KOS::EmailEngineAuthFailures` for the Gate-3 soak.
  - 3 CFN outputs: webhook URL, admin URL, redis endpoint.

- `packages/cdk/lib/stacks/data-stack.ts` — added 5 Secret placeholders
  (license, 2 imap, webhook-secret, api-key) with `RemovalPolicy.RETAIN`.
  Public field exposure mirrors the iOS secret pattern.

- `packages/cdk/lib/stacks/integrations-stack.ts` — opt-in flag
  `enableEmailEngine` plus `ecsCluster` + 5 secrets passed through to
  `wireEmailEngine`. Wiring fires only when flag=true AND all 6 props
  supplied. Existing tests/fixtures unaffected.

### CDK tests (Task 7)

- `packages/cdk/test/integrations-emailengine.test.ts` — 12 synth-level
  assertions. Single `beforeAll` synthesises one enabled + one disabled
  template (sharing across tests) — running 12 separate synths fills the
  /tmp tree. Asserts task def shape, service `desiredCount=1`, ElastiCache
  cache name + engine, Redis SG ingress, container env + secret names,
  Function URL auth modes, admin secrets grant, Cloud Map registration,
  log group retention, metric filter, outputs.

### Operator surfaces (Tasks 8, 9)

- `scripts/configure-emailengine-accounts.mjs` — node script. Reads
  `EMAILENGINE_ADMIN_URL` + 2 imap-secret-arn env vars, resolves the admin
  Lambda's physical id via `aws cloudformation describe-stack-resource`,
  invokes the Lambda twice (once per account) via `aws lambda invoke` with
  the operator's IAM creds. Writes payload to a tmp file (avoids shell
  quoting issues on the JSON body). Cleans up tmp files in finally.
- `.planning/phases/04-email-pipeline-ios-capture/04-EMAILENGINE-OPERATOR-RUNBOOK.md`
  — full runbook: license procurement, Gmail app passwords, secret seeding
  (with verification one-liner), `cdk deploy`, ElastiCache + ECS
  steady-state checks, account registration, end-to-end test, 7-day
  CloudWatch soak query for Gate 3, incident-response playbook, and a
  `What NOT to do` block hammering on `desiredCount=1`.

## Verification

- `pnpm --filter @kos/service-emailengine-webhook typecheck` — clean.
- `pnpm --filter @kos/service-emailengine-webhook test` — 9/9 pass.
- `pnpm --filter @kos/service-emailengine-admin typecheck` — clean.
- `pnpm --filter @kos/service-emailengine-admin test` — 7/7 pass.
- `pnpm --filter @kos/cdk typecheck` — clean.
- `pnpm --filter @kos/cdk test -- --run integrations-emailengine` — 12/12 pass.
- Spot-checked sibling tests (data-stack, ios-webhook, lifecycle, agents,
  capture, dashboard, etc.) — all green; no regressions from the
  IntegrationsStack additions or DataStack secret additions.
- `node --check scripts/configure-emailengine-accounts.mjs` — clean.

## Decisions / deviations from the plan body

1. **Lambda Function URL response shape**: the plan body has `{ headers,
   body }` without a top-level Content-Type wrapper. I used the same
   `reply()` helper as ios-webhook (sets `content-type: application/json`)
   so the operator script's `JSON.parse` is robust.

2. **Discriminated union for admin commands**: the plan inline-sketched a
   single object with optional fields; I used `z.discriminatedUnion` so
   the type narrowing flows correctly and unknown commands surface a
   precise error.

3. **EE_API_KEY is fetched from Secrets Manager at admin invoke time**, not
   wired as a literal Lambda env. The plan body kept it as a literal env
   for simplicity, but Secrets Manager → admin Lambda is a standard pattern
   here (same as the imap secrets) and avoids the operator having to
   redeploy CDK to rotate the admin API key.

4. **Cloud Map namespace**: `kos-internal.local` (matches the plan body's
   note step). Created fresh inside the helper rather than threading
   through `cluster.addDefaultCloudMapNamespace` so a future Baileys/Postiz
   helper can reuse the same namespace by importing if desired.

5. **Test caching via `beforeAll`**: 12 separate `App` syntheses filled
   the /tmp tree on the first attempt (each Synth produces a multi-MB
   `cdk.out`). A single `beforeAll` cuts the suite from 83s → 13s and
   removes the disk-pressure failure mode.

6. **`enableEmailEngine` opt-in**: the Phase-4 wiring is gated behind a
   prop flag. `cdk.ts` is NOT yet patched to set this flag — the operator
   runbook explicitly documents flipping it as part of step 4 (post-secret
   seeding). This preserves all existing deploys + tests + fixtures and
   prevents the trial license from being accidentally consumed.

## What did NOT land here (out of scope for 04-03)

- email-triage Lambda — Plan 04-04 (not this plan).
- Bedrock invocation from emailengine-webhook — explicitly forbidden by the
  plan; the webhook is envelope-only.
- CDK app `bin/kos.ts` patch flipping `enableEmailEngine: true` — the
  runbook documents this; the operator does it after secret seeding.

## Cost (steady state, after credit burn)

- Fargate (1 vCPU + 2 GB ARM64, 24/7) — $35.91/mo
- ElastiCache Serverless Redis idle — $10/mo
- License (~$99/yr amortized) — $8/mo
- 2 Lambdas + Function URLs — <$1/mo
- CloudWatch logs (30-day retention) — pennies

Total: **~$45/mo** (covered by AWS credits for the first 12-18 months).

## Files changed

```
M  packages/cdk/lib/stacks/data-stack.ts
M  packages/cdk/lib/stacks/integrations-stack.ts
A  packages/cdk/lib/stacks/integrations-emailengine.ts
A  packages/cdk/test/integrations-emailengine.test.ts
M  services/emailengine-admin/src/handler.ts
A  services/emailengine-admin/test/handler.test.ts
M  services/emailengine-webhook/package.json
M  services/emailengine-webhook/src/handler.ts
A  services/emailengine-webhook/src/secrets.ts
A  services/emailengine-webhook/test/handler.test.ts
M  services/emailengine-webhook/tsconfig.json
A  scripts/configure-emailengine-accounts.mjs
A  .planning/phases/04-email-pipeline-ios-capture/04-EMAILENGINE-OPERATOR-RUNBOOK.md
A  .planning/phases/04-email-pipeline-ios-capture/04-03-AGENT-NOTES.md
```

(No commits — operator handles the commit + branch + PR.)
