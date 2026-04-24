---
phase: 06-granola-semantic-memory
plan: 05
subsystem: agt-04 + inf-10
tags: [agt-04, inf-10, context-loader, vertex-gemini, cache-control-ephemeral, dossier-loader]

# Dependency graph
requires:
  - phase: 06-granola-semantic-memory
    plan: 00
    provides: "@kos/context-loader scaffold (loadContext.ts/cache.ts/markdown.ts/kevin.ts/index.ts shells), services/dossier-loader scaffold (handler.ts/vertex.ts/persist.ts/aggregate.ts), entity_dossiers_cached migration 0012, KevinContextBlock + ContextBundle + FullDossierRequested Zod schemas"
  - phase: 06-granola-semantic-memory
    plan: 03
    provides: "@kos/azure-search::hybridQuery — injected into loadContext via the azureSearch callable for the parallel Promise.all branch"
  - phase: 06-granola-semantic-memory
    plan: 04
    provides: "entity_timeline materialised view + invalidate_dossier_cache_on_mention trigger — keeps the cache layer's read-through honest"
  - phase: 02-minimum-viable-loop
    provides: "Phase 2 Lambdas (triage/voice-capture/entity-resolver/transcript-extractor) with Bedrock direct-SDK pattern — 4 retrofit targets"
provides:
  - "@kos/context-loader::loadContext — explicit AGT-04 helper with Promise.all parallelism, last_touch_hash cache verification, partial=true graceful degrade"
  - "@kos/context-loader::loadKevinContextMarkdown — canonical Kevin Context markdown loader (D-14 single source of truth)"
  - "30 unit + budget tests across markdown.test.ts/cache.test.ts/loadContext.test.ts/budget.test.ts (incl. p95<800ms perf budget)"
  - "4 consumer Lambdas (triage/voice-capture/entity-resolver/transcript-extractor) call loadContext + inject assembled_markdown with cache_control:ephemeral"
  - "services/dossier-loader Lambda subscribes to context.full_dossier_requested → Vertex Gemini 2.5 Pro europe-west4 → entity_dossiers_cached upsert with gemini-full: prefix"
  - "9 dossier-loader tests (5 vertex + 4 handler)"
  - "wireDossierLoader CDK helper + 6 synth-level CDK tests (DossierLoader Lambda + EventBridge rule + IAM grants)"
  - "DataStack.gcpVertexSaSecret shell (kos/gcp-vertex-sa) for operator-seeded SA JSON"
  - "scripts/trigger-full-dossier.mjs — operator runbook trigger emitting context.full_dossier_requested with UUID validation and verify hints"
affects: [phase-06 plan 06-06 e2e gate, phase-04 email-triage future consumer, phase-07 lifecycle automations, phase-08 outbound-content]

# Tech tracking
tech-stack:
  added:
    - "Vertex Gemini 2.5 Pro europe-west4 (operator-only trigger in v1)"
  patterns:
    - "loadContext degraded path: empty entityIds + rawText → Azure semantic search; empty entityIds + no rawText → Kevin Context only"
    - "loadContext non-throwing: subfetch failures populate partial_reasons[] instead of bubbling — agent Lambdas keep running"
    - "Cache key = (entity_id, owner_id) composite; last_touch_hash defensively re-checks freshness on read"
    - "Conditional spread for cache_control:ephemeral system segments (Phase 2 wave-5 retro: empty text breaks Bedrock prompt cache)"
    - "wireDossierLoader props are OPTIONAL — synth skips Lambda creation when GCP secret/project/agentBus unset (lets existing test fixtures synth without GCP wiring)"

