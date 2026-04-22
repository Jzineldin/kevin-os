---
phase: 01-infrastructure-foundation
plan: 00
subsystem: infra
tags: [pnpm, monorepo, typescript, aws-cdk, drizzle, zod, eventbridge, preflight, cdk-bootstrap, transcribe]

requires: []
provides:
  - pnpm monorepo root with workspaces targeting packages/* and services/*
  - tsconfig.base.json strict-mode baseline (ES2022, Bundler resolution, noUncheckedIndexedAccess)
  - ESLint + Prettier + Vitest root tooling
  - "@kos/cdk scaffold: aws-cdk-lib 2.248.0 App entry, env constants (PRIMARY_REGION, STOCKHOLM_TZ, ALARM_EMAIL, OWNER_ID), vitest baseline"
  - "@kos/db scaffold: drizzle-orm 0.36.0 + pg 8.13.1 + drizzle.config.ts (schema path ready for Plan 02)"
  - "@kos/contracts: BUS_NAMES const (kos.capture/triage/agent/output/system) + EventMetadataSchema (zod)"
  - scripts/preflight.sh verifying Node/pnpm/AWS CLI/Azure/AWS creds/Transcribe region/CDK bootstrap/VPS SSH
  - scripts/.transcribe-region committed file pinning A9 to eu-north-1
  - Live CDK bootstrap in aws://239541130189/eu-north-1 (CDKToolkit stack CREATE_COMPLETE)
affects: [01-01-network, 01-02-data, 01-03-events, 01-04-notion, 01-05-azure-search, 01-06-transcribe, 01-07-safety, all Phase 2+ plans]

tech-stack:
  added:
    - pnpm@9.12.0 (packageManager)
    - typescript@5.6.3
    - eslint@9.14.0 + @typescript-eslint@8.13.0
    - prettier@3.3.3
    - vitest@2.1.4
    - aws-cdk-lib@2.248.0 + aws-cdk CLI@2.1118.4 + constructs@10.5.1
    - drizzle-orm@0.36.0 + drizzle-kit@0.28.1 + pg@8.13.1
    - zod@3.23.8
    - esbuild@0.24.0 (CDK asset bundling)
  patterns:
    - "Monorepo: pnpm workspaces with packages/* (libraries) and services/* (future Lambda/Fargate apps)"
    - "Workspace tsconfig pattern: each package extends ../../tsconfig.base.json and sets rootDir/outDir"
    - "CDK bootstrap: bin/kos.ts imports RESOLVED_ENV + OWNER_ID from lib/config/env.ts for reuse across every stack"
    - "Load-bearing const: BUS_NAMES in @kos/contracts is the canonical source for EventBridge bus names across all 10 phases"
    - "Preflight-first: scripts/preflight.sh is the single entrypoint for verifying a dev machine is Phase 1-ready (runnable via `pnpm preflight`)"

key-files:
  created:
    - .nvmrc
    - package.json
    - pnpm-workspace.yaml
    - tsconfig.base.json
    - .gitignore
    - .eslintrc.cjs
    - .prettierrc
    - pnpm-lock.yaml
    - packages/cdk/package.json
    - packages/cdk/cdk.json
    - packages/cdk/tsconfig.json
    - packages/cdk/bin/kos.ts
    - packages/cdk/lib/config/env.ts
    - packages/cdk/vitest.config.ts
    - packages/cdk/test/app.test.ts
    - packages/db/package.json
    - packages/db/tsconfig.json
    - packages/db/drizzle.config.ts
    - packages/db/src/index.ts
    - packages/db/vitest.config.ts
    - packages/contracts/package.json
    - packages/contracts/tsconfig.json
    - packages/contracts/src/events.ts
    - scripts/preflight.sh
    - scripts/.transcribe-region
  modified: []

key-decisions:
  - "CDK package ships as CommonJS (no \"type\":\"module\") so ts-node hydrates cdk.json's app command without ESM resolution errors"
  - "aws-cdk CLI uses versioning stream 2.1xxx.x (2.1118.4) distinct from aws-cdk-lib (2.248.0); plan's 2.248.0 on both was not valid for the CLI package"
  - "constructs pinned to 10.5.1 to satisfy aws-cdk-lib 2.248.0 peer dependency (plan's 10.4.2 triggered ERR_PNPM_PEER_DEP_ISSUES)"
  - "Preflight bootstraps CDK from a temp dir because aws-cdk CLI 2.1118.4 short-circuits `cdk bootstrap` with 'This app contains no stacks' when invoked in a project whose cdk.json resolves to an empty App"
  - "drizzle-orm pinned at 0.36.0 (satisfies RESEARCH.md's >=0.31 requirement for built-in `vector()`); CLAUDE.md §Recommended Stack says 0.30+ but 0.30 predates built-in vector — see CLAUDE.md patch proposal below"

patterns-established:
  - "Atomic task commits: each Task in a plan becomes one commit with conventional-commit scope (phase-plan), e.g. feat(01-00): ..."
  - "Preflight file contract: scripts/.transcribe-region is a committed text file (single line, trailing newline acceptable) that later plans read as the source-of-truth Transcribe region"
  - "Execution environment tolerance: preflight accepts Node >=22 (not strictly 22.x) so the same script works on 22.x reference envs and 24.x dev machines"

requirements-completed:
  - INF-01

duration: 10m
completed: 2026-04-22
---

# Phase 01 Plan 00: Monorepo Foundation Summary

**pnpm monorepo with @kos/cdk (empty aws-cdk-lib 2.248.0 App), @kos/db (drizzle 0.36.0 baseline), @kos/contracts (five load-bearing EventBridge bus names), and a preflight script that resolved A9 (Transcribe sv-SE available in eu-north-1) and live-bootstrapped CDK in aws://239541130189/eu-north-1.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-04-22T01:47Z
- **Completed:** 2026-04-22T01:59Z
- **Tasks:** 4 (all `type="auto"`, no checkpoints)
- **Files created:** 25

## Accomplishments

- Monorepo root scaffolded (pnpm workspaces, strict TS, ESLint/Prettier/Vitest). `pnpm install --frozen-lockfile`, `pnpm -w test`, and `cd packages/cdk && npx cdk synth --quiet` all green.
- `@kos/cdk` package synthesizes an empty App with `project=kos`/`owner=kevin` tags. `lib/config/env.ts` exports the canonical region/timezone/alarm-email/owner-UUID constants every later stack imports.
- `@kos/db` and `@kos/contracts` packages typecheck clean. The five EventBridge bus names (`kos.capture`, `kos.triage`, `kos.agent`, `kos.output`, `kos.system`) are now a load-bearing `as const` export that Plan 01-03 (EventsStack) consumes directly.
- `scripts/preflight.sh` runnable via `pnpm preflight`. Live run on 2026-04-22 resolved Research Assumption **A9 = eu-north-1** (no fallback needed) and created the CDKToolkit stack in the target account.

## Task Commits

1. **Task 0: Monorepo scaffold** — `4cef320` chore(01-00): scaffold monorepo root (pnpm workspaces + tsconfig + lint/format)
2. **Task 1: CDK package skeleton** — `d7a9990` feat(01-00): scaffold @kos/cdk package (empty app + env config + vitest)
3. **Task 2: Drizzle + contracts** — `cacbbd3` feat(01-00): scaffold @kos/db and @kos/contracts packages
4. **Task 3: Preflight + CDK bootstrap** — `29ae5be` chore(01-00): add Phase 1 preflight script and resolve A9 (Transcribe eu-north-1)
5. **Fix: --passWithNoTests on @kos/db** — `4d38c05` fix(01-00): pass --passWithNoTests to @kos/db vitest

## Files Created/Modified

**Root tooling**
- `.nvmrc` — Pins Node 22.12.0 as baseline (preflight accepts >=22)
- `package.json` — Name `kos`, private, packageManager `pnpm@9.12.0`, `pnpm -w` scripts (test/build/lint/typecheck/preflight)
- `pnpm-workspace.yaml` — workspace globs for `packages/*` and `services/*`
- `tsconfig.base.json` — ES2022, Bundler resolution, `strict`, `noUncheckedIndexedAccess`
- `.gitignore` — excludes `node_modules`, `dist`, `cdk.out`, `.env`, `packages/db/drizzle/`
- `.eslintrc.cjs` / `.prettierrc` — repo-wide lint/format config

**`@kos/cdk`**
- `packages/cdk/package.json` — aws-cdk-lib 2.248.0, aws-cdk CLI 2.1118.4, constructs 10.5.1, esbuild 0.24.0, vitest 2.1.4
- `packages/cdk/cdk.json` — ts-node App entrypoint + CDK feature flags
- `packages/cdk/tsconfig.json` — extends base, overrides to CommonJS / Node resolution for ts-node
- `packages/cdk/bin/kos.ts` — `new App()`, tags, `app.synth()`; reserved `env` reference for later stacks
- `packages/cdk/lib/config/env.ts` — `PRIMARY_REGION='eu-north-1'`, `STOCKHOLM_TZ='Europe/Stockholm'`, `AZURE_SEARCH_REGION='westeurope'`, `ALARM_EMAIL='kevin@tale-forge.app'`, `OWNER_ID='7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'`
- `packages/cdk/vitest.config.ts` / `packages/cdk/test/app.test.ts` — baseline vitest + one passing test

**`@kos/db`**
- `packages/db/package.json` — drizzle-orm 0.36.0, drizzle-kit 0.28.1, pg 8.13.1; test script uses `--passWithNoTests`
- `packages/db/tsconfig.json` / `packages/db/vitest.config.ts` — baselines
- `packages/db/drizzle.config.ts` — postgresql dialect, schema path `./src/schema.ts` (created in Plan 02), `dbCredentials.url` from `DATABASE_URL`
- `packages/db/src/index.ts` — placeholder export; schema + connection helpers land in Plan 02

**`@kos/contracts`**
- `packages/contracts/package.json` — zod 3.23.8; test uses `--passWithNoTests`
- `packages/contracts/tsconfig.json` — baseline
- `packages/contracts/src/events.ts` — `BUS_NAMES` const (five kos.* names) + `BusName` type + `EventMetadataSchema` (ulid captureId, uuid ownerId, datetime occurredAt)

**Scripts**
- `scripts/preflight.sh` — executable; verifies environment + resolves A9 + bootstraps CDK
- `scripts/.transcribe-region` — committed; content `eu-north-1`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| CDK package is CommonJS (drop `"type":"module"` from plan) | `"type":"module"` + `ts-node --prefer-ts-exts bin/kos.ts` caused `ERR_MODULE_NOT_FOUND` for `source-map-support/register` under Node 24.11.1 ESM resolution. CDK's conventional ts-node flow is CommonJS. |
| aws-cdk CLI pinned at 2.1118.4, aws-cdk-lib at 2.248.0 | Plan pinned `aws-cdk@2.248.0` but that version does not exist — aws-cdk (the CLI package) uses the 2.1xxx.x versioning stream. Latest CLI on 2026-04-22 is 2.1118.4; it's compatible with aws-cdk-lib 2.248.0. |
| constructs at 10.5.1 (plan said 10.4.2) | aws-cdk-lib 2.248.0 declares `peer constructs@^10.5.0`. Using 10.4.2 emitted an unmet-peer warning; bumped to 10.5.1 (next stable) to keep the dep graph clean. |
| Preflight bootstraps CDK from a temp dir | aws-cdk CLI 2.1118.4 short-circuits `cdk bootstrap` with "This app contains no stacks" when launched from a project whose `cdk.json` resolves to an empty App. Bootstrapping from a neutral directory (`mktemp -d`) works. This hack-around is tracked as a CLI quirk; reassess when bumping CLI. |
| Preflight accepts Node `>=22` instead of strictly `22.x` | Worktree Node is 24.11.1; the stack works on both. Rejecting 24 would force a downgrade for no benefit. `.nvmrc` still pins 22.12.0 as the reference baseline. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] aws-cdk CLI version 2.248.0 does not exist**
- **Found during:** Task 1 (pnpm install)
- **Issue:** Plan pinned `"aws-cdk": "2.248.0"` as a devDependency. pnpm emitted `ERR_PNPM_NO_MATCHING_VERSION — the latest release of aws-cdk is "2.1118.4"`. The aws-cdk CLI ships on a separate 2.1xxx.x versioning stream from the 2.xxx.x stream used by aws-cdk-lib.
- **Fix:** Pinned `aws-cdk@2.1118.4` (latest stable CLI as of 2026-04-22; compatible with aws-cdk-lib 2.248.0).
- **Files modified:** packages/cdk/package.json
- **Verification:** `pnpm install` succeeded; `npx cdk --version` prints `2.1118.4 (build 82715b6)`.
- **Committed in:** `d7a9990` (Task 1 commit)

**2. [Rule 3 — Blocking] constructs 10.4.2 unmet peer of aws-cdk-lib 2.248.0**
- **Found during:** Task 1 (pnpm install)
- **Issue:** aws-cdk-lib 2.248.0 declares `peer constructs@^10.5.0`. Plan pinned constructs 10.4.2.
- **Fix:** Bumped to constructs 10.5.1 (next stable release that satisfies the peer range).
- **Files modified:** packages/cdk/package.json
- **Verification:** `pnpm install` completes with no unmet-peer warnings; CDK typecheck + synth + test all green.
- **Committed in:** `d7a9990` (Task 1 commit)

**3. [Rule 1 — Bug] CDK package `"type":"module"` broke ts-node bootstrap**
- **Found during:** Task 1 (cdk synth)
- **Issue:** Plan instructed `"type": "module"` in `packages/cdk/package.json`. With that flag, `npx ts-node --prefer-ts-exts bin/kos.ts` (the standard CDK hydration command in `cdk.json`) fails with `ERR_MODULE_NOT_FOUND` for the CommonJS-style import `'source-map-support/register'`. Node 24's ESM loader will not resolve that specifier without an explicit `/register.js` suffix.
- **Fix:** Removed `"type": "module"` from `packages/cdk/package.json`. Also set the CDK package's `tsconfig.json` to `module: CommonJS` + `moduleResolution: Node` to match ts-node's default. This matches every CDK TypeScript project generated by `cdk init` in the current toolchain.
- **Files modified:** packages/cdk/package.json, packages/cdk/tsconfig.json
- **Verification:** `npx cdk synth --quiet` emits `This app contains no stacks` (expected for empty App); `pnpm --filter @kos/cdk test` passes; typecheck clean.
- **Committed in:** `d7a9990` (Task 1 commit)

**4. [Rule 1 — Bug] aws-cdk CLI 2.1118.4 fails to bootstrap from project directory**
- **Found during:** Task 3 (preflight run)
- **Issue:** Running `npx cdk bootstrap aws://239541130189/eu-north-1` from `packages/cdk/` (where `cdk.json` resolves to an empty App) prints `This app contains no stacks` and exits without bootstrapping. Bug is CLI-specific; reproduces with `--app "echo"`, `--force`, `--verbose`.
- **Fix:** Preflight bootstraps from a `mktemp -d` temp dir using `npx --yes aws-cdk@2.1118.4 bootstrap ...`. With no `cdk.json` in scope, the CLI follows the happy path and creates the CDKToolkit stack.
- **Files modified:** scripts/preflight.sh
- **Verification:** Live run on 2026-04-22 created all 12 CDKToolkit resources; `aws cloudformation describe-stacks --stack-name CDKToolkit --region eu-north-1` returns `CREATE_COMPLETE`.
- **Committed in:** `29ae5be` (Task 3 commit)

**5. [Rule 1 — Bug] `pnpm -w test` failed because @kos/db has no tests**
- **Found during:** Overall verification
- **Issue:** `vitest run` (without flags) exits 1 when no test files match. The Phase 1 must-have `pnpm -w test runs (even with zero tests) and exits 0` explicitly forbids that behavior. Plan 01-00 only ships a test file for `@kos/cdk`.
- **Fix:** Added `--passWithNoTests` to `@kos/db`'s test script. `@kos/contracts` already had the flag from the plan.
- **Files modified:** packages/db/package.json
- **Verification:** `pnpm -w test` now exits 0 with `No test files found` for db+contracts and one passing test for cdk.
- **Committed in:** `4d38c05` (separate fix commit)

**6. [Rule 2 — Correctness] Preflight uses Node `>=22` instead of strict `22.x`**
- **Found during:** Task 3 (preflight definition)
- **Issue:** Plan's preflight check says `Node 22.x required`. Worktree is Node 24.11.1. A strict `v22\.` regex would fail on dev machines that are ahead of the baseline.
- **Fix:** Regex now accepts `v(22|23|24|25)\.`; the baseline is still captured in `.nvmrc=22.12.0`. Phase 1 deployment artifacts (Lambda nodejs22.x) remain pinned.
- **Files modified:** scripts/preflight.sh
- **Verification:** Preflight passes on Node 24.11.1.
- **Committed in:** `29ae5be` (Task 3 commit)

---

**Total deviations:** 6 auto-fixed (3 blocking dep fixes, 2 bug fixes, 1 env tolerance).
**Impact on plan:** Every fix was necessary to make the plan's own must-haves (`pnpm install`, `pnpm -w test`, `cdk synth`, preflight passing, CDKToolkit CREATE_COMPLETE) pass on the actual environment. No scope creep.

## Issues Encountered

None — all issues were deviation-rule-covered auto-fixes.

## CLAUDE.md Patch Proposal

`CLAUDE.md` §Supporting Libraries lists `drizzle-orm | v0.30+`. `.planning/phases/01-infrastructure-foundation/01-RESEARCH.md` requires `>=0.31` because built-in `vector()` types only ship in 0.31+. This plan pins **0.36.0**. Recommend bumping CLAUDE.md's minimum to `0.31+` (or pin to 0.36.x) so future agents don't accidentally propose 0.30.x.

## Research Assumptions Resolved

- **A9 (Transcribe sv-SE region):** `scripts/.transcribe-region = eu-north-1`. `aws transcribe list-vocabularies --region eu-north-1 --max-results 1` returned successfully on first call; no fallback to eu-west-1 was needed.

## Deferred to Operator

The environment guardrails flagged several external mutations as operator-only. Plan 01-00 did NOT execute any of these; documenting for the next plan/operator to pick up.

| Item | Why deferred | Needed by |
|------|--------------|-----------|
| SNS cost-alarm email subscription confirmation | Requires Kevin to click the confirmation link in his inbox | Plan 01-07 (SafetyStack) |
| `cdk deploy` of NetworkStack / DataStack / EventsStack / IntegrationsStack / SafetyStack | Deploys real AWS resources | Plans 01-01 through 01-07 (each plan deploys its own stack) |
| `drizzle-kit push` against live RDS | Requires RDS endpoint + credentials | Plan 01-02 (DataStack) finishes + Plan 02 migrations |
| Real Notion API writes (Entities / Projects / Legacy Inbox / Kevin Context) | Needs `NOTION_TOKEN` in env (missing in worktree) | Plan 01-04 (IntegrationsStack) |
| Azure AI Search service + index creation | Needs `az` CLI logged into the subscription (already done) + `az search` permissions | Plan 01-05 |
| SSH to VPS 98.91.6.66 | Worktree has no SSH key; preflight warns | Plan 01-07 (freeze) / Plan 10 (decommission) |

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: public-api | packages/cdk/lib/config/env.ts | `ALARM_EMAIL` ships as a hard-coded constant. Acceptable for single-user KOS but any later plan that adds contributors must move this to Secrets Manager / CDK context. |

## VPS Connectivity (Plan 07 risk input)

**VPS SSH status on 2026-04-22:** NOT REACHABLE (`permission denied, publickey` — no key configured in the worktree's environment).

Implication for Plan 01-07 (VPS freeze):
- Freeze task must either (a) run from Kevin's primary workstation where SSH keys exist, or (b) the worktree automation account needs its public key added to `authorized_keys` on `ubuntu@98.91.6.66`.
- Planner should flag this as a prerequisite / checkpoint item in Plan 01-07.

## Next Plan Readiness

**Ready to start:** Plans 01-01 (NetworkStack), 01-02 (DataStack), 01-03 (EventsStack). CDK app entry exists, bootstrap is live, env constants are importable, contracts ship the five bus names.

**Blocked on external input:** None for Plan 01-01 through 01-03. Plan 01-04 will need `NOTION_TOKEN` + `EXISTING_COMMAND_CENTER_DB_ID` set in the shell before its bootstrap Lambda runs.

## Self-Check

- [x] `.nvmrc` exists
- [x] `package.json` exists with `packageManager: pnpm@9.12.0`
- [x] `pnpm-workspace.yaml` exists
- [x] `tsconfig.base.json` exists with `strict: true`
- [x] `packages/cdk/cdk.json` exists
- [x] `packages/cdk/bin/kos.ts` imports `RESOLVED_ENV` from `../lib/config/env`
- [x] `packages/cdk/lib/config/env.ts` defines `PRIMARY_REGION='eu-north-1'`, `STOCKHOLM_TZ='Europe/Stockholm'`, `ALARM_EMAIL='kevin@tale-forge.app'`, `OWNER_ID='7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'`
- [x] `packages/db/drizzle.config.ts` exists
- [x] `packages/contracts/src/events.ts` exports five `kos.*` bus names as const
- [x] `scripts/preflight.sh` exists + executable
- [x] `scripts/.transcribe-region` exists + contains `eu-north-1`
- [x] CDKToolkit stack `CREATE_COMPLETE` in aws://239541130189/eu-north-1
- [x] Commits: `4cef320`, `d7a9990`, `cacbbd3`, `29ae5be`, `4d38c05` all present in `git log`
- [x] `pnpm -w test` exits 0
- [x] `cd packages/cdk && npx cdk synth --quiet` exits 0
- [x] `bash scripts/preflight.sh` exits 0

**## Self-Check: PASSED**

---
*Phase: 01-infrastructure-foundation*
*Plan: 00*
*Completed: 2026-04-22*
