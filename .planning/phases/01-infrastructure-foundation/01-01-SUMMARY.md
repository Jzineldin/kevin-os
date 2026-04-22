---
phase: 01-infrastructure-foundation
plan: 01
subsystem: infrastructure
tags: [cdk, vpc, s3-gateway-endpoint, lambda-construct, network]
dependency_graph:
  requires:
    - Plan 01-00 (monorepo scaffold — ran in parallel; merge-reconciled by orchestrator)
  provides:
    - NetworkStack.vpc (IVpc) — consumed by DataStack (Plan 02), IntegrationsStack (Plans 04/05/06)
    - NetworkStack.s3GatewayEndpoint (IGatewayVpcEndpoint) — consumed by DataStack bucket policy
    - KosLambda construct — consumed by every Phase 1 Lambda-creating plan (notion-indexer, push-telegram, azure-bootstrap, transcribe-vocab-deploy, backfill)
  affects:
    - Downstream decisions on VPC interface endpoints (deferred per D-06)
    - Future NAT Gateway provisioning (deferred per D-05)
tech_stack:
  added:
    - aws-cdk-lib@2.248.0
    - constructs@10.5.0
    - aws-cdk CLI@2.1118.4
    - esbuild@0.24.0 (CDK bundling)
    - tsx@4.19.2 (CDK app runner — replaces ts-node for Node 22+ ESM compat)
    - vitest@2.1.4
  patterns:
    - Cross-stack references via direct props (not Fn::importValue) — RESEARCH Pattern 2
    - KosLambda wrapper around NodejsFunction with Node 22 ARM64 + externalized @aws-sdk/*
    - VPC subnet split: PUBLIC + PRIVATE_ISOLATED, no NAT
key_files:
  created:
    - packages/cdk/lib/constructs/kos-lambda.ts
    - packages/cdk/lib/stacks/network-stack.ts
    - packages/cdk/test/kos-lambda.test.ts
    - packages/cdk/test/network-stack.test.ts
    - packages/cdk/test/fixtures/dummy-handler.ts
    - packages/cdk/bin/kos.ts (skeleton from Plan 00 + NetworkStack wiring)
    - packages/cdk/lib/config/env.ts (skeleton from Plan 00)
    - packages/cdk/package.json, cdk.json, tsconfig.json, vitest.config.ts (skeleton from Plan 00)
    - package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore (repo root — skeleton from Plan 00)
  modified: []
decisions:
  - "CIDR block 10.40.0.0/16 (D-06 left this to executor discretion; chose 10.40 to leave 10.0-10.39 for Kevin's other future AWS accounts and Tale Forge infra)"
  - "ts-node -> tsx for CDK app runner (Rule 3: ts-node failed ESM resolution under Node 22+; tsx is drop-in and the modern standard)"
  - "aws-cdk CLI pinned to 2.1118.4 not 2.248.0 (Rule 3: Plan 00's 2.248.0 pin does not exist for the CLI package — CLI uses its own monotonic versioning)"
  - "constructs bumped from 10.4.2 to 10.5.0 (Rule 3: aws-cdk-lib 2.248.0 requires peer constructs@^10.5.0)"
  - "Dropped source-map-support/register import from bin/kos.ts (not needed at synth time; Lambda runtime source maps still enabled via NODE_OPTIONS=--enable-source-maps in KosLambda)"
metrics:
  completed: 2026-04-22
  duration_minutes: ~12
  tasks_completed: 2
  tasks_total: 2
  files_created: 14
  files_modified: 0
requirements:
  - INF-01 (partial — CDK scaffold + first stack)
  - INF-03 (S3 Gateway Endpoint in place)
---

# Phase 01 Plan 01: NetworkStack + KosLambda Construct Summary

VPC (10.40.0.0/16, 2 AZs, zero NAT) + S3 Gateway Endpoint shipped as `NetworkStack`; shared `KosLambda` construct encodes Node 22 ARM64 + externalized `@aws-sdk/*` + 30-day log retention for every Phase 1 Lambda.

## Objective

Implement `NetworkStack` per D-05 (split Lambda placement, no NAT in Phase 1) and D-06 (S3 Gateway Endpoint only) and publish the shared `KosLambda` construct that every Phase 1 Lambda will use. Wire `NetworkStack` into `bin/kos.ts` so DataStack (Plan 02), IntegrationsStack (Plans 04-06), and SafetyStack (Plan 07) can consume `vpc` + `s3GatewayEndpoint` via direct construct props in Wave 2.

## Outcome

- `NetworkStack` synthesizes cleanly — CloudFormation template contains **zero `AWS::EC2::NatGateway`** resources and **exactly one `AWS::EC2::VPCEndpoint`** of type `Gateway` (S3).
- VPC spans eu-north-1a + eu-north-1b with 4 subnets (2 public + 2 private isolated).
- CIDR: **10.40.0.0/16**, subnet mask /24 per subnet (~254 usable IPs per subnet).
- `KosLambda` construct ships with the mandated defaults: Node 22.x ARM_64, `externalModules: ['@aws-sdk/*']`, `TZ: 'UTC'`, `NODE_OPTIONS=--enable-source-maps`, 30-day log retention.
- `bin/kos.ts` wires `KosNetwork` and documents where Plans 02-07 will insert their stacks.
- 8 vitest assertions pass across 2 test files; NAT=0 and S3GatewayEndpoint=1 are directly asserted.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | KosLambda construct | `9fc87c4` | `packages/cdk/lib/constructs/kos-lambda.ts`, `packages/cdk/test/kos-lambda.test.ts`, `packages/cdk/test/fixtures/dummy-handler.ts` + Plan-00 scaffold files |
| 2 | NetworkStack + bin/kos.ts wiring | `21cec5f` | `packages/cdk/lib/stacks/network-stack.ts`, `packages/cdk/test/network-stack.test.ts`, `packages/cdk/bin/kos.ts` |

## Verification

**Synth:** `cd packages/cdk && npx cdk synth KosNetwork --quiet` — exit 0.

**Template counts (grep of synthesized YAML):**
- `AWS::EC2::NatGateway`: **0** (D-05 compliance)
- `AWS::EC2::VPCEndpoint`: **1**
- `VpcEndpointType: Gateway`: **1** (D-06 compliance)
- `AWS::EC2::Subnet`: **4** (2 public + 2 private isolated across 2 AZs)
- `CidrBlock: 10.40.0.0/16`: present on VPC resource

**Tests:** `pnpm --filter @kos/cdk test -- --run` — 8/8 pass.
- KosLambda: Node 22.x runtime, ARM64 architecture, env-var merge (3 tests)
- NetworkStack: 0 NAT Gateways, 1 S3 Gateway Endpoint, 4 subnets across 2 AZs, isolated subnets carry no public IP, CIDR is 10.40.0.0/16 (5 tests)

**Lint/typecheck:** Skipped for Wave 1 (eslint/prettier configs land with Plan 00 scaffold; deferred to Wave 0 merge).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] aws-cdk CLI version 2.248.0 does not exist**
- **Found during:** Task 1 `pnpm install`.
- **Issue:** Plan 00 pinned `"aws-cdk": "2.248.0"` but the CLI package uses its own monotonic versioning (`2.1118.4` is latest, `2.204.0` next closest; no `2.248.0` exists). `aws-cdk-lib`@2.248.0 does exist and was kept.
- **Fix:** Pinned `aws-cdk` CLI to `2.1118.4`.
- **Files modified:** `packages/cdk/package.json`
- **Commit:** `9fc87c4`

**2. [Rule 3 — Blocking] aws-cdk-lib peer dep requires constructs@^10.5.0**
- **Found during:** Task 1 `pnpm install` peer-dep warning.
- **Issue:** Plan 00 pinned `constructs: 10.4.2` but `aws-cdk-lib@2.248.0` requires `constructs@^10.5.0`.
- **Fix:** Bumped to `10.5.0`.
- **Files modified:** `packages/cdk/package.json`
- **Commit:** `9fc87c4`

**3. [Rule 1 — Bug] Test assertion on `Runtime === 'nodejs22.x'` matched 2 resources**
- **Found during:** Task 1 test execution.
- **Issue:** The LogRetention provider Lambda CDK generates (because `logRetention: ONE_MONTH` is set) also runs on nodejs22.x in newer CDK versions, so filtering by runtime didn't uniquely identify the KosLambda.
- **Fix:** Filter by the user-supplied `CUSTOM_VAR` env var instead — only the KosLambda carries it, so the count is deterministic.
- **Files modified:** `packages/cdk/test/kos-lambda.test.ts`
- **Commit:** `9fc87c4`

**4. [Rule 1 — Bug] `Match.stringLikeRegexp` on ServiceName failed because CDK emits Fn::Join**
- **Found during:** Task 2 test execution.
- **Issue:** S3 Gateway Endpoint's `ServiceName` is emitted as `{Fn::Join: ['', ['com.amazonaws.', {Ref: 'AWS::Region'}, '.s3']]}`, not a resolved string.
- **Fix:** Assertion now matches the Fn::Join structure directly (`'com.amazonaws.'` + `'.s3'` inside the array).
- **Files modified:** `packages/cdk/test/network-stack.test.ts`
- **Commit:** `21cec5f`

**5. [Rule 3 — Blocking] ts-node ESM resolution broken under Node 22+**
- **Found during:** Task 2 first `cdk synth` attempt.
- **Issue:** With `"type": "module"` in package.json, `ts-node --prefer-ts-exts` can't resolve relative TS imports. Trying `.js` extensions failed the same way — ts-node's ESM loader wasn't picking them up under Node 24 (dev machine) / Node 22 (target).
- **Fix:** Swapped `ts-node` → `tsx` in `packages/cdk/package.json` and updated `cdk.json` app command to `npx tsx bin/kos.ts`. `tsx` is the modern standard for ESM+TS execution.
- **Files modified:** `packages/cdk/cdk.json`, `packages/cdk/package.json`, `packages/cdk/bin/kos.ts` (imports use `.js` extensions now, which `tsx` resolves correctly).
- **Commit:** `21cec5f`

**6. [Rule 3 — Blocking] `source-map-support/register` failed ESM resolution**
- **Found during:** Task 2 first `cdk synth` attempt.
- **Issue:** `import 'source-map-support/register'` resolved to `@cspotcode/source-map-support` (dependency of ts-node) but Node's strict ESM resolver refused the extensionless import.
- **Fix:** Dropped the import from `bin/kos.ts`. Source maps are not needed during synth; Lambda-runtime source maps are still enabled via `NODE_OPTIONS=--enable-source-maps` (set by KosLambda). `source-map-support` remains in dependencies for any future non-ESM use.
- **Files modified:** `packages/cdk/bin/kos.ts`
- **Commit:** `21cec5f`

### Escalated Deviations
None — no architectural changes required.

## Deferred to Operator

- **`cdk deploy KosNetwork`** — synth is green, but actual deploy requires AWS credentials with CDK bootstrap role privileges. This plan's environment guardrails prohibit AWS writes. Operator must run from a bootstrapped environment:
  ```bash
  cd packages/cdk
  CDK_DEFAULT_ACCOUNT=239541130189 npx cdk deploy KosNetwork --require-approval never
  ```
- **CDK bootstrap** (`npx cdk bootstrap`) — this is Plan 00's preflight Task 3 responsibility. If Plan 00's preflight has already run, no action needed.
- **Verify `cdk.context.json` is committed** — CDK generated this file during synth to cache AZ lookups. Convention: commit it for deterministic synths across machines. Not committed in this plan (leaving for the Wave 0/Wave 1 merge integration step).

## Known Stubs
None — both deliverables are fully implemented (VPC + endpoint construct for NetworkStack; complete NodejsFunction wrapper for KosLambda).

## Coordination Notes

Plan 00 (scaffold) ran in parallel in a separate worktree. Files both plans touched:
- `packages/cdk/bin/kos.ts` — Plan 00 creates the empty skeleton; this plan adds the `NetworkStack` instantiation. Orchestrator merge should result in Plan 00's skeleton + Plan 01's NetworkStack wiring.
- `packages/cdk/package.json` — Plan 00 defines deps; this plan bumped `aws-cdk` to `2.1118.4`, `constructs` to `10.5.0`, and swapped `ts-node` → `tsx`. These bumps are hard requirements (see Deviations 1-2, 5) and should supersede Plan 00's pins during merge.
- `packages/cdk/cdk.json` — Plan 00 creates it; this plan swapped the app command to `tsx`. Supersede.
- Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore` — Plan 00 owns these canonically. If Plan 00's versions differ, prefer Plan 00's (this plan created them as minimal stand-ins to let tests + synth run; Plan 00's fuller versions include eslint/prettier/vitest toolchain and the `preflight` root script).

## Threat Flags
None — implementation stays within the plan's declared `<threat_model>` scope (VPC perimeter + S3 Gateway Endpoint boundary). No new surfaces introduced.

## Self-Check

- [x] `packages/cdk/lib/stacks/network-stack.ts` exists
- [x] `packages/cdk/lib/constructs/kos-lambda.ts` exists
- [x] `packages/cdk/test/network-stack.test.ts` exists
- [x] `packages/cdk/test/kos-lambda.test.ts` exists
- [x] `packages/cdk/test/fixtures/dummy-handler.ts` exists
- [x] `packages/cdk/bin/kos.ts` references `new NetworkStack`
- [x] Commit `9fc87c4` present in `git log`
- [x] Commit `21cec5f` present in `git log`
- [x] `pnpm --filter @kos/cdk test -- --run` exits 0 (8/8 passing)
- [x] `cd packages/cdk && npx cdk synth KosNetwork --quiet` exits 0
- [x] Synthesized template: `AWS::EC2::NatGateway` count = 0
- [x] Synthesized template: `VpcEndpointType: Gateway` count = 1

## Self-Check: PASSED