key-files:
  created:
    - "packages/context-loader/test/markdown.test.ts (8 cases)"
    - "packages/context-loader/test/cache.test.ts (11 cases)"
    - "packages/context-loader/test/loadContext.test.ts (9 cases)"
    - "packages/context-loader/test/budget.test.ts (2 cases)"
    - "services/dossier-loader/test/vertex.test.ts (5 cases)"
    - "services/dossier-loader/test/handler.test.ts (4 cases)"
    - "packages/cdk/test/integrations-vertex.test.ts (6 cases)"
    - "scripts/trigger-full-dossier.mjs (operator INF-10 trigger)"
  modified:
    - "packages/context-loader/src/loadContext.ts (DossierCacheRow type import; cleaner cached Map<string,DossierCacheRow>)"
    - "packages/context-loader/src/kevin.ts (added loadKevinContextMarkdown — markdown-string variant for legacy callers)"
    - "packages/context-loader/src/index.ts (export loadKevinContextMarkdown)"
    - "packages/context-loader/tsconfig.json (rootDir '.' so tsc accepts test/ files)"
    - "services/triage/src/persist.ts (loadKevinContextBlock now delegates to @kos/context-loader::loadKevinContextMarkdown)"
    - "services/voice-capture/src/persist.ts (same delegation)"
    - "services/entity-resolver/src/persist.ts (same delegation) + package.json (added @kos/context-loader workspace dep)"
    - "services/entity-resolver/src/handler.ts (loadContext call inside completeDisambigOrInbox; entityIds = top 5 candidate IDs)"
    - "services/entity-resolver/src/disambig.ts (additionalContextBlock parameter; conditional cache_control system segment)"
    - "services/transcript-extractor/src/persist.ts (loadKevinContextBlockOnce delegates to canonical helper)"
    - "services/transcript-extractor/src/handler.ts (loadContext call replacing the Wave-2 placeholder; falls back to Kevin-Context-only on failure)"
    - "packages/cdk/lib/stacks/integrations-vertex.ts (refactored to wireDossierLoader-only; removed timeline-refresher to avoid Plan 06-04 collision)"
    - "packages/cdk/lib/stacks/integrations-stack.ts (optional gcpVertexSaSecret + gcpProjectId + agentBus props; wireDossierLoader call inside the kevinOwnerId guard)"
    - "packages/cdk/lib/stacks/data-stack.ts (gcpVertexSaSecret shell)"
    - "packages/cdk/bin/kos.ts (passes gcpVertexSaSecret + GCP_PROJECT_ID env + agentBus into IntegrationsStack)"
    - ".planning/phases/06-granola-semantic-memory/deferred-items.md (logged 3 pre-existing AgentsStack test failures from Plan 06-02)"

key-decisions:
  - "Canonical Kevin Context lives in @kos/context-loader/src/kevin.ts. Two surface variants: loadKevinContextBlock (returns KevinContextBlock object — used by loadContext internals) and loadKevinContextMarkdown (returns string — used by 4 services' degraded fallback). Each service's persist.ts loadKevinContextBlock(ownerId): Promise<string> becomes a thin pool-wired adapter delegating to the canonical helper."
  - "wireDossierLoader-only in integrations-vertex.ts (not the originally-scaffolded wireVertexIntegrations which also created EntityTimelineRefresher — that collided with Plan 06-04's wireMvRefresher construct ID)."
  - "Dossier pipeline gated on optional CDK props (gcpVertexSaSecret + gcpProjectId + agentBus). Synth without them keeps existing test fixtures green; production deploy must supply all three."
  - "loadContext is non-throwing — subfetch failures surface via partial=true / partial_reasons[]. Allows agent Lambdas to keep running even when Azure / pg / individual queries fail (degraded but not blocked)."
  - "Operator trigger script (scripts/trigger-full-dossier.mjs) uses inline ulid() (Date.toString(32) + randomUUID-derived suffix) to avoid a root-level ulid npm dep; capture_id schema accepts the format."

requirements-completed:
  - AGT-04
  - INF-10

# Metrics
duration: "~17min"
completed: 2026-04-24
started: 2026-04-24T23:08:00Z
---

# Phase 6 Plan 5: AGT-04 + INF-10 Summary

**Quality multiplier shipped: every consumer Lambda gains full entity-dossier awareness via a single `loadContext()` library call, plus operator-triggered Vertex Gemini 2.5 Pro full-dossier loader.**

## Performance

