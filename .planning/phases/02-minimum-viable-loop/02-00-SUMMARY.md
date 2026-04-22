---
phase: 02-minimum-viable-loop
plan: 00
subsystem: scaffolding
tags: [wave-0, scaffolding, workspaces, resolver, test-fixtures, tracing, secrets]
dependency_graph:
  requires:
    - packages/cdk (Phase 01 — DataStack base)
    - services/notion-indexer (Phase 01 — template)
    - pnpm-workspace.yaml (Phase 01 — workspace glob)
  provides:
    - "@kos/resolver (hybridScore + resolveStage, D-09 / D-10)"
    - "@kos/test-fixtures (mockBedrockClient, makeTelegramTextUpdate, makeTelegramVoiceUpdate, mockNotionClient)"
    - services/_shared/tracing.ts (Langfuse OTel wiring, 2s flush timeout)
    - 8 service scaffolds (telegram-bot, transcribe-starter/-complete, triage, voice-capture, entity-resolver, bulk-import-kontakter/-granola-gmail)
    - 6 Phase-2 secret shells in KosData (langfuse-*, sentry-dsn, telegram-webhook-secret, granola-api-key, gmail-oauth-tokens)
  affects:
    - All downstream Phase 2 plans (02-01 … 02-11) — workspaces now exist on disk
tech_stack:
  added:
    - "@langfuse/otel ^5"
    - "@arizeai/openinference-instrumentation-claude-agent-sdk ^0.2"
    - "@opentelemetry/sdk-trace-node ^2"
    - "@opentelemetry/instrumentation ^0.215"
    - "grammy ^1.38"
    - "googleapis ^144"
  patterns:
    - "Skeletal handler `export const handler = async (event: unknown) => ({ ok: true })`"
    - "vitest.config.ts per service with include: ['test/**/*.test.ts']"
    - "Shared tracing module at services/_shared/tracing.ts — imported via relative path by agent Lambdas (no workspace package)"
key_files:
  created:
    - packages/resolver/src/index.ts
    - packages/resolver/src/score.ts
    - packages/resolver/test/score.test.ts
    - packages/resolver/package.json
    - packages/resolver/tsconfig.json
    - packages/resolver/vitest.config.ts
    - packages/test-fixtures/src/index.ts
    - packages/test-fixtures/src/bedrock.ts
    - packages/test-fixtures/src/telegram.ts
    - packages/test-fixtures/src/notion.ts
    - packages/test-fixtures/package.json
    - packages/test-fixtures/tsconfig.json
    - packages/test-fixtures/vitest.config.ts
    - services/_shared/tracing.ts
    - services/telegram-bot/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/transcribe-starter/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/transcribe-complete/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/triage/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/voice-capture/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/entity-resolver/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/bulk-import-kontakter/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - services/bulk-import-granola-gmail/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts,test/handler.test.ts}
    - .planning/phases/02-minimum-viable-loop/deferred-items.md
  modified:
    - packages/cdk/lib/stacks/data-stack.ts (6 new Secret shells + readonly fields)
    - packages/cdk/test/data-stack.test.ts (raised count threshold 5 → 11; added Phase-2 names assertion)
    - scripts/seed-secrets.sh (added 6 new `seed_one` calls + updated header comment)
    - pnpm-lock.yaml (resolver/test-fixtures/services transitive graph)
decisions:
  - "OTel package scope is @arizeai/openinference-*, NOT @openinference/* — the plan text mentioned the wrong scope; corrected during execution (Rule 3 blocking fix)."
  - "services/_shared/ is NOT a pnpm workspace package. It's a folder whose files get imported via relative path by consumers (per Plan 02-00's 'simpler alternative')."
  - "pnpm-workspace.yaml's existing `packages/*` + `services/*` globs auto-register all new packages; no edit to the workspace file was required."
  - "Peer-dep warnings for zod 3.x vs Claude Agent SDK 4.x requirement are noted in deferred-items.md — to be addressed in a dedicated zod-upgrade plan before Plan 02-04."
metrics:
  duration_minutes: ~10
  completed: 2026-04-22
  tasks: 3
  files_created: 41
  files_modified: 4
  commits: 3
---

# Phase 2 Plan 00: Wave 0 Scaffolding Summary

Wave 0 prerequisite complete: 1 new TypeScript library (`@kos/resolver`), 1 new test-fixture package (`@kos/test-fixtures`), 8 new service scaffolds, 1 shared tracing module, and 6 new CDK secret shells. All new workspaces typecheck and their empty/trivial vitest suites pass. Wave 1+ plans are unblocked.

## Objective

Scaffold every Phase 2 workspace (1 new package, 1 new test-fixtures package, 8 new services, 1 shared tracing module) with skeletal TypeScript, vitest config, and a passing empty-test suite. Produce the test-fixture harness that downstream plans rely on.

