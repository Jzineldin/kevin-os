---
phase: 06-granola-semantic-memory
plan: 07
subsystem: agents
tags:
  - phase-6-gap
  - agt-04
  - azure-search
  - context-loader
  - gap-closure
mode: gap_closure
gap_target: AGT-04 PARTIAL → VERIFIED
status: complete
requirements:
  - AGT-04
dependency_graph:
  requires:
    - "@kos/azure-search::hybridQuery (Plan 06-03)"
    - "@kos/context-loader::loadContext (Plan 06-05) with optional azureSearch param"
    - "DataStack.azureSearchAdminSecret (Plan 02 / 06-03)"
  provides:
    - "Azure semantic chunk injection on every loadContext call across 4 consumer Lambdas"
    - "AgentsWiringProps.azureSearchAdminSecret + azureSearchIndexName CDK contract"
  affects:
    - "services/triage, services/voice-capture, services/entity-resolver, services/transcript-extractor"
    - "packages/cdk/lib/stacks/integrations-agents.ts, agents-stack.ts, bin/kos.ts"
tech_stack:
  added: []
  patterns:
    - "Dependency injection (azureSearch callable) preserves loadContext as a stringly-decoupled module — no circular import between @kos/context-loader and @kos/azure-search"
    - "Conditional CDK env spread (`...(p.azureSearchAdminSecret ? { ... } : {})`) keeps backward-compat for fixtures pre-dating the gap closure"
    - "Static-analysis test pattern (fs.readFileSync + regex on handler.ts) catches wiring drift without requiring full Lambda runtime mocking"
key_files:
  created:
    - "services/triage/test/loadcontext-wiring.test.ts"
    - "services/voice-capture/test/loadcontext-wiring.test.ts"
    - "services/entity-resolver/test/loadcontext-wiring.test.ts"
    - "services/transcript-extractor/test/loadcontext-wiring.test.ts"
    - "packages/cdk/test/integrations-agents.test.ts"
  modified:
    - "services/triage/src/handler.ts"
    - "services/triage/package.json"
    - "services/voice-capture/src/handler.ts"
    - "services/voice-capture/package.json"
    - "services/entity-resolver/src/handler.ts"
    - "services/entity-resolver/package.json"
    - "services/transcript-extractor/src/handler.ts"
    - "services/transcript-extractor/package.json"
    - "packages/cdk/lib/stacks/integrations-agents.ts"
    - "packages/cdk/lib/stacks/agents-stack.ts"
    - "packages/cdk/bin/kos.ts"
    - "packages/azure-search/src/client.ts"
    - ".planning/phases/06-granola-semantic-memory/06-VERIFICATION.md"
decisions:
  - "Project HybridQueryResult.hits (NOT .results) when wrapping hybridQuery — VERIFICATION.md prose used the wrong field name; the shipped contract is `hits`. Static-analysis tests guard against the typo regression."
  - "Made azureSearchAdminSecret prop optional on AgentsWiringProps + AgentsStackProps for backward-compat with pre-gap-closure test fixtures. Lambdas synth without the env var when prop is absent and degrade to empty semanticChunks (matches pre-gap behaviour)."
  - "[Rule 3] Fixed pre-existing SearchClient<T> generic constraint in packages/azure-search/src/client.ts (T must extend object per @azure/search-documents v12.2 type signature). Issue surfaced only when consumer services typecheck-imported @kos/azure-search; transparent at runtime."
metrics:
  duration: "~15 minutes (875s wall clock)"
  completed_date: "2026-04-25"
  tasks: 3
  files_modified: 13
  files_created: 5
  commits: 4
---

# Phase 6 Plan 07: AGT-04 Azure Search wiring gap closure Summary

Closed the AGT-04 PARTIAL gap from `06-VERIFICATION.md` by injecting `hybridQuery` from `@kos/azure-search` as the `azureSearch` callable into `loadContext()` in all 4 consumer Lambdas (triage, voice-capture, entity-resolver, transcript-extractor), and threading `AZURE_SEARCH_ADMIN_SECRET_ARN` + Cohere v4 EU + secret-read IAM grants through CDK.

## Outcome

- Status: **complete**
- Gate verifier: `node scripts/verify-phase-6-gate.mjs --mock` exits 0; SC4 now reads "Code wired in 4 consumer Lambda(s)"
- 4 service test suites green; 4 wiring tests added and passing; 1 CDK assertion test added and passing
- VERIFICATION.md flipped: `status: gaps_found` → `verified`; 6/7 → 7/7 truths; AGT-04 row PARTIAL → VERIFIED; data-flow trace HOLLOW_PROP → FLOWING

## Commits

| Hash | Message |
| ---- | ------- |
| dc4c75f | test(06-07): add failing AGT-04 loadContext azureSearch wiring tests |
| a4ff7fb | feat(06-07): wire hybridQuery into 4 consumer Lambdas (AGT-04 gap closure) |
| 62b03b4 | feat(06-07): CDK env vars + IAM grants for AGT-04 Azure Search wiring |
| (this commit) | docs(06-07): VERIFICATION.md AGT-04 closure markers + plan summary |

## Verification Evidence