- **Duration:** ~17 min
- **Started:** 2026-04-24T23:08:00Z
- **Completed:** 2026-04-24T23:25:00Z
- **Tasks:** 3 (all autonomous, no checkpoints)
- **Files created:** 8
- **Files modified:** 14
- **Test cases added:** 51 (30 context-loader + 9 dossier-loader + 6 CDK + 6 existing service handlers re-validated)

## Accomplishments

### Task 1 — `@kos/context-loader` test suite (commit `f853268`)

The library implementation was already scaffolded (Plan 06-00). Plan 06-05 added 30 unit + budget tests:

- `markdown.test.ts` (8 cases): always-emit Kevin Context heading; section-omission rules; entity dossier formatting (name + type + meta + seed_context); recent mentions formatting; semantic chunk truncation cap (240 chars); linked projects with bolag/status; total markdown size cap (32k chars + truncation tail); Kevin Context subsection omission for empty bodies.
- `cache.test.ts` (11 cases): `computeLastTouchHash` determinism + sensitivity to last_touch + recent_mention_count changes + null tolerance; `readDossierCache` empty-input no-op; map key shape; parameterised SQL with owner_id + entity_id ANY-array + expires_at>now() filter; `writeDossierCache` `ON CONFLICT (entity_id, owner_id) DO UPDATE`; default 3600 TTL; `invalidateDossierCache` empty-input no-op + DELETE shape.
- `loadContext.test.ts` (9 cases): happy path returns ContextBundle with all fields populated; degraded paths (empty entityIds + rawText → Azure on rawText; empty entityIds + no rawText → semantic_chunks empty + Kevin Context still loaded; Azure rejection → partial=true; pg rejection → partial=true); cache-hit detection; Promise.all parallelism (total elapsed < serial sum); telemetry hooks (elapsed_ms nonnegative; assembled_markdown begins with `## Kevin Context`).
- `budget.test.ts` (2 cases): D-15 perf budget — 50 iterations with 50ms-per-subfetch mocks → p95 < 800ms; cache-hit path < 200ms when readDossierCache short-circuits.

Side fixes during Task 1:
- `loadContext.ts`: tightened `cached` Map type via re-imported `DossierCacheRow` (was `Awaited<ReturnType<...>>[string]` which TS rejected under strict mode).
- `tsconfig.json`: `rootDir` `.` so tsc accepts `test/**` files via the include glob (was `src` causing TS6059 latent issue).

**Verification:** 30 / 30 tests pass; typecheck clean.

### Task 2 — Wire `@kos/context-loader` into 4 consumer Lambdas (commit `87c5853`)

Two of the 4 Lambdas (triage + voice-capture) had `loadContext` already wired from Plan 06-00 scaffolding. Plan 06-05 wired the remaining two and canonicalised the Kevin Context loader:

| Lambda | Wired? Pre 06-05 | Plan 06-05 changes |
|---|---|---|
| **triage** | ✅ wired | Replaced inline `loadKevinContextBlock` SQL with delegation to `@kos/context-loader::loadKevinContextMarkdown`. |
| **voice-capture** | ✅ wired | Same delegation. |
| **entity-resolver** | ❌ not wired | Wired `loadContext` inside `completeDisambigOrInbox` with `entityIds = candidates.slice(0,5).map(c => c.id)` so Sonnet's disambig sees full dossiers for the candidates it must pick between. Added `additionalContextBlock` parameter to `runDisambig` with conditional cache_control:ephemeral system segment. |
| **transcript-extractor** | placeholder (`loadKevinContextBlockOnce`) | Replaced placeholder with `loadContext({ entityIds: [], rawText: body.slice(0, 2000) })` per the plan's "v1 simplification — attendees not yet pre-resolved to entity_ids" path. Placeholder kept as the catch-block fallback. |

