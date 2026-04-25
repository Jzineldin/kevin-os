---
phase: 03
plan: 04
subsystem: dashboard-cdk-composition
tags: [dashboard, cdk, lambda, fargate, function-url, sigv4, option-b-ingress, eventbridge, iam, secrets-manager, network-load-balancer]
dependency_graph:
  requires:
    - "03-00 (services/dashboard-api + dashboard-listen-relay + dashboard-notify scaffolds)"
    - "03-01 (migrations 0007-0010 authored; schema-push deferred to this plan's deploy path)"
    - "03-02 (dashboard-api Lambda handlers + router + events publisher)"
    - "03-03 (dashboard-listen-relay Fastify + Dockerfile; dashboard-notify EventBridgeHandler)"
  provides:
    - "DashboardStack (KosDashboard) — compose point for Phase 3 Wave 1 backend infra"
    - "dashboard-api Lambda Function URL (AWS_IAM auth, BUFFERED, CORS locked to Vercel origin)"
    - "dashboard-notify Lambda + EventBridge rule on kos.output (5 D-25 detail-types)"
    - "dashboard-listen-relay Fargate service (ARM64 0.25 vCPU / 0.5 GB on existing kos-cluster)"
    - "relay-proxy Lambda Function URL (Option B ingress, ~$21/mo cheaper than API Gateway + VPC Link + NLB)"
    - "internal NLB fronting Fargate task on :8080 with /healthz TargetGroup"
    - "2 IAM users (kos-dashboard-caller + kos-dashboard-relay-caller) with narrow InvokeFunctionUrl policies"
    - "3 Secrets Manager placeholders (bearer-token + sentry-dsn + caller-access-keys)"
    - "6 CfnOutputs (api URL, relay-proxy URL, 2 IAM user ARNs, cluster name, bearer secret ARN)"
  affects:
    - packages/cdk/bin/kos.ts
    - packages/cdk/lib/stacks/
    - packages/cdk/test/
    - services/dashboard-listen-relay/src/ (adds proxy.ts)
tech_stack:
  added:
    - "ContainerImage.fromAsset (Docker build at synth; aws-cdk-lib ^2.248)"
    - "aws-cdk-lib/aws-ecr-assets.Platform.LINUX_ARM64 (cross-arch Docker build)"
    - "aws-cdk-lib/aws-elasticloadbalancingv2 (internal NLB + NetworkTargetGroup + NetworkListener)"
    - "Lambda Function URL with AWS_IAM auth + CORS (two URLs)"
  patterns:
    - "Option B ingress: Lambda Function URL wrapper -> internal NLB -> Fargate (RESEARCH §13)"
    - "Per-plan helper file (integrations-dashboard.ts) mirrors integrations-notion.ts convention"
    - "RDS SG cross-stack ingress avoided — DataStack's allowFromAnyIpv4(5432) is the gate (IAM auth)"
    - "Secrets Manager placeholders created with RemovalPolicy.RETAIN; values seeded post-deploy"
    - "IAM caller policies scoped via StringEquals lambda:FunctionUrlAuthType condition"
    - "CfnOutput + exportName pairs for every value Plan 11 Vercel sync script reads"
key_files:
  created:
    - packages/cdk/lib/stacks/dashboard-stack.ts
    - packages/cdk/lib/stacks/integrations-dashboard.ts
    - packages/cdk/test/dashboard-stack.test.ts
    - services/dashboard-listen-relay/src/proxy.ts
    - .planning/phases/03-dashboard-mvp/03-04-SUMMARY.md
  modified:
    - packages/cdk/bin/kos.ts