## What Shipped

### Task 1 — `@kos/resolver` + `@kos/test-fixtures` (commit `92ff0d1`)

- **`packages/resolver/src/score.ts`** exports the D-09 hybrid scoring formula and D-10 stage router:
  - `hybridScore(trigram, cosine) = max(0.6·trigram, 0.6·cosine, 0.3·trigram + 0.7·cosine)`
  - `resolveStage(score): 'auto-merge' | 'llm-disambig' | 'inbox'` keyed on 0.95 / 0.75 thresholds
  - Inputs are clamped to [0, 1]; out-of-range throws
- **`packages/test-fixtures/src/*`** exports `mockBedrockClient` (Claude + Cohere Embed detection via `modelId.includes('cohere')`), `makeTelegramTextUpdate`, `makeTelegramVoiceUpdate`, and `mockNotionClient` (records calls, returns deterministic stub responses).
- Both packages typecheck; resolver ships with 2 placeholder tests covering the D-09 identity case and D-10 inbox threshold.

### Task 2 — 8 services + `_shared/tracing.ts` (commit `b54baa2`)

- 8 new Lambda services scaffolded with identical skeleton (handler returns `{ ok: true }`, 1-test vitest suite, TypeScript + vitest configs):
  - `telegram-bot` (CAP-01 ingress — `grammy`, `@aws-sdk/client-s3`, EventBridge, Secrets Manager, ulid, Sentry)
  - `transcribe-starter` + `transcribe-complete` (INF-08 — `@aws-sdk/client-transcribe`, EventBridge, zod, Sentry)
  - `triage` (AGT-01 — Claude Agent SDK, EventBridge, Secrets Manager, RDS Signer, pg, zod, Langfuse OTel, Sentry)
  - `voice-capture` (AGT-02 — triage deps + `@notionhq/client` + `@kos/resolver`)
  - `entity-resolver` (AGT-03 / ENT-09 — triage deps + `@notionhq/client` + `@kos/resolver`)
  - `bulk-import-kontakter` (ENT-05 — `@notionhq/client`, `@aws-sdk/client-bedrock-runtime`, zod, `@kos/resolver`, Sentry)
  - `bulk-import-granola-gmail` (ENT-06 — `googleapis`, `@notionhq/client`, zod, `@kos/resolver`, Sentry)