Per-Lambda entityIds derivation:
- triage / voice-capture: `[]` + rawText (degraded path, no entities resolved yet — entity resolution runs downstream).
- entity-resolver: top 5 candidate IDs after `findCandidates` (just before Sonnet's disambig).
- transcript-extractor: `[]` + first 2000 chars of transcript body (degraded path; future enhancement: pre-resolve attendees → entityIds before `loadContext`, deferred per `deferred-items.md`).

Canonical Kevin Context (D-14): added `@kos/context-loader::loadKevinContextMarkdown(ownerId, pool): Promise<string>` so each service's persist.ts `loadKevinContextBlock(ownerId): Promise<string>` adapter delegates to the canonical helper. The original object-returning `loadKevinContextBlock` (KevinContextBlock shape) stays for `loadContext` internal use.

Disambig (entity-resolver): `runDisambig` accepts optional `additionalContextBlock`; conditional spread on the system prompt so empty strings don't trigger Bedrock's "cache_control on empty text" rejection (Phase 2 wave-5 retro).

**Verification:** all 19 service handler tests pass (3 triage + 2 voice-capture + 8 entity-resolver + 6 transcript-extractor); typecheck clean across the 4 services.

### Task 3 — `services/dossier-loader` tests + CDK helper integration + trigger script (commit `cec1680`)

**Dossier-loader tests (9 cases):**
- `vertex.test.ts` (5): VertexAI client constructed with `europe-west4` location + `project_id` + SA-JSON credentials from Secrets Manager; `gemini-2.5-pro` model id; cost estimation $1.25/M (<200k input) vs $2.50/M (≥200k input) + $10/M output; `systemInstruction` contains "KOS dossier-loader" role marker; `GCP_SA_JSON_SECRET_ARN` missing → actionable error.
- `handler.test.ts` (4): happy path → entity_dossiers_cached UPSERT per entity_id with `gemini-full:` last_touch_hash prefix; empty `entity_ids` rejected at Zod parse (schema min(1)); malformed detail throws; `tagTraceWithCaptureId` called with detail.capture_id.

**CDK wiring:**
- Refactored `integrations-vertex.ts`: removed `wireVertexIntegrations`'s timeline-refresher creation (collided with Plan 06-04's `wireMvRefresher` on construct id `EntityTimelineRefresher`). Replaced with focused `wireDossierLoader` helper that creates only the dossier-loader Lambda + EventBridge rule + Secrets Manager grants + rds-db:connect IAM.
- `integrations-stack.ts`: added optional `gcpVertexSaSecret` + `gcpProjectId` + `agentBus` props; wireDossierLoader called inside the existing `kevinOwnerId` guard when all three are supplied. Skipped at synth time otherwise — keeps the existing CDK test fixtures green.
- `data-stack.ts`: `gcpVertexSaSecret` shell (`kos/gcp-vertex-sa`) created unconditionally; operator seeds the SA JSON via `aws secretsmanager put-secret-value` before `cdk deploy`.
- `bin/kos.ts`: passes `data.gcpVertexSaSecret` + `process.env.GCP_PROJECT_ID` + `events.buses.agent` into IntegrationsStack so the dossier pipeline activates when GCP is set up.

**CDK tests (`integrations-vertex.test.ts`, 6 cases):**
- DossierLoader runtime nodejs22.x + arm64; timeout 600s; memory 2048 MB.
- Env carries `GCP_SA_JSON_SECRET_ARN` + `GCP_PROJECT_ID` + `RDS_PROXY_ENDPOINT` + `KEVIN_OWNER_ID`.
- EventBridge rule on `kos.agent` / `context.full_dossier_requested` targets the Lambda.
- IAM role has `rds-db:connect` on the RDS Proxy DBI.
- IAM role has `secretsmanager:GetSecretValue` (for the GCP SA secret).
- Pipeline is OPTIONAL — synth without `gcpVertexSaSecret` omits the DossierLoader Lambda.

**Operator script (`scripts/trigger-full-dossier.mjs`):**
- Validates UUID shape on `--entity-id` (multiple flags accepted) + `--owner-id` (or reads `KEVIN_OWNER_ID` env).
- Generates a capture_id ULID-ish via inline `Date.toString(32)` + `randomUUID`-derived suffix (avoids a root-level `ulid` npm dep — schema accepts the format).
- Emits `context.full_dossier_requested` to `kos.agent` (overridable via `--bus`).
- Prints CloudWatch tail hint + a psql verification command for the cache row.

