---
phase: 01-infrastructure-foundation
plan: 08
subsystem: infrastructure
tags: [cdk, ecs, fargate, drizzle, gate-1, verifier]
requires:
  - KosNetwork (vpc) — plan 01
  - KosData (DataStack) — plan 02
  - @kos/db Drizzle schema + ownerId() helper — plan 02
  - All per-plan verifiers — plans 04, 05, 06, 07
provides:
  - KosCluster construct (ARM64 Fargate cluster shell)
  - DataStack.ecsCluster public readonly (consumed by Phase 4 EmailEngine, Phase 5 Baileys, Phase 8 Postiz)
  - Owner-id forward-compat sweep test (blocks any new table without owner_id)
  - scripts/verify-gate-1.mjs — single-command Phase 1 → Phase 2 go/no-go
  - scripts/verify-stacks-exist.sh — 5-stack health probe
  - npm scripts: verify:stacks, verify:gate-1
affects:
  - packages/cdk/lib/stacks/data-stack.ts (+1 ecsCluster field, +1 KosCluster instantiation)
  - package.json (+2 script entries)
tech-stack:
  added: []
  patterns:
    - "CDK construct composition: empty cluster shell in Phase 1, FargateService attach at Phase 4/5/8"
    - "containerInsightsV2 in place of deprecated boolean (forward-compat across aws-cdk-lib majors)"
    - "Drizzle schema introspection via getTableName + getTableColumns for forward-compat enforcement"
    - "Gate verifier pattern: SDK for EventBridge/SecretsManager; AWS CLI for Budgets/SNS (not hoisted)"
key-files:
  created:
    - packages/cdk/lib/constructs/kos-cluster.ts
    - packages/cdk/test/cluster.test.ts
    - packages/db/test/owner-sweep.test.ts
    - scripts/verify-gate-1.mjs
    - scripts/verify-stacks-exist.sh
  modified:
    - packages/cdk/lib/stacks/data-stack.ts
    - package.json
decisions:
  - "Fargate cluster lives in DataStack (not NetworkStack) — services that land in Phases 4/5/8 need RDS + blobs which already live there; single cross-stack dependency is simpler than splitting cluster+services"
  - "containerInsightsV2: DISABLED (not ENHANCED) for empty Phase 1 cluster — zero CloudWatch Logs spend until first service attaches"
  - "Budgets + SNS checks use AWS CLI (not SDK) — @aws-sdk/client-sns and @aws-sdk/client-budgets are not hoisted at the workspace root; CLI is already a Gate 1 prerequisite"
  - "Owner-sweep test asserts dataType='string' AND notNull=true for every ownerId column — tighter than Plan 02's schema.test.ts which only asserted presence"
metrics:
  duration_minutes: ~35
  completed: 2026-04-22
  tasks: 2
  commits: 2
  files_changed: 7
  lines_added: 500
---

# Phase 1 Plan 08: ECS Fargate cluster + Gate 1 master verifier Summary

**One-liner:** Closes Phase 1 with an empty ARM64 Fargate cluster (INF-06; services attach in Phases 4/5/8), a forward-compat sweep test that fails CI on any new Drizzle table without `owner_id`, and the `pnpm run verify:gate-1` one-shot orchestrator that runs all 9 ROADMAP Phase 1 Gate criteria sequentially.

## Scope

Final plan of Phase 1. Three artifacts ship together:

1. **ECS Fargate cluster shell** (INF-06) — provisioned but empty. Platform version 1.4.0 and ARM64 are declared at FargateService attach time in later phases, not here. Cluster lives in DataStack because the services that will attach (EmailEngine Phase 4, Baileys Phase 5, Postiz Phase 8) all need RDS + blobs.
2. **Owner-id sweep test** — forward-compat enforcement per STATE.md Locked Decision #13. Complements `packages/db/test/schema.test.ts` from Plan 02 with stricter assertions (`dataType=string` + `notNull=true`, not just presence).
3. **Master Gate 1 verifier** — `pnpm run verify:gate-1` shells out to every per-plan verifier (`verify-vps-freeze.mjs`, `verify-vps-freeze-48h.mjs`, `verify-azure-index.mjs`, `verify-transcribe-vocab.sh`, `verify-cap.mjs`, `backfill-notion.sh`) plus ad-hoc assertions for CFN stacks, EventBridge buses, RDS (pgvector + 8 tables + owner_id sweep + event_log sink), Notion (13-field Entities + 6-field Projects + 5 populated DB IDs), S3 Gateway Endpoint, Budgets + SNS-confirmed subscription, and the notion-reconcile-weekly scheduler.

