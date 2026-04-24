---
phase: 06
slug: granola-semantic-memory
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-24
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> See `06-RESEARCH.md` §13 "Validation Architecture" for the authoritative per-task verification matrix. Planner finalises Task IDs here.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (unit) + Node CLI assertions (integration) |
| **Config file** | per-package `vitest.config.ts` under `services/*` and `packages/*` |
| **Quick run command** | `pnpm -w test -- --run` |
| **Affected-only command** | `pnpm --filter @kos/<package> test -- --run` |
| **Full suite command** | `pnpm -w test -- --run && pnpm run verify:phase-6` |
| **Estimated runtime** | ~120 s quick / ~12 min full (unit + mocked integrations) |

---

## Sampling Rate

- **After every task commit:** `pnpm --filter @kos/<package> test -- --run` (affected packages)
- **After every plan wave:** `pnpm -w test -- --run && (cd packages/cdk && npx cdk synth KosIntegrations KosAgents KosObservability)` for stack-touching plans
- **Before `/gsd-verify-work`:** `pnpm run verify:phase-6` must be green
- **Max feedback latency:** ≤120 s (unit) / ≤12 min (integration)

---

## Per-Task Verification Map

Every task has an `<automated>` verify OR a Wave 0 dependency that installs the missing framework.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-00-01 | 00 | 0 | scaffold | T-06-SCAFFOLD-01 | New service workspaces (`granola-poller`, `transcript-extractor`, `azure-search-indexer-{entities,projects,transcripts,daily-brief}`, `entity-timeline-refresher`, `dossier-loader`) + libs (`@kos/context-loader`, `@kos/azure-search`) registered in pnpm workspaces; per-package vitest config | unit | `pnpm -w install --frozen-lockfile=false && pnpm -w test -- --run` | ❌ W0 | ⬜ pending |
| 06-00-02 | 00 | 0 | contracts | T-06-CONTRACT-01 | Zod schemas for `transcript.available` + `context.full_dossier_requested` + ContextBundle live in `packages/contracts/src/context.ts`, re-exported from index barrel | unit | `pnpm --filter @kos/contracts test -- --run` | ❌ W0 | ⬜ pending |
| 06-00-03 | 00 | 0 | migration | T-06-MIGRATION-01 | Drizzle migration `0012_phase_6_dossier_cache_and_timeline_mv.sql` adds: entity_dossiers_cached + transcripts_indexed tables, entity_timeline_mv MV + unique index, mention_events AFTER INSERT trigger (cache invalidation), notion_indexer_cursor 'transkripten' seed row | integration | `pnpm --filter @kos/db test -- --run migration-0012` | ❌ W0 | ⬜ pending |
| 06-00-04 | 00 | 0 | fixtures | T-06-FIXTURES-01 | test-fixtures extended: granola-transcript fixture, transcript-extract tool_use fixture, azure-search hit fixture, gemini-cached-content fixture | unit | `pnpm --filter @kos/test-fixtures test -- --run` | ❌ W0 | ⬜ pending |
| 06-01-01 | 01 | 1 | CAP-08 | T-06-POLLER-01 | granola-poller Lambda reads Notion Transkripten with `last_edited_time` filter; `notion_indexer_cursor` advances `max - 1min`; idempotency via agent_runs `agent_name='granola-poller'` capture_id=transcript_id | unit | `pnpm --filter @kos/service-granola-poller test -- --run` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | CAP-08 contract | T-06-POLLER-02 | granola-poller PutEvents `transcript.available` to kos.capture; payload validated by Zod; transcript_text capped at 64 KB | unit | `pnpm --filter @kos/service-granola-poller test -- --run -- contract` | ❌ W0 | ⬜ pending |
| 06-01-03 | 01 | 1 | AUTO-05 | T-06-POLLER-03 | CDK helper `wireGranolaPipeline` adds Lambda + EventBridge Scheduler `granola-poller-15min` rate(15min) Europe/Stockholm + scheduler-role grant + RDS-Proxy IAM grant | integration | `pnpm --filter @kos/cdk test -- --run integrations-granola` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | AGT-06 | T-06-EXTRACTOR-01 | transcript-extractor Lambda consumes `transcript.available`; calls Sonnet 4.6 with tool_use; Zod validates output; cache_control:ephemeral on system prompt segments | unit | `pnpm --filter @kos/service-transcript-extractor test -- --run` | ❌ W0 | ⬜ pending |
| 06-02-02 | 02 | 2 | AGT-06 / Notion | T-06-EXTRACTOR-02 | Action items written to Command Center DB with Kevin's Swedish schema (Uppgift / Typ / Prioritet / Anteckningar); `[Granola: <title>]` provenance prefix | unit | `pnpm --filter @kos/service-transcript-extractor test -- --run -- notion` | ❌ W0 | ⬜ pending |
| 06-02-03 | 02 | 2 | AGT-06 / events | T-06-EXTRACTOR-03 | Each extracted entity_mention emits `entity.mention.detected` to kos.agent (existing schema); transcripts_indexed row inserted | integration | `pnpm --filter @kos/service-transcript-extractor test -- --run -- events && node scripts/verify-extractor-events.mjs` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 2 | MEM-03 | T-06-INDEXER-01 | `@kos/azure-search` library: `hybridQuery({query, entityIds?, topK, semanticRerank})` issues one REST call (BM25 + vector + RRF + semantic rerank); returns SearchHit[] + elapsedMs | unit | `pnpm --filter @kos/azure-search test -- --run` | ❌ W0 | ⬜ pending |
| 06-03-02 | 03 | 2 | MEM-03 | T-06-INDEXER-02 | 4 indexer Lambdas (entities/projects/transcripts/daily-brief) each upsert to `kos-memory-v1` index; cursor in `notion_indexer_cursor` analogue; per-type schedule | unit | `pnpm --filter @kos/service-azure-search-indexer-entities test -- --run && pnpm --filter @kos/service-azure-search-indexer-projects test -- --run && pnpm --filter @kos/service-azure-search-indexer-transcripts test -- --run && pnpm --filter @kos/service-azure-search-indexer-daily-brief test -- --run` | ❌ W0 | ⬜ pending |
| 06-03-03 | 03 | 2 | MEM-03 latency | T-06-INDEXER-03 | `scripts/verify-mem-03-latency.mjs` runs 50 hybrid queries against deployed index (or mock for unit); asserts p95 < 600ms in mock mode and prints budget violation lines for live mode | integration | `pnpm --filter @kos/azure-search test -- --run -- latency-budget && node scripts/verify-mem-03-latency.mjs --mock` | ❌ W0 | ⬜ pending |
| 06-03-04 | 03 | 2 | MEM-03 wiring | T-06-INDEXER-04 | CDK helper `wireAzureSearchIndexers` adds 4 Lambdas + 4 EventBridge Schedulers + IAM grants (Bedrock for Cohere v4, Secrets Manager for Azure admin key, RDS for cursor) | integration | `pnpm --filter @kos/cdk test -- --run integrations-azure-indexers` | ❌ W0 | ⬜ pending |
| 06-04-01 | 04 | 3 | MEM-04 MV | T-06-MV-01 | Migration 0012 acceptance test: `entity_timeline_mv` exists; CONCURRENTLY refresh succeeds; row count matches `mention_events WHERE entity_id IS NOT NULL` | integration | `pnpm --filter @kos/db test -- --run mv-acceptance` | ❌ W0 | ⬜ pending |
| 06-04-02 | 04 | 3 | MEM-04 refresher | T-06-MV-02 | entity-timeline-refresher Lambda runs `REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline_mv`; <2s expected; 30s timeout | unit | `pnpm --filter @kos/service-entity-timeline-refresher test -- --run` | ❌ W0 | ⬜ pending |
| 06-04-03 | 04 | 3 | MEM-04 dashboard | T-06-MV-03 | `apps/dashboard/src/app/api/entities/[id]/timeline/route.ts` returns 50 rows from MV ⋃ live mention_events overlay; <50ms p95 against fixture set of 100k rows | integration | `pnpm --filter @kos/dashboard test -- --run timeline-api` | ❌ W0 | ⬜ pending |
| 06-04-04 | 04 | 3 | dossier cache table | T-06-CACHE-01 | `entity_dossiers_cached` table accepts upsert; AFTER INSERT trigger on `mention_events` deletes matching cache row | integration | `pnpm --filter @kos/db test -- --run dossier-cache-trigger` | ❌ W0 | ⬜ pending |
| 06-05-01 | 05 | 3 | AGT-04 | T-06-LOADER-01 | `@kos/context-loader::loadContext` returns ContextBundle with kevinContext + entityDossiers + recentMentions + semanticChunks + linkedProjects + assembledMarkdown; degraded path when entityIds=[] | unit | `pnpm --filter @kos/context-loader test -- --run` | ❌ W0 | ⬜ pending |
| 06-05-02 | 05 | 3 | AGT-04 budget | T-06-LOADER-02 | loadContext p95 <800ms in mock-pool benchmark; cache-hit path <50ms | unit | `pnpm --filter @kos/context-loader test -- --run -- budget` | ❌ W0 | ⬜ pending |
| 06-05-03 | 05 | 3 | AGT-04 wiring | T-06-LOADER-03 | triage + voice-capture + entity-resolver + transcript-extractor handlers updated to call loadContext + inject assembledMarkdown into Bedrock system prompt with cache_control:ephemeral; loadKevinContextBlock duplications removed | unit | `pnpm --filter @kos/service-triage test -- --run && pnpm --filter @kos/service-voice-capture test -- --run && pnpm --filter @kos/service-entity-resolver test -- --run && pnpm --filter @kos/service-transcript-extractor test -- --run` | ❌ W0 | ⬜ pending |
| 06-05-04 | 05 | 3 | INF-10 | T-06-DOSSIER-01 | services/dossier-loader Lambda subscribes to `context.full_dossier_requested`; calls Vertex Gemini 2.5 Pro `gemini-2.5-pro` europe-west4 with cachedContent (>=32k tokens via padding); writes to entity_dossiers_cached with `last_touch_hash = 'gemini-full:' || sha256(...)` | unit | `pnpm --filter @kos/service-dossier-loader test -- --run` | ❌ W0 | ⬜ pending |
| 06-05-05 | 05 | 3 | INF-10 wiring | T-06-DOSSIER-02 | CDK helper `wireDossierLoader` adds Lambda + EventBridge rule on `context.full_dossier_requested` + Secrets Manager grant on `kos/gcp-vertex-sa` | integration | `pnpm --filter @kos/cdk test -- --run integrations-vertex` | ❌ W0 | ⬜ pending |
| 06-06-01 | 06 | 4 | E2E gate | T-06-E2E-01 | `scripts/verify-phase-6-e2e.mjs` exercises: synthetic transcript.available → transcript-extractor → 1+ Command Center row + 1+ entity.mention.detected → resolver → mention_events → AGT-04 cache invalidated → next loadContext call recomputes | integration | `node scripts/verify-phase-6-e2e.mjs --mock` | ❌ W0 | ⬜ pending |
| 06-06-02 | 06 | 4 | Gate verifier | T-06-E2E-02 | `scripts/verify-phase-6-gate.mjs` walks all 7 SCs, prints PASS/FAIL/HUMAN per criterion; exits 1 on any FAIL | integration | `node scripts/verify-phase-6-gate.mjs --mock` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `services/granola-poller/` — new workspace
- [ ] `services/transcript-extractor/` — new workspace
- [ ] `services/azure-search-indexer-entities/` — new workspace
- [ ] `services/azure-search-indexer-projects/` — new workspace
- [ ] `services/azure-search-indexer-transcripts/` — new workspace
- [ ] `services/azure-search-indexer-daily-brief/` — new workspace
- [ ] `services/entity-timeline-refresher/` — new workspace
- [ ] `services/dossier-loader/` — new workspace
- [ ] `packages/context-loader/` — new lib workspace
- [ ] `packages/azure-search/` — new lib workspace
- [ ] `packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql` — migration with entity_dossiers_cached, transcripts_indexed, entity_timeline_mv (+ unique index), AFTER INSERT trigger on mention_events, transkripten cursor seed
- [ ] `packages/contracts/src/context.ts` — TranscriptAvailableSchema, ContextFullDossierRequestedSchema, ContextBundleSchema (Zod)
- [ ] `packages/contracts/src/index.ts` — re-export context schemas
- [ ] `packages/test-fixtures/src/granola.ts` — synthetic Granola transcript fixture
- [ ] `packages/test-fixtures/src/azure-search.ts` — synthetic SearchHit fixture
- [ ] `packages/test-fixtures/src/vertex.ts` — synthetic cachedContent + Gemini response fixture
- [ ] `scripts/verify-phase-6-e2e.mjs` — end-to-end transcript-arrival → extractor → resolver → cache-invalidation
- [ ] `scripts/verify-phase-6-gate.mjs` — Gate verifier walking all 7 SCs
- [ ] `scripts/verify-mem-03-latency.mjs` — Azure hybrid-query latency budget script
- [ ] `scripts/trigger-full-dossier.mjs` — operator-runbook script for INF-10
- [ ] Shared test fixtures: mock Bedrock tool_use, mock Notion Transkripten page, mock Azure search response, mock Vertex response
- [ ] Secrets Manager (operator step, NOT auto-created): `kos/gcp-vertex-sa` (service-account JSON for Vertex AI europe-west4)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live Notion Transkripten DB read | CAP-08 | Requires live Notion token + actual transcript pages | 1. Confirm `scripts/.notion-db-ids.json` has `transkripten` key. 2. Run `node scripts/discover-notion-dbs.mjs --db transkripten` to discover ID. 3. Manually trigger granola-poller Lambda once via AWS CLI; assert `agent_runs` row appears + EventBridge `transcript.available` event published. |
| Vertex AI service-account roles | INF-10 | Requires GCP console access | 1. Operator creates GCP project (or uses existing). 2. Enable Vertex AI API in europe-west4. 3. Create SA with `roles/aiplatform.user`. 4. Download SA JSON. 5. `aws secretsmanager put-secret-value --secret-id kos/gcp-vertex-sa --secret-string @sa.json`. |
| Azure index schema bump (if any new fields needed) | MEM-03 | Requires Azure portal or `cdk deploy` access | 1. Edit `services/azure-search-bootstrap/src/index-schema.ts` to add `transcript_title`, `recorded_at` fields. 2. `cd packages/cdk && npx cdk deploy KosIntegrations` (CustomResource fingerprint changes; non-breaking field additions accepted by Azure PUT). |
| Live Azure index population | MEM-03 | Requires deployed Lambdas + actual entity / project / transcript rows | 1. Deploy Phase 6 stacks. 2. Trigger each indexer Lambda once via AWS CLI. 3. `node scripts/verify-azure-index-populated.mjs` (operator script — counts docs in index per `source` facet). |
| Live MEM-03 latency measurement | MEM-03 | Requires live Azure + populated index | `node scripts/verify-mem-03-latency.mjs --live` runs 50 representative queries; asserts p95 < 600ms. |
| 80% dossier cache hit rate verification | AGT-04 | Requires 1+ day of production traffic + Langfuse retro | After 1 day: query Langfuse for `loadContext` traces; assert `cacheHit=true` count / total > 0.8. If <0.5, escalate per D-17 (revisit ElastiCache decision). |
| First Vertex Gemini cachedContent invocation | INF-10 | Requires real GCP project + first cache provisioning | `node scripts/trigger-full-dossier.mjs --entity-id <real-uuid>`; assert dossier-loader Lambda completes <10s; `entity_dossiers_cached` row updated with `last_touch_hash` prefix `gemini-full:`. |
| AGT-06 transcript-extraction quality | AGT-06 | Requires Kevin's gut on 10 real transcripts | Take 30 real Granola transcripts from last 60 days. Manually review 10 for action-item quality; assert ≥8/10 deemed actionable by Kevin. Failure → iterate prompt + re-run; not a code defect. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags in CI
- [ ] Feedback latency < 120 s (unit) / < 12 min (integration)
- [x] `nyquist_compliant: true` set in frontmatter (matrix populated above)

**Approval:** Pending live execution