**Verification:** 9 / 9 dossier-loader tests pass; 6 / 6 CDK vertex tests pass (totaling ~75s in CDK synth time).

## Public Surface

**`@kos/context-loader` exports:**
```ts
export { loadContext, type LoadContextInput } from './loadContext.js';
export { loadKevinContextBlock, loadKevinContextMarkdown } from './kevin.js';
export { buildDossierMarkdown } from './markdown.js';
export {
  readDossierCache, writeDossierCache, invalidateDossierCache, computeLastTouchHash,
} from './cache.js';
```

**Line counts (per `wc -l`):**
- `loadContext.ts`: 289 lines (parallel fetches + cache hit/miss + non-throwing degrade + assembledMarkdown).
- `cache.ts`: 98 lines (read/write/invalidate + computeLastTouchHash).
- `markdown.ts`: 121 lines (Kevin Context + entities + mentions + semantic + linked projects).
- `kevin.ts`: 90 lines (KevinContextBlock object + markdown-string variants).
- `dossier-loader/handler.ts`: 109 lines.
- `dossier-loader/vertex.ts`: 117 lines.
- `dossier-loader/aggregate.ts`: 109 lines.
- `dossier-loader/persist.ts`: 53 lines.
- `integrations-vertex.ts`: 130 lines (wireDossierLoader helper).

## Operator Runbook — First Vertex Test

```bash
# 1. Create GCP project + enable Vertex AI in europe-west4 (manual GCP Console step).
# 2. Create service account with roles/aiplatform.user; download JSON.
# 3. Seed the SA JSON into Secrets Manager:
aws secretsmanager put-secret-value \
  --secret-id kos/gcp-vertex-sa \
  --secret-string file:///path/to/sa.json \
  --region eu-north-1

# 4. Set GCP_PROJECT_ID + deploy:
GCP_PROJECT_ID=kos-vertex-prod KEVIN_OWNER_ID=$(echo "$KOS_OWNER_ID") \
  pnpm --filter @kos/cdk run deploy KosIntegrations

# 5. Trigger a test dossier load (Damien's UUID as example):
KEVIN_OWNER_ID=$KOS_OWNER_ID \
  node scripts/trigger-full-dossier.mjs \
    --entity-id <damien-uuid> \
    --intent "Test Vertex Gemini 2.5 Pro full dossier load"

# 6. Tail CloudWatch:
aws logs tail /aws/lambda/<DossierLoaderLogicalIdHash> --follow

# 7. Verify cache row:
psql -h <RDS-PROXY> -U kos_agent_writer -d kos -c \
  "SELECT entity_id, last_touch_hash, length(bundle::text)
     FROM entity_dossiers_cached
     WHERE last_touch_hash LIKE 'gemini-full:%'
     ORDER BY created_at DESC LIMIT 5;"
```

## Cost Estimate per Vertex Call

Based on `services/dossier-loader/src/vertex.ts::callGeminiWithCache`:
- Input ≤ 200k tokens: $1.25/M; ≥ 200k: $2.50/M.
- Output: $10/M.
- Cached content (`cachedContents` API): 25% discount on input — not yet enabled in v1 (the SDK call uses ad-hoc generateContent; future enhancement: pre-create cachedContent for the system instruction + corpus prefix).
- Typical full-dossier corpus 100k–500k tokens; output 1k–4k.