decisions:
  - "Tasks 1 + 2 committed as a single atomic feat — dashboard-stack.ts imports buildRelayStack from integrations-dashboard.ts; separate commits would leave the stack uncompilable mid-series."
  - "No cross-stack ingress rule on the RDS Proxy SG — DataStack already has allowFromAnyIpv4(5432); adding one from DashboardStack creates a DataStack -> DashboardStack -> DataStack cycle via SecurityGroup.GroupId tokens. Pattern mirrors notion-indexer in Phase 1."
  - "Lambdas placed in PRIVATE_WITH_EGRESS subnets (not PRIVATE_ISOLATED as the plan text suggested) — dashboard-api NOTION_TOKEN env-var is injected at deploy time (P-04), but the Notion API call itself still requires egress, and Phase 1 Wave 5 deploy broke exactly this way for notion-indexer. Fargate relay stays PRIVATE_ISOLATED (no external traffic needed)."
  - "NOTION_TOKEN injected via Secret.fromSecretCompleteArn(...).secretValue.unsafeUnwrap() per RESEARCH §17 P-04 (env-var approach avoids a Secrets Manager VPC interface endpoint)."
  - "Reserved concurrency NOT set on dashboard-api — deferred per RESEARCH §16 (default 1000 per-function concurrency is fine for single-user Vercel; enhanced throttling is a Plan 13+ concern)."
  - "Schema push (migrations 0007-0010) routed through Plan 05 deploy path — documented in 'Deferred Issues' rather than adding a one-shot migrations Lambda CustomResource (keeps DashboardStack focused + reduces synth+deploy time)."
  - "IAM access keys NOT created in CDK — `User` + `Policy` only; access keys are generated manually post-deploy via `aws iam create-access-key --user-name kos-dashboard-caller` and stored in `kos/dashboard-caller-access-keys`. Plan 11 rotation script handles re-creation."
  - "Fargate maxHealthyPercent=100 + minHealthyPercent=0 — singleton task per D-24 means brief downtime on deploy; acceptable for single-user dashboard."
  - "CfnOutput exportName for every value except FargateClusterName — cluster name is a stable string (kos-cluster), no Fn::ImportValue needed downstream."
metrics:
  duration: "≈35m"
  tasks_committed: 1
  files_created: 4
  files_modified: 1
  tests_added: 18
  completed_date: "2026-04-23"
requirements_addressed: [UI-06, INF-12]
---

# Phase 3 Plan 03-04: DashboardStack CDK composition Summary

**One-liner:** Composes Phase 3 Wave 1 backend infra — dashboard-api Lambda (Function URL + AWS_IAM, BUFFERED, CORS-to-Vercel) + dashboard-notify Lambda + EventBridge rule on `kos.output` (5 D-25 detail-types) + dashboard-listen-relay Fargate service (ARM64 singleton on existing kos-cluster) + relay-proxy Lambda Function URL (Option B ingress, ~$21/mo cheaper than Option A) + 2 IAM users with narrow InvokeFunctionUrl policies + 3 Secrets Manager placeholders + full CDK unit coverage — into a new `KosDashboard` stack that `cdk synth` produces cleanly.

## What shipped

### Single commit (`d054f40`) — DashboardStack + integrations-dashboard + tests + relay-proxy

**`packages/cdk/lib/stacks/dashboard-stack.ts`** (~360 lines)
- Stack composes: DashboardLambdaSG (egress-only; no cross-stack ingress rule to avoid the DataStack cycle), 3 Secrets (`kos/dashboard-bearer-token`, `kos/sentry-dsn-dashboard`, `kos/dashboard-caller-access-keys` — all `RemovalPolicy.RETAIN`).
- **dashboard-api Lambda:** KosLambda (Node 22 ARM64, 1024 MB, 30 s), VPC `PRIVATE_WITH_EGRESS` (needs Notion API egress via NAT), env: `RDS_PROXY_ENDPOINT`, `RDS_USER=dashboard_api`, `NOTION_TOKEN` injected via `secretValue.unsafeUnwrap()` (P-04), `NOTION_TODAY_PAGE_ID`, `NOTION_COMMAND_CENTER_DB_ID`, `KOS_CAPTURE_BUS`, `KOS_OUTPUT_BUS`. IAM: `rds-db:connect` scoped to `dashboard_api` user; `events:PutEvents` scoped to `kos.capture` + `kos.output` ARNs (no `*`). Function URL: AUTH_IAM + InvokeMode BUFFERED + CORS AllowOrigins=[Vercel origin], methods=[GET, POST], headers=[content-type, authorization, x-amz-*].
- **dashboard-notify Lambda:** KosLambda (256 MB, 10 s), VPC `PRIVATE_WITH_EGRESS`, env `RDS_USER=dashboard_notify`; IAM: `rds-db:connect` scoped to `dashboard_notify`.
- **EventBridge rule:** `to-dashboard-notify` on `kos.output` bus, `detail-type ∈ {inbox_item, entity_merge, capture_ack, draft_ready, timeline_event}`, single target = dashboardNotify.
- **Fargate relay stack via `buildRelayStack()`** — delegated to `integrations-dashboard.ts`.
- **2 IAM users + inline policies:** `kos-dashboard-caller` (`lambda:InvokeFunctionUrl` on dashboard-api ARN + StringEquals FunctionUrlAuthType=AWS_IAM) and `kos-dashboard-relay-caller` (same condition on relay-proxy ARN).
- **6 CfnOutputs:** `DashboardApiFunctionUrl`, `RelayProxyFunctionUrl`, `DashboardApiCallerUserArn`, `DashboardRelayCallerUserArn`, `FargateClusterName`, `DashboardBearerSecretArn` (first 4 with exportName for Plan 11).