Reuses Plan 02's `ownerId()` helper and `KEVIN_OWNER_ID`. Does not touch NetworkStack, EventsStack, IntegrationsStack, or SafetyStack.

## What Was Built

### Task 1: KosCluster + owner-sweep test (commit `2a6b2a7`)

**`packages/cdk/lib/constructs/kos-cluster.ts`** — 41 lines. Single `Cluster` resource, named `kos-cluster`, containerInsightsV2=DISABLED (the boolean `containerInsights` form is deprecated and slated for removal in the next aws-cdk-lib major). No task definitions, no services — those attach in later phases.

**`packages/cdk/lib/stacks/data-stack.ts`** — +9 lines:
- Added `import type { Cluster } from 'aws-cdk-lib/aws-ecs'`
- Added `import { KosCluster } from '../constructs/kos-cluster.js'`
- Added `public readonly ecsCluster: Cluster;` field
- Instantiated `this.ecsCluster = new KosCluster(this, 'EcsCluster', { vpc: props.vpc }).cluster;` before the opt-in bastion block

**`packages/cdk/test/cluster.test.ts`** — 4 synth-time assertions:
- Exactly one `AWS::ECS::Cluster` resource
- `ClusterName: 'kos-cluster'`
- `data.ecsCluster` defined and exposes a (Token-wrapped) ARN
- Zero task definitions, zero services in Phase 1