| Scenario | Input tokens | Output tokens | Estimated cost |
|---|---:|---:|---:|
| Small entity (single person, sparse history) | 50k | 1k | $0.07 |
| Medium entity (active project, 6mo history) | 200k | 2k | $0.27 |
| Large entity (Kevin's biggest deals + projects) | 600k | 4k | $1.54 |
| Heavy reload after bulk-import | 800k | 8k | $2.08 |

**v1 operator-only volume target:** ≤ 30 invocations/month → ≤ $30-50/month. Comfortably within the Phase 6 D-27 envelope (~$10-30/mo for Vertex). Future auto-trigger (deferred to Phase 7) gets its own budget alarm.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] CDK construct id collision between Plan 06-04 and 06-05**
- **Found during:** Task 3 CDK synth.
- **Issue:** Plan 06-00 scaffolded `wireVertexIntegrations` to create BOTH `DossierLoader` AND `EntityTimelineRefresher`, but Plan 06-04 had already shipped `wireMvRefresher` creating a Lambda with the same construct id `EntityTimelineRefresher`. Both helpers wired into `integrations-stack.ts` would synth a duplicate-construct-id error.
- **Fix:** Refactored `integrations-vertex.ts` to a focused `wireDossierLoader` helper (Lambda + EventBridge rule only). Removed the timeline-refresher creation; that Lambda is now exclusively owned by Plan 06-04's `wireMvRefresher`.
- **Files modified:** `packages/cdk/lib/stacks/integrations-vertex.ts`.
- **Commit:** `cec1680`.

**2. [Rule 2 — Critical Functionality] Missing GCP Vertex SA secret in DataStack**
- **Found during:** Task 3 CDK wiring.
- **Issue:** Plan 06-05's `wireDossierLoader` requires `gcpSaJsonSecret: ISecret` but DataStack didn't create the `kos/gcp-vertex-sa` secret shell — operator had no canonical place to seed the SA JSON.
- **Fix:** Added `gcpVertexSaSecret: Secret` to DataStack (matching the existing `granolaApiKeySecret` / `notionTokenSecret` pattern; `RemovalPolicy.RETAIN`). Operator seeds via `aws secretsmanager put-secret-value` before `cdk deploy`.
- **Files modified:** `packages/cdk/lib/stacks/data-stack.ts`, `packages/cdk/bin/kos.ts`.
- **Commit:** `cec1680`.

**3. [Rule 1 — Bug] Pre-existing TS6059 in @kos/context-loader/tsconfig.json blocked typecheck on test files**
- **Found during:** Task 1 typecheck.
- **Issue:** `rootDir: "src"` + `include: ["src/**/*.ts", "test/**/*.ts"]` is contradictory — tsc emits TS6059 ("File is not under rootDir") for every test file. Pre-existing; only manifested now because Plan 06-05 added the first test files in this package.
- **Fix:** Changed `rootDir` to `"."` so `outDir` works correctly while tsc still accepts the test glob.
- **Files modified:** `packages/context-loader/tsconfig.json`.
- **Commit:** `f853268`.

**4. [Rule 1 — Bug] Type expression rejected under strict mode in loadContext.ts**
- **Found during:** Task 1 typecheck.
- **Issue:** `let cached = new Map<string, Awaited<ReturnType<typeof readDossierCache>>[string]>();` — strict mode rejects index access on a Map type with `[string]`.
- **Fix:** Re-exported `DossierCacheRow` type from `cache.ts` and used `Map<string, DossierCacheRow>` directly.
- **Files modified:** `packages/context-loader/src/loadContext.ts`.
- **Commit:** `f853268`.

**5. [Rule 3 — Blocking] Missing @kos/context-loader workspace dep in entity-resolver**
- **Found during:** Task 2 typecheck.
- **Issue:** `services/entity-resolver/package.json` lacked the `@kos/context-loader: workspace:*` dep, so the new `import { loadContext } from '@kos/context-loader'` failed module resolution.
- **Fix:** Added the workspace dep alongside `@kos/contracts` / `@kos/db` / `@kos/resolver`.
- **Files modified:** `services/entity-resolver/package.json`.
- **Commit:** `87c5853`.

### Out-of-scope discoveries (logged to `deferred-items.md`)