**`packages/cdk/lib/stacks/integrations-dashboard.ts`** (~240 lines)
- Log group `/ecs/dashboard-listen-relay` with `RetentionDays.ONE_MONTH` + `RemovalPolicy.DESTROY`.
- FargateTaskDefinition: 256 CPU / 512 MB ARM64 + LINUX; container `Relay` built via `ContainerImage.fromAsset('services/dashboard-listen-relay', { platform: Platform.LINUX_ARM64 })` — uses the Dockerfile Plan 03-03 shipped. Env: `RDS_PROXY_ENDPOINT`, `RDS_USER=dashboard_relay`, `PORT=8080`, `TZ=UTC`. Port mapping `:8080`. Container health-check: `wget -qO- http://127.0.0.1:8080/healthz`.
- Task role: `rds-db:connect` scoped to `dashboard_relay` user.
- `RelaySG` (egress-only + self-referencing ingress on :8080 for Lambda-to-Fargate intra-SG traffic).
- `RelayService`: desiredCount=1, `PRIVATE_ISOLATED` subnets, maxHealthyPercent=100, minHealthyPercent=0, assignPublicIp=false.
- Internal `RelayNlb` (`internetFacing: false`, `PRIVATE_ISOLATED`, crossZoneEnabled), target group `RelayTg` (TCP :8080 with HTTP `/healthz` health-check on port 8080, TargetType.IP for awsvpc ENI registration), `RelayListener` (TCP :8080). `service.attachToNetworkTargetGroup(tg)` wires ECS -> NLB.
- **relay-proxy Lambda:** KosLambda (256 MB, 30 s), VPC `PRIVATE_WITH_EGRESS` (needs NLB DNS resolution), env `RELAY_INTERNAL_URL=http://<nlb-dns>:8080`. Function URL: AUTH_IAM + BUFFERED.