- **`services/_shared/tracing.ts`** — Langfuse OTel wiring with graceful degradation when secrets missing (cold-start warn + skip) and a **Promise.race against 2s timeout** inside `flush()` so a Langfuse outage can never block Lambda return. Imported via relative path by future agent services; not a workspace package (per plan's "simpler alternative").

### Task 3 — 6 CDK secret shells (commit `42b2cbc`)

- Extended `packages/cdk/lib/stacks/data-stack.ts` with 6 new `RemovalPolicy.RETAIN` placeholders:
  - `kos/langfuse-public-key`, `kos/langfuse-secret-key` (D-25)
  - `kos/sentry-dsn` (D-26)
  - `kos/telegram-webhook-secret` (CAP-01 / T-02-WEBHOOK-01 mitigation — separate from bot token)
  - `kos/granola-api-key`, `kos/gmail-oauth-tokens` (D-23 ENT-06)
- Exposed all 6 as public `readonly Secret` fields on `DataStack`.
- `scripts/seed-secrets.sh` now prompts interactively for all 6 new values (preserving the existing `read -s` + `PLACEHOLDER`-skip pattern).
- `packages/cdk/test/data-stack.test.ts` — raised total-secret threshold from 5 → 11 and added a dedicated Phase-2-names assertion. All 10 DataStack tests pass.
- `npx cdk synth KosData --quiet` succeeds.

## Verification

| Target | Status |
|--------|--------|
| `pnpm --filter @kos/resolver typecheck` | PASS |
| `pnpm --filter @kos/resolver test` (2/2) | PASS |
| `pnpm --filter @kos/test-fixtures typecheck` | PASS |
| `pnpm --filter @kos/test-fixtures test` (passWithNoTests) | PASS |
| 8 services × (typecheck + test) | PASS (1 test per service) |
| `pnpm --filter @kos/cdk typecheck` | PASS |
| `pnpm --filter @kos/cdk test -- --run data-stack` (10/10) | PASS |
| `npx cdk synth KosData --quiet` | PASS |
| All 6 new secret names present in `data-stack.ts` | PASS |
| All 6 new secret names present in `seed-secrets.sh` | PASS |
| `grep "0.3 * trigram + 0.7 * cosine"` in `score.ts` | PASS |
| `grep "LangfuseSpanProcessor"` in `_shared/tracing.ts` | PASS |
| `grep "Promise.race"` in `_shared/tracing.ts` | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected OTel package names**

- **Found during:** Task 2 first `pnpm install`
- **Issue:** Plan referenced `@openinference/instrumentation-claude-agent-sdk` and `@langfuse/otel@^3`. `@openinference/*` is not a real scope on npm; the actual publisher is `@arizeai/openinference-*`. `@langfuse/otel ^3` does not exist — latest is `5.2.0`. `@opentelemetry/sdk-node ^0.55` was replaced by `@opentelemetry/sdk-trace-node ^2` (which is what `tracing.ts` imports from anyway). `@opentelemetry/instrumentation ^0.55` is also a non-existent major; latest is `0.215.x`.
- **Fix:**
  - `services/_shared/tracing.ts` imports `from '@arizeai/openinference-instrumentation-claude-agent-sdk'` (correct scope)
  - Service `package.json`s pin `@langfuse/otel ^5`, `@arizeai/openinference-instrumentation-claude-agent-sdk ^0.2`, `@opentelemetry/sdk-trace-node ^2`, `@opentelemetry/instrumentation ^0.215`
  - Dropped `@opentelemetry/sdk-node` (not used by `tracing.ts`)
- **Files modified:** `services/_shared/tracing.ts`, `services/triage/package.json`, `services/voice-capture/package.json`, `services/entity-resolver/package.json`
- **Commit:** `b54baa2`
- **Rule rationale:** Rule 3 (blocking — `pnpm install` errored, preventing Task 2 completion).

## Authentication Gates

None encountered. All scaffolding is local (git + pnpm + vitest); no cloud credentials required.

## Deferred Issues

See `.planning/phases/02-minimum-viable-loop/deferred-items.md` for full detail.

- **Pre-existing test failure in `services/transcribe-vocab-deploy`** (Phase 01 scope — out of scope for Wave 0 scaffolding). The test expects `s3://kos-blobs-bucket/vocab/...` but the handler was changed in Phase 01 commit `1c009f3` to emit `s3://cdk-asset-bucket/vocab-cleaned/...` without updating the fixture.
- **Peer-dep warning for zod:** `@anthropic-ai/claude-agent-sdk@0.2.117` wants zod 4.x, but the monorepo is locked at 3.23.8. Typecheck and unit tests still pass — real Claude Agent SDK calls land in Plan 02-04, which must either upgrade zod or pin the SDK to an older release.

## Threat-Register Coverage

- **T-02-SCAFFOLD-01 (Tampering — resolver scoring formula):** mitigated. Unit test in `packages/resolver/test/score.test.ts` asserts `hybridScore(0, 0) === 0` and `resolveStage(0.5) === 'inbox'`. More comprehensive fixture + property tests land in Plan 02-03.
- **T-02-SECRETS-01 (Information Disclosure — empty secret shells):** mitigated. All 6 new CDK Secrets are created with placeholder-only values + `RemovalPolicy.RETAIN`; real values flow in via `scripts/seed-secrets.sh` (TTY `read -s`; no file artifacts).

## Handoffs to Wave 1+

All Phase-2 downstream plans can now start because their workspaces exist, typecheck cleanly, and shared fixtures + resolver scoring library are importable:

| Consumer plan | Imports / depends on |
|---------------|----------------------|
| 02-01+ telegram-bot (CAP-01) | `@kos/contracts` + `@kos/test-fixtures` |
| 02-02 transcribe-starter/-complete (INF-08) | `@kos/contracts` + `@kos/test-fixtures` |
| 02-04 triage (AGT-01) | `@kos/test-fixtures` + `@kos/db` + `services/_shared/tracing.ts` |
| 02-05 voice-capture (AGT-02) | `@kos/resolver` + `@kos/test-fixtures` + tracing |
| 02-06 entity-resolver (AGT-03 / ENT-09) | `@kos/resolver` + `@kos/test-fixtures` + tracing |
| 02-07+ bulk-import-kontakter (ENT-05) | `@kos/resolver` + `@kos/test-fixtures` |
| 02-08+ bulk-import-granola-gmail (ENT-06) | `@kos/resolver` + `@kos/test-fixtures` |

## Commits

| Hash | Message |
|------|---------|
| `92ff0d1` | feat(02-00): scaffold @kos/resolver + @kos/test-fixtures packages |
| `b54baa2` | feat(02-00): scaffold 8 Phase 2 services + _shared/tracing.ts |
| `42b2cbc` | feat(02-00): add 6 Phase-2 secret shells to DataStack |

## Self-Check: PASSED

All 19 claimed files verified present on disk; all 3 claimed commits (`92ff0d1`, `b54baa2`, `42b2cbc`) verified in `git log --all`.