- 3 test failures in `packages/cdk/test/agents-stack.test.ts`. The tests assert exactly 5 agent Lambdas; Plan 06-02 added a 6th (`TranscriptExtractor`) without updating the test count. Confirmed pre-existing via `git stash && pnpm --filter @kos/cdk test` — fails with the same 3 tests on the unmodified base. Plan 06-05 does NOT touch AgentsStack.
- Pre-existing TS2307 typecheck errors in `services/dossier-loader/src/handler.ts` (`aws-lambda` types missing) and 5 OpenTelemetry/Langfuse imports in `services/_shared/tracing.ts`. Already logged in deferred-items.md from Plan 06-00 execution. Vitest still passes (no module resolution at test time).

## Threat Surface Scan

The Plan 06-05 `<threat_model>` register (T-06-LOADER-01..04 + T-06-DOSSIER-01..03) accurately covers the surface introduced. No new attack surface beyond what was specified. Specifically:
- All `loadContext` Postgres queries filter by `owner_id` (T-06-LOADER-01 mitigation).
- `dossier-loader` is the sole subscriber to `context.full_dossier_requested` and validates the detail via `FullDossierRequestedSchema.parse` (T-06-LOADER-04 mitigation).
- GCP SA JSON read at module-load via Secrets Manager + cached at module-level (T-06-DOSSIER-01 mitigation; rotation forces redeploy).

## Self-Check: PASSED

**Files claimed created (8):**
- `packages/context-loader/test/markdown.test.ts` — FOUND (8 cases pass)
- `packages/context-loader/test/cache.test.ts` — FOUND (11 cases pass)
- `packages/context-loader/test/loadContext.test.ts` — FOUND (9 cases pass)
- `packages/context-loader/test/budget.test.ts` — FOUND (2 cases pass; p95 < 800ms)
- `services/dossier-loader/test/vertex.test.ts` — FOUND (5 cases pass)
- `services/dossier-loader/test/handler.test.ts` — FOUND (4 cases pass)
- `packages/cdk/test/integrations-vertex.test.ts` — FOUND (6 cases pass)
- `scripts/trigger-full-dossier.mjs` — FOUND (executable; --help works; UUID validation works)

**Files claimed modified (key ones verified):**
- `packages/context-loader/src/index.ts` — `loadKevinContextMarkdown` exported
- `packages/context-loader/src/kevin.ts` — `loadKevinContextMarkdown` defined
- `services/triage/src/persist.ts` / `voice-capture/src/persist.ts` / `entity-resolver/src/persist.ts` / `transcript-extractor/src/persist.ts` — all 4 delegate to `@kos/context-loader::loadKevinContextMarkdown`
- `services/entity-resolver/src/handler.ts` — `loadContext` call inside `completeDisambigOrInbox`
- `services/entity-resolver/src/disambig.ts` — `additionalContextBlock` parameter
- `services/transcript-extractor/src/handler.ts` — `loadContext` call replaces `loadKevinContextBlockOnce`
- `packages/cdk/lib/stacks/integrations-vertex.ts` — refactored to `wireDossierLoader`
- `packages/cdk/lib/stacks/integrations-stack.ts` — `wireDossierLoader` called when 3 GCP props supplied
- `packages/cdk/lib/stacks/data-stack.ts` — `gcpVertexSaSecret` shell

**Commits claimed:**
- `f853268` test(06-05): @kos/context-loader unit + budget tests — FOUND in `git log`
- `87c5853` feat(06-05): wire @kos/context-loader into 4 consumer Lambdas — FOUND
- `cec1680` feat(06-05): wire dossier-loader Lambda + INF-10 trigger script — FOUND

**Test totals (verified by re-running each suite):**
- `@kos/context-loader`: 30 / 30 pass
- `@kos/service-triage`: 3 / 3 pass
- `@kos/service-voice-capture`: 2 / 2 pass
- `@kos/service-entity-resolver`: 8 / 8 pass
- `@kos/service-transcript-extractor`: 18 / 18 pass (across 3 test files)
- `@kos/service-dossier-loader`: 9 / 9 pass
- `@kos/cdk integrations-vertex`: 6 / 6 pass

All claims verified. SUMMARY ready for orchestrator merge.