| Check | Command | Result |
| ----- | ------- | ------ |
| Triage tests | `pnpm --filter @kos/service-triage test` | 6/6 pass (incl. 3 new wiring tests) |
| Voice-capture tests | `pnpm --filter @kos/service-voice-capture test` | 5/5 pass |
| Entity-resolver tests | `pnpm --filter @kos/service-entity-resolver test` | 11/11 pass |
| Transcript-extractor tests | `pnpm --filter @kos/service-transcript-extractor test` | 21/21 pass |
| Triage typecheck | `pnpm --filter @kos/service-triage typecheck` | exit 0 |
| Voice-capture typecheck | `pnpm --filter @kos/service-voice-capture typecheck` | exit 0 |
| Entity-resolver typecheck | `pnpm --filter @kos/service-entity-resolver typecheck` | exit 0 |
| Transcript-extractor typecheck | `pnpm --filter @kos/service-transcript-extractor typecheck` | exit 0 |
| CDK typecheck | `pnpm --filter @kos/cdk typecheck` | exit 0 |
| CDK AGT-04 test | `pnpm exec vitest run test/integrations-agents.test.ts` (in packages/cdk with PATH including esbuild) | 2/2 pass |
| CDK regression (agents-stack) | `pnpm exec vitest run test/agents-stack.test.ts` | 16/16 pass |
| CDK regression (app) | `pnpm exec vitest run test/app.test.ts` | 1/1 pass |
| Azure-search regression | `pnpm --filter @kos/azure-search test` | 19/19 pass |
| Phase 6 gate verifier | `node scripts/verify-phase-6-gate.mjs --mock` | exit 0; 7 PASS-auto, 5 HUMAN-pending |

### Static grep audit
- `grep -l "from '@kos/azure-search'" services/{triage,voice-capture,entity-resolver,transcript-extractor}/src/handler.ts` → 4 paths returned
- `grep -c "azureSearch:" services/{triage,voice-capture,entity-resolver,transcript-extractor}/src/handler.ts` → 1 each
- `grep -c '"@kos/azure-search"' services/*/package.json` → 1 each (4 total)
- `grep -c "AZURE_SEARCH_ADMIN_SECRET_ARN" packages/cdk/lib/stacks/integrations-agents.ts` → 5 (≥4 required)
- `grep -c "Plan 06-07" .planning/phases/06-granola-semantic-memory/06-VERIFICATION.md` → 9 (≥3 required)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocker] SearchClient<T> generic constraint in packages/azure-search/src/client.ts**
- **Found during:** Task 1 GREEN typecheck (after wiring `import { hybridQuery } from '@kos/azure-search'` in 4 consumer services)
- **Issue:** `@azure/search-documents` v12.2 declares `class SearchClient<TModel extends object>`. The shipped client.ts had `SearchClient<unknown>` (cache type) and `<T = unknown>` default — both violated the constraint and produced TS2344 errors when consumer services pulled the package in via the new import edge. The errors did not appear before because no typecheck path traversed `client.ts` from a strict consumer.
- **Fix:** Constrained the generic to `T extends object = AnyDoc` (where `AnyDoc = Record<string, unknown>`), and changed the cache map type from `SearchClient<unknown>` to `SearchClient<AnyDoc>`. Runtime behaviour unchanged; only the types were tightened.
- **Files modified:** `packages/azure-search/src/client.ts`
- **Commit:** a4ff7fb (folded into the Task 1 GREEN commit since the fix was directly required by the new consumer typecheck path)

### Process Notes

**CDK test environment:** The repository's CDK test suite requires `esbuild` to be on PATH at test time (it shells out to `pnpm exec -- esbuild` for Lambda bundle synthesis). The default invocation `pnpm --filter @kos/cdk test` does not surface the binary, so the existing `agents-stack.test.ts` ALSO fails the same way without the workaround. Both tests pass via:
```bash
cd packages/cdk && PATH="/home/ubuntu/projects/kevin-os/node_modules/.pnpm/node_modules/.bin:$PATH" pnpm exec vitest run test/...
```
This is a pre-existing infra issue (out of scope for this plan); documented here for downstream verifier convenience. The CDK typecheck passes cleanly without any workaround, confirming the integration shape is sound.

## Authentication Gates

None. The wiring is purely code + IAM declaration; no live auth or secret materialization happened during execution.

## Threat Flags

None. Threat register entries T-06-AGT04-01 through T-06-AGT04-04 were addressed exactly as planned:
- IAM scoped via `secret.grantRead(fn)` (NOT `Resource: '*'`)
- Bedrock InvokeModel scoped to `eu.cohere.embed-v4*` ARN patterns (NOT `Resource: '*'`)
- T-06-AGT04-03 (OData injection) ACCEPT — covered by Plan 06-08 IN-01 (already shipped)
- T-06-AGT04-04 (DoS via Cohere on every call) ACCEPT — gated by loadContext's existing `partial: true` fallback

## Self-Check: PASSED

Verified post-write:

**Files exist:**
- `services/triage/test/loadcontext-wiring.test.ts` — FOUND
- `services/voice-capture/test/loadcontext-wiring.test.ts` — FOUND
- `services/entity-resolver/test/loadcontext-wiring.test.ts` — FOUND
- `services/transcript-extractor/test/loadcontext-wiring.test.ts` — FOUND
- `packages/cdk/test/integrations-agents.test.ts` — FOUND

**Commits exist (in `git log --oneline`):**
- `dc4c75f` — FOUND
- `a4ff7fb` — FOUND
- `62b03b4` — FOUND

**Plan acceptance criteria:** all met (see Verification Evidence table above).