**`packages/db/test/owner-sweep.test.ts`** — 4 assertions:
- At least 7 tables exported (regression guard)
- Every exported table has an `ownerId` column (using Drizzle's `getTableColumns`)
- Every `ownerId` column has `dataType='string'` AND `notNull=true`
- `KEVIN_OWNER_ID` matches the strict RFC 4122 v4 regex (not just the loose hex-dash form in Plan 02's test)

### Task 2: Master verifier + stacks-exist + npm scripts (commit `1b270e0`)

**`scripts/verify-stacks-exist.sh`** — 36 lines. Iterates `KosNetwork KosData KosEvents KosIntegrations KosSafety`; exits 0 only when every stack is `CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE`.

**`scripts/verify-gate-1.mjs`** — 297 lines. Sequential step runner with per-step timing. Steps 1-9 are hard failures; two bonus steps (cap + backfill) print `[SKIP]` when prerequisites absent (cap skips outside 08-20 Stockholm; backfill is best-effort).

Secrets auto-fetch:
- If `DATABASE_URL` unset, lists `KosData*Credentials*` secrets, reads the first, synthesises the URL (honours `KOS_DB_TUNNEL_PORT` for local bastion tunnels)
- If `NOTION_TOKEN` unset, fetches from secret `kos/notion-token`

Step 3 live assertions (post `DATABASE_URL` resolution):
- `SELECT extversion FROM pg_extension WHERE extname='vector'` → non-empty
- 8 tables exist (count of `entity_index, project_index, agent_runs, notion_indexer_cursor, mention_events, event_log, telegram_inbox_queue, kevin_context`)
- No `public.*` base table lacks the `owner_id` column
- `event_log` table present (archive-not-delete sink for step 9's reconciler)

Step 4 Notion assertions:
- Every key in `scripts/.notion-db-ids.json` populated (and not still `pending-bootstrap`)
- Entities DB has all 13 Spec fields
- Projects DB has Name, Bolag, Status, Description, LinkedPeople, SeedContext

Step 9 chains `verify-transcribe-vocab.sh` AND asserts `aws scheduler list-schedules --group-name kos-schedules` returns exactly 1 schedule named `notion-reconcile-weekly`.

**`package.json`** — added `"verify:stacks"` + `"verify:gate-1"` scripts.

## Verification

**Local (this plan's assertions):**

```
pnpm --filter @kos/db test -- --run owner-sweep
  4 tests passed (owner-sweep.test.ts) — 2 ms

pnpm --filter @kos/cdk test -- --run cluster
  4 tests passed (cluster.test.ts) — 4 ms

pnpm --filter @kos/cdk test -- --run data-stack
  9 tests passed (data-stack.test.ts) — 5 ms  [regression check: existing
  DataStack assertions unaffected by new ECS cluster]

cd packages/cdk && npx cdk synth KosData --quiet
  SYNTH OK

node --check scripts/verify-gate-1.mjs
  SYNTAX OK
```

All acceptance-criteria grep assertions pass:

```
OK verify-azure-index.mjs, verify-transcribe-vocab.sh, verify-cap.mjs,
OK verify-vps-freeze.mjs, verify-vps-freeze-48h.mjs, backfill-notion.sh
OK notion-reconcile-weekly, kos/notion-token, KosData, kevin_context,
OK owner-sweep, "Gate 1: ALL CHECKS GREEN"
OK package.json contains "verify:stacks" and "verify:gate-1"
```

## Deferred to Operator

Per the execution guardrails, this plan does NOT touch live AWS. The following must run on a workstation with deployed stacks + live Notion DBs + observation log:

1. **`cdk deploy KosData`** — provisions the ECS cluster (a cluster-only diff should deploy in ~90 s).
2. **First live `pnpm run verify:gate-1` run** — requires:
   - All 9 stacks deployed
   - RDS schema pushed (`pnpm run db:push`)
   - Notion DBs bootstrapped (`pnpm run notion:bootstrap` — populates `.notion-db-ids.json`)
   - `NOTION_TOKEN` seeded in `kos/notion-token` Secrets Manager
   - `scripts/deploy-vps-freeze.sh` run at least 48 h before (observation log required)
   - SNS email subscription confirmed (operator clicks link in `kevin@tale-forge.app`)
3. **Live cluster health** — `aws ecs describe-clusters --clusters kos-cluster --region eu-north-1 --query "clusters[0].status" --output text` should return `ACTIVE`.

The SUMMARY will be updated post-live-run with the first green-gate timing report.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 - Deprecation hygiene] Switched to `containerInsightsV2`**
- **Found during:** Task 1 vitest run
- **Issue:** `containerInsights: false` triggers a `[WARNING] aws-cdk-lib.aws_ecs.ClusterProps#containerInsights is deprecated. See containerInsightsV2. This API will be removed in the next major release.`
- **Fix:** Changed to `containerInsightsV2: ContainerInsights.DISABLED`; imported `ContainerInsights` enum
- **Files:** `packages/cdk/lib/constructs/kos-cluster.ts`
- **Commit:** `2a6b2a7`

**2. [Rule 3 - Blocking] Replaced `@aws-sdk/client-sns` + `@aws-sdk/client-budgets` with AWS CLI calls**
- **Found during:** Task 2 dependency check
- **Issue:** Neither SDK is hoisted at the workspace root (`node_modules/.pnpm/` only has secrets-manager, eventbridge, s3, transcribe, dynamodb, cognito, sts). Adding them would violate the "no new deps" execution guardrail and the plan's no-install scope.
- **Fix:** Budgets check now shells to `aws budgets describe-budgets`; SNS check shells to `aws sns list-subscriptions-by-topic`. Both are already Gate 1 prerequisites.
- **Files:** `scripts/verify-gate-1.mjs`
- **Commit:** `1b270e0`

**3. [Rule 1 - Test bug] Cluster-name assertion against Token**
- **Found during:** Task 1 first vitest run
- **Issue:** `expect(data.ecsCluster.clusterName).toBe('kos-cluster')` failed because CDK returns a Token (`${Token[TOKEN.1417]}`) at synth time, not the resolved string.
- **Fix:** Changed assertion to `expect(typeof data.ecsCluster.clusterArn).toBe('string')` — the resolved name is already covered by the CFN Template `ClusterName: 'kos-cluster'` assertion.
- **Files:** `packages/cdk/test/cluster.test.ts`
- **Commit:** `2a6b2a7`

### Scope-boundary log (deferred, not fixed)

Pre-existing Wave 3 typecheck failures in `integrations-stack-azure.test.ts` and `integrations-stack-notion.test.ts` (see `.planning/phases/01-infrastructure-foundation/deferred-items.md`) remain unfixed. Out of scope for Plan 08; noted to the next-phase orchestrator.

## Known Stubs

None. The cluster shell is intentionally empty — services land in Phases 4/5/8 per roadmap. The plan's objective is a cluster resource, not a running workload.

## Self-Check: PASSED

- FOUND: packages/cdk/lib/constructs/kos-cluster.ts
- FOUND: packages/cdk/lib/stacks/data-stack.ts (modified; contains `KosCluster` + `ecsCluster`)
- FOUND: packages/cdk/test/cluster.test.ts
- FOUND: packages/db/test/owner-sweep.test.ts
- FOUND: scripts/verify-gate-1.mjs (exec bit set)
- FOUND: scripts/verify-stacks-exist.sh (exec bit set)
- FOUND: package.json contains "verify:gate-1" and "verify:stacks"
- FOUND: commit 2a6b2a7 (Task 1)
- FOUND: commit 1b270e0 (Task 2)