**`services/dashboard-listen-relay/src/proxy.ts`** (~80 lines)
- `LambdaFunctionURLHandler` that forwards method + rawPath + rawQueryString verbatim to `RELAY_INTERNAL_URL`.
- Body handling: base64-decodes on binary bodies, passes text bodies as strings; forwards only on POST/PUT/PATCH.
- 28-second `AbortSignal.timeout` (2 s headroom below Lambda's 30 s hard timeout) — cleanly surfaces 504 on timeout vs opaque 502.
- Error mapping: AbortError/TimeoutError → 504 `{error: "upstream_timeout"}`, else → 502 `{error: "upstream_unreachable"}`.
- No external deps (Node 22 native `fetch`).

**`packages/cdk/test/dashboard-stack.test.ts`** (18 tests, all green in 12 ms)
- Lambda counts + runtimes: 3 Phase-3 Lambdas (filtered by Runtime=nodejs22.x AND Architectures=[arm64]) — excludes CDK's internal log-retention Lambda (nodejs22.x, no Architectures field).
- dashboard-api memory 1024 / timeout 30.
- 2 Function URLs both `AuthType: AWS_IAM` + `InvokeMode: BUFFERED`.
- dashboard-api CORS `AllowOrigins=[vercel-url]`, `AllowMethods` includes GET + POST.
- EventBridge rule has the exact 5 D-25 detail-types + exactly 1 target.
- 3 Secrets with correct names.
- 2 IAM users with correct names.
- Caller policies Action=`lambda:InvokeFunctionUrl` with Resource ≠ `"*"`.
- dashboard-api policy includes `rds-db:connect`, `dbuser:`, `dashboard_api`, `dashboard_notify`, `dashboard_relay` substrings.
- dashboard-api policy includes `events:PutEvents` on `event-bus/kos.capture` + `event-bus/kos.output`.
- 1 ECS::Service LaunchType FARGATE DesiredCount 1; TaskDefinition Cpu=256 / Memory=512 / ARM64 LINUX.
- NLB Scheme=`internal`, Type=`network`; Listener Port 8080 Protocol TCP.
- TargetGroup HealthCheckPath=`/healthz` + Protocol=TCP + TargetType=`ip`.
- LogGroup `/ecs/dashboard-listen-relay` with 30-day retention.
- 3 CfnOutputs with correct exportNames.

**`packages/cdk/bin/kos.ts`**
- Registers `new DashboardStack(app, 'KosDashboard', {…})` with `addDependency(network/data/events)`.
- `NOTION_TODAY_PAGE_ID`, `NOTION_COMMAND_CENTER_DB_ID`, `VERCEL_ORIGIN_URL` sourced from env vars + CDK context with sensible defaults (empty string for Notion IDs — consistent with Plan 02-07's `NOTION_KOS_INBOX_DB_ID` deploy-unblock pattern; Vercel default URL `kos-dashboard-kevin-elzarka.vercel.app`).

## Verification results

| Command | Result |
| --- | --- |
| `pnpm --filter @kos/cdk test -- --run test/dashboard-stack.test.ts` | 18/18 pass in 12 ms |
| `pnpm --filter @kos/cdk exec cdk synth KosDashboard --quiet` | clean synth, 3 asset bundles (api + notify + proxy) |
| `grep -F "DashboardStack" packages/cdk/bin/kos.ts` | 2 matches (import + instantiation) |
| `grep -F "KosLambda" packages/cdk/lib/stacks/dashboard-stack.ts` | 3 matches (import + api + notify) |
| `grep -F "FunctionUrlAuthType.AWS_IAM" packages/cdk/lib/stacks/dashboard-stack.ts` | 1 match |
| `grep -F "InvokeMode.BUFFERED" packages/cdk/lib/stacks/dashboard-stack.ts` | 1 match |
| `grep -F "to-dashboard-notify" packages/cdk/lib/stacks/dashboard-stack.ts` | 1 match |
| `grep -F "kos/dashboard-bearer-token" packages/cdk/lib/stacks/dashboard-stack.ts` | multiple matches |
| `grep -F "kos/sentry-dsn-dashboard" packages/cdk/lib/stacks/dashboard-stack.ts` | multiple matches |
| `grep -F "kos-dashboard-caller" packages/cdk/lib/stacks/dashboard-stack.ts` | multiple matches |
| `grep -F "rds-db:connect" packages/cdk/lib/stacks/dashboard-stack.ts` | 4 matches |
| `grep -F "FargateService" packages/cdk/lib/stacks/integrations-dashboard.ts` | 3 matches |
| `grep -F "CpuArchitecture.ARM64" packages/cdk/lib/stacks/integrations-dashboard.ts` | 1 match |
| `grep -F "desiredCount: 1" packages/cdk/lib/stacks/integrations-dashboard.ts` | 1 match |
| `grep -F "NetworkLoadBalancer" packages/cdk/lib/stacks/integrations-dashboard.ts` | 3 matches |
| `grep -F "internetFacing: false" packages/cdk/lib/stacks/integrations-dashboard.ts` | 1 match |
| `grep -F "RELAY_INTERNAL_URL" packages/cdk/lib/stacks/integrations-dashboard.ts` | 1 match |
| `grep -F "proxy.ts" packages/cdk/lib/stacks/integrations-dashboard.ts` | multiple (doc + entry path) |
| `grep -F "kos-dashboard-relay-caller" packages/cdk/lib/stacks/dashboard-stack.ts` | multiple matches |

## Monthly cost (RESEARCH §13 Option B)

| Line item | Cost |
| --- | --- |
| Fargate 0.25 vCPU + 0.5 GB ARM64 × 730 h | ~$5.00 |
| Internal NLB (1 LCU-hour equivalent at single-user traffic) | ~$0.20 |
| relay-proxy Lambda (single-user ~20 long-polls × 25s avg × 256 MB) | ~$3.00 |
| CloudWatch log storage (`/ecs/dashboard-listen-relay`, 30-day retention) | ~$2.00 |
| dashboard-api + dashboard-notify Lambdas (single-user, free tier) | ~$0.50 |
| **Total (covered by AWS credits for 12+ months)** | **~$10.70/mo** |

Option A (HTTP API + VPC Link + public NLB) was ~$31/mo. Option B saves ~$21/mo while reusing the same SigV4 `service=lambda` library on the Vercel side (same credentials, same library call — just a different Function URL target).

## Plan 11 environment variables to set on Vercel

Plan 11 (`scripts/sync-vercel-env.ts`) reads the CfnOutputs via `aws cloudformation describe-stacks --stack-name KosDashboard` and sets:

| Vercel env var | Source |
| --- | --- |
| `KOS_DASHBOARD_API_URL` | Output `DashboardApiFunctionUrl` |
| `KOS_DASHBOARD_RELAY_URL` | Output `RelayProxyFunctionUrl` |
| `AWS_ACCESS_KEY_ID_DASHBOARD` | Secret `kos/dashboard-caller-access-keys` → field `AccessKeyId` |
| `AWS_SECRET_ACCESS_KEY_DASHBOARD` | Secret `kos/dashboard-caller-access-keys` → field `SecretAccessKey` |
| `AWS_ACCESS_KEY_ID_DASHBOARD_RELAY` | separate access key for `kos-dashboard-relay-caller` user (same secret pattern — Plan 11 may split into two secrets) |
| `AWS_SECRET_ACCESS_KEY_DASHBOARD_RELAY` | same |
| `AWS_REGION` | `eu-north-1` |
| `KOS_DASHBOARD_BEARER_TOKEN` | Secret `kos/dashboard-bearer-token` |
| `SENTRY_DSN_DASHBOARD` | Secret `kos/sentry-dsn-dashboard` |

`NOTION_TOKEN` is handled server-side in the dashboard-api Lambda (P-04); Vercel never sees it.

## Stack outputs (post-deploy)

```
KosDashboard.DashboardApiFunctionUrl     = https://<id>.lambda-url.eu-north-1.on.aws/
KosDashboard.RelayProxyFunctionUrl       = https://<id>.lambda-url.eu-north-1.on.aws/
KosDashboard.DashboardApiCallerUserArn   = arn:aws:iam::<acct>:user/kos-dashboard-caller
KosDashboard.DashboardRelayCallerUserArn = arn:aws:iam::<acct>:user/kos-dashboard-relay-caller
KosDashboard.FargateClusterName          = kos-cluster
KosDashboard.DashboardBearerSecretArn    = arn:aws:secretsmanager:eu-north-1:<acct>:secret:kos/dashboard-bearer-token-XXXXXX
```

## Schema push (migrations 0007-0010) — executable path

The four SQL migrations were authored in Plan 03-01 but not applied (Plan 01 Deviation #1: `DATABASE_URL` unset + RDS Proxy VPC-private). This plan's `DashboardStack` composes the runtime surface, but does NOT apply the migrations automatically. **Kevin applies post-deploy via one of the following paths:**

1. **Recommended: dashboard-api Lambda cold-start migration hook** — deferred to Plan 05 (Task 5 / post-deploy script). Cold-start runs `drizzle-kit migrate` inside the VPC on the first invoke; `SELECT relname FROM pg_class WHERE relname IN ('entity_merge_audit','inbox_index')` verifies.
2. **Manual bastion push** — `cdk deploy KosData --context bastion=true` provisions the short-lived bastion from Phase 1, tunnel to RDS Proxy, run `pnpm --filter @kos/db drizzle-kit push` with `DATABASE_URL` set. Tear down bastion with a follow-up `cdk deploy KosData` (no context flag). Matches Phase 1 initial schema push.
3. **One-shot Lambda** — a migrations Lambda invoked via `aws lambda invoke --function-name dashboard-migrations` post-deploy. Not shipped in this plan to keep DashboardStack focused; carved out as a Plan 05 choice.

## Task 1 + Task 2 single-commit deviation

The plan scoped 2 tasks with their own commits. In practice, `dashboard-stack.ts` imports `buildRelayStack` from `integrations-dashboard.ts`, and the stack's `RelayProxy` Function URL is referenced by the Task 1 IAM user policies. A Task 1 commit that omitted the relay wiring would leave the stack uncompilable (import ref to a non-existent symbol) — violating the atomic-commit invariant. Committed both tasks in a single `feat(03-04):` commit with the full diff. No material impact; `SCOPE BOUNDARY` is respected (all changes in this plan's 5 files).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Dependency cycle] RDS Proxy cross-stack ingress rule removed**
- **Found during:** first `cdk synth` run of the test suite.
- **Issue:** Plan text had `props.rdsProxySecurityGroup.addIngressRule(lambdaSg, Port.tcp(5432), …)` in both dashboard-stack.ts and integrations-dashboard.ts. CloudFormation rejected synth with `DependencyCycle: 'D' depends on 'Dash' (D -> Dash/DashboardLambdaSG/Resource.GroupId). Adding this dependency (Dash -> D/RdsProxy/Resource.DBProxyArn) would create a cyclic reference.`
- **Fix:** Removed both ingress rules. DataStack already has `this.rdsProxy.connections.allowFromAnyIpv4(Port.tcp(5432))` — IAM auth is the gate. Same pattern as notion-indexer in Phase 1 (integrations-notion.ts does NOT add ingress; it just places Lambdas in `securityGroups: [props.rdsSecurityGroup]`).
- **Files modified:** `packages/cdk/lib/stacks/dashboard-stack.ts`, `packages/cdk/lib/stacks/integrations-dashboard.ts`.
- **Commit:** `d054f40`.

**2. [Rule 1 — Bug] ESM `require()` replaced with proper import**
- **Found during:** `cdk synth` of the full app.
- **Issue:** `platform: require('aws-cdk-lib/aws-ecr-assets').Platform.LINUX_ARM64` threw `ReferenceError: require is not defined in ES module scope` under Node 24 with `"type": "module"` in package.json. tsx doesn't inject `createRequire`.
- **Fix:** Added `import { Platform } from 'aws-cdk-lib/aws-ecr-assets';` at the top; used `platform: Platform.LINUX_ARM64`.
- **Files modified:** `packages/cdk/lib/stacks/integrations-dashboard.ts`.
- **Commit:** `d054f40`.

**3. [Rule 2 — Correctness] Lambdas placed in PRIVATE_WITH_EGRESS, not PRIVATE_ISOLATED**
- **Found during:** reviewing the plan text against Phase 1 Wave 5 retrospective notes.
- **Issue:** Plan text said `vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED }` for dashboard-api. But dashboard-api's handlers call the Notion API (external egress needed). Phase 1 had exactly this class of bug: notion-indexer deployed into PRIVATE_ISOLATED failed silently for 3 days because it had no internet route.
- **Fix:** Both `DashboardApi` and `DashboardNotify` Lambdas land in `PRIVATE_WITH_EGRESS` (the `lambda` subnet type introduced in the 2026-04-22 network refactor with its NAT gateway). Fargate `RelayService` stays in `PRIVATE_ISOLATED` — it only talks to the RDS Proxy (internal traffic via the proxy's public endpoint + IAM auth) and doesn't egress. `relay-proxy` Lambda uses `PRIVATE_WITH_EGRESS` because it needs to resolve the NLB's internal DNS name (which Route53 serves on the VPC resolver — isolated subnets work too, but leaving it in PRIVATE_WITH_EGRESS for uniformity with dashboard-api).
- **Files modified:** `packages/cdk/lib/stacks/dashboard-stack.ts`, `packages/cdk/lib/stacks/integrations-dashboard.ts`.
- **Commit:** `d054f40`.

**4. [Rule 3 — Test tooling] log-retention Lambda filter in CDK test**
- **Found during:** first test run of `dashboard-stack.test.ts`.
- **Issue:** The `logRetention` prop on Lambda causes CDK to inject an internal log-retention Lambda (nodejs22.x — the latest CDK dropped Node 20 from its defaults between the plan's drafting and now). `resourceCountIs('AWS::Lambda::Function', 3)` failed with "found 4".
- **Fix:** Test filters to Lambdas with `Runtime === 'nodejs22.x' && Architectures includes 'arm64'` — the log-retention Lambda has no Architectures field (defaults to x86_64). Kept the 3-Lambda invariant documented in the test comment.
- **Files modified:** `packages/cdk/test/dashboard-stack.test.ts`.
- **Commit:** `d054f40`.

### Deferred Issues

**1. `drizzle-kit push` still deferred** (carried from Plan 01).
- This plan does NOT apply migrations 0007-0010. See the `Schema push` section above for the three executable paths; Plan 05 will choose one.

**2. IAM access keys not auto-generated.**
- Plan 03-04's IAM users exist in CloudFormation; their access keys are generated manually post-deploy via `aws iam create-access-key --user-name kos-dashboard-caller`. Plan 11's rotation script handles re-creation on schedule. Auto-generation via `new AccessKey(...)` + `SecretValue` flows was considered but rejected: it binds key rotation to every stack deploy, which is a security regression vs. manual rotation on a schedule.

**3. Docker build not verified locally** (carried from Plan 03-03).
- `cdk synth` bundles the asset manifest + Dockerfile path; the actual `docker buildx build --platform linux/arm64` happens during `cdk deploy` (CI pipeline has buildx available). No local Docker daemon on the executor.

**4. Pre-existing CDK test breakage** (out of scope per SCOPE BOUNDARY).
- `test/agents-stack.test.ts`, `test/integrations-stack-notion.test.ts`, `test/integrations-stack-azure.test.ts`, `test/safety-stack.test.ts`, `test/network-stack.test.ts` all fail at typecheck or runtime on the current master tree (pre-date this plan). Root cause: the 2026-04-22 network refactor (NAT + subnet split) added required props to several StackProps that the tests haven't been updated for. Does not affect dashboard-stack tests. Logged as deferred; deserves its own cleanup plan in Phase 4.

**5. Pre-existing zod peer-warning cascade** (carried from Plan 03-00/01/02/03).
- `@anthropic-ai/claude-agent-sdk@0.2.117` transitively wants zod@^3.25 || ^4; monorepo on 3.23.8. Install + tests + synth all pass; dedicated infra bump owed.

### Auth gates

None encountered. All work was local filesystem + pnpm registry. No live AWS calls — synth only.

## Ready for Plan 03-05+ (deploy + live tests)

Plan 05 (CDK deploy) can now:
1. Run `pnpm --filter @kos/cdk exec cdk deploy KosDashboard --require-approval never`.
2. Post-deploy: seed the 3 Secrets Manager placeholders via `aws secretsmanager put-secret-value`.
3. Create IAM access keys for both caller users and store in `kos/dashboard-caller-access-keys`.
4. Run the chosen migration-apply path (see `Schema push` above).
5. Smoke-test: SigV4-sign a GET against `DashboardApiFunctionUrl/today`; expect zod-validated JSON. Long-poll `RelayProxyFunctionUrl/events?wait=1`; expect 200 with empty array.
6. Run Plan 11's `scripts/sync-vercel-env.ts` to push the Function URLs + access keys to Vercel env.

Plan 03-06..13 then compose the Vercel dashboard views against the live backend.

## Known Stubs

None — this plan is pure CDK composition; no placeholder handlers or mock data.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-network-surface | packages/cdk/lib/stacks/dashboard-stack.ts | Two new Lambda Function URLs (`DashboardApi` + `RelayProxy`) exposed to public internet, gated only by AWS_IAM auth + SigV4. Not a drift from the plan's <threat_model> (T-3-04-01 covers both), flagging for explicit Gate 2 review in the Phase 3 verifier run. |
| threat_flag: new-iam-users | packages/cdk/lib/stacks/dashboard-stack.ts | 2 long-lived IAM users (`kos-dashboard-caller` + `kos-dashboard-relay-caller`) with programmatic access keys stored in Vercel env. Mitigation: rotation via Plan 11 script; each policy scoped to a single function ARN + AuthType condition. Matches `<threat_model>` T-3-04-02. |

## Self-Check

### Files created / exist

- FOUND: `packages/cdk/lib/stacks/dashboard-stack.ts`
- FOUND: `packages/cdk/lib/stacks/integrations-dashboard.ts`
- FOUND: `packages/cdk/test/dashboard-stack.test.ts`
- FOUND: `services/dashboard-listen-relay/src/proxy.ts`
- FOUND: `packages/cdk/bin/kos.ts` (modified — DashboardStack registered)

### Commits exist

- FOUND: `d054f40` (feat(03-04): DashboardStack CDK composition)

## Self-Check: PASSED
