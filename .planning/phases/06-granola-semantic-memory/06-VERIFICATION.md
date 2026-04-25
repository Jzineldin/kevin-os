---
phase: 06-granola-semantic-memory
verified: 2026-04-25T00:13:04Z
status: gaps_found
score: 5/7 roadmap success criteria auto-verified (2 require human + live-run evidence; 1 code-side partial gap on Azure semantic injection)
overrides_applied: 1
overrides:
  - must_have: "Dossier cache in ElastiCache keyed by entity_id + last_touch_hash"
    reason: "CONTEXT D-17 [LOCKED — recommended default] chose Postgres (entity_dossiers_cached table) over ElastiCache Serverless. Rationale: RDS Proxy already handles this access pattern; ElastiCache adds ops surface with no latency benefit at single-user scale. Postgres path picked. Revisit only if cache-hit rate < 50% in production."
    accepted_by: "Claude (Phase 6 CONTEXT planner, 2026-04-24)"
    accepted_at: "2026-04-24T00:00:00Z"
gaps:
  - truth: "Auto-context loader (AGT-04) queries Azure AI Search top-10 semantic chunks and injects them into agent prompts via loadContext"
    status: partial
    reason: "loadContext() accepts an optional 'azureSearch' callable parameter for semantic chunk injection, but none of the 4 consumer Lambdas (triage, voice-capture, entity-resolver, transcript-extractor) pass this parameter. In production, semanticChunks is always an empty array []. The library architecture supports it, but the wiring is incomplete: ROADMAP SC3 AGT-04 says 'queries...Azure AI Search top-10' and CONTEXT D-15 says the 800ms budget includes 'Azure hybrid query'. The gap is confirmed by grep: zero references to 'azureSearch' or 'hybridQuery' in any consumer Lambda src/ (excluding tests)."
    artifacts:
      - path: "packages/context-loader/src/loadContext.ts"
        issue: "azureSearch parameter is optional and defaults to Promise.resolve([]) when not provided — correct design but no caller injects it"
      - path: "services/triage/src/handler.ts"
        issue: "loadContext called without azureSearch; semanticChunks always empty"
      - path: "services/voice-capture/src/handler.ts"
        issue: "loadContext called without azureSearch; semanticChunks always empty"
      - path: "services/entity-resolver/src/handler.ts"
        issue: "loadContext called without azureSearch; semanticChunks always empty"
      - path: "services/transcript-extractor/src/handler.ts"
        issue: "loadContext called without azureSearch; semanticChunks always empty"
    missing:
      - "Each consumer Lambda must import { hybridQuery } from '@kos/azure-search' and pass it as the azureSearch callable to loadContext(). Example for triage: loadContext({ ..., azureSearch: ({ rawText, entityIds, topK }) => hybridQuery({ query: rawText, ownerId, entityIds, topK, semanticRerank: true }).then(r => r.results) })"
      - "Pool injection for @kos/context-loader is also missing in triage/voice-capture — currently the services pass 'pool' from getPool() but @kos/azure-search's hybridQuery reads AZURE_SEARCH_SECRET_ARN from env, so the Azure grant must also be added to each consumer Lambda's CDK IAM policy"
human_verification:
  - test: "AGT-06 action-item quality: review 30 real Granola transcripts in Command Center"
    expected: "At least 8 of every 10 extracted action items are deemed actionable by Kevin (wording is clear, context is sufficient, task is completable)"
    why_human: "LLM output quality on real Swedish/English Granola transcripts cannot be asserted programmatically. Requires Kevin's subjective review of extracted action items across a representative set of 30 transcripts."
  - test: "AGT-04 loadContext p95 latency: query Langfuse after 1 day of production traffic"
    expected: "p95 elapsed_ms < 800ms; cache_hit rate > 50% (rising to 80% over days)"
    why_human: "Performance budget only verifiable under real production load with real RDS + Azure queries. Langfuse trace aggregation (filter agentName='loadContext') is the measurement tool."
  - test: "MEM-04 dashboard timeline p95: measure /api/entities/[id]/timeline at 100k mention_events"
    expected: "p95 < 50ms even at 100k mention_events (relies on entity_timeline MV index + UNION ALL query plan)"
    why_human: "Performance only verifiable on production data with real PostgreSQL row volumes. Requires Kevin to hit the dashboard entity timeline for 50 representative entities and measure server-timing elapsedMs."
  - test: "INF-10 Vertex Gemini 2.5 Pro cost: run scripts/trigger-full-dossier.mjs and check GCP billing"
    expected: "Cost per call < $1.50 average (Gemini 2.5 Pro europe-west4 input at $1.25/M tokens; typical dossier ~50k tokens = $0.06 input + output)"
    why_human: "GCP billing console is the only source of truth for actual per-call cost. Requires operator to trigger at least 3 dossier loads, wait 24h for billing to settle, and record the per-call average."
  - test: "SC7 Dossier cache hit rate: measure cache_hit field over 1 representative day"
    expected: "cache_hit > 80% in Langfuse traces filtered by ContextBundle.cache_hit=true over 24h"
    why_human: "Hit rate only measurable once real production traffic has run for at least one day. Requires Kevin to query Langfuse trace data."
---

# Phase 6: Granola + Semantic Memory — Verification Report

**Phase Goal:** Wire Granola (Notion Transkripten DB) as the transcript substrate, make Azure AI Search the hybrid semantic memory for all four content types (entities, projects, transcripts, daily briefs), ship Vertex Gemini 2.5 Pro as the full-dossier loader, and retrofit every agent Lambda with auto-loaded entity context via @kos/context-loader. By end of phase, Kevin never re-explains context — mentioning any entity triggers full-dossier load; every Granola meeting ends with action items in Swedish Command Center; every agent output is context-aware.

**Verified:** 2026-04-25T00:13:04Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Granola poller polls Transkripten DB every 15 min, idempotent on transcript_id, emits transcript.available to kos.capture (CAP-08 + AUTO-05) | VERIFIED | `services/granola-poller/src/persist.ts:111` DetailType='transcript.available'; CDK `integrations-granola.ts:169` scheduleExpression='rate(15 minutes)' Europe/Stockholm; `cursor.ts` uses `db_kind='transkripten'` + `last_cursor_at`; agent_runs idempotency on transcript_id |
| 2 | transcript-extractor consumes transcript.available, runs Sonnet 4.6 Bedrock tool_use, writes Command Center rows (Swedish schema + [Granola: title] provenance) + emits entity.mention.detected (AGT-06) | VERIFIED | `agent.ts:46` SONNET_4_6_MODEL_ID='eu.anthropic.claude-sonnet-4-6-20250929-v1:0'; `notion.ts:113` '[Granola: ...]' provenance; `persist.ts:300` DetailType='entity.mention.detected'; `notion.ts:125-133` Uppgift/Typ/Prioritet/Anteckningar/Status Swedish schema |
| 3 | Azure AI Search @kos/azure-search exports hybridQuery() with BM25+vector+RRF+semantic-rerank in one REST call (MEM-03) | VERIFIED | `query.ts:59-61` queryType='semantic', configurationName='kos-semantic'; 4 indexer Lambdas per content type; `integrations-azure-indexers.ts:191-209` CfnSchedules rate(5 min) + rate(15 min) Europe/Stockholm; verify-mem-03-latency.mjs --mock exits 0 |
| 4 | loadContext() returns ContextBundle with Kevin Context + entity dossiers + recent mentions + linked projects + assembled_markdown injected into agent prompts with cache_control:ephemeral (AGT-04 — code wired, semanticChunks empty in production — see gap) | PARTIAL | `loadContext.ts` implements Promise.all parallelism, cache read/write, markdown assembly; triage/voice-capture/entity-resolver/transcript-extractor all import and call loadContext; assembled_markdown injected with cache_control:ephemeral confirmed in `triage/agent.ts:96-103`, `entity-resolver/disambig.ts:77-82`; BUT: no consumer passes azureSearch callable — semanticChunks always [] in production |
| 5 | entity_timeline MV refreshed every 5 min via Lambda + EventBridge Scheduler; dashboard timeline route returns MV UNION ALL live overlay query (MEM-04) | VERIFIED | `entity-timeline-refresher/src/persist.ts:71` REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline; `integrations-mv-refresher.ts:137-138` entity-timeline-refresher-5min rate(5 minutes); `dashboard-api/src/handlers/timeline.ts:102-118` FROM entity_timeline ... UNION ALL ... mention_events + is_live_overlay flags |
| 6 | dossier-loader subscribes to context.full_dossier_requested on kos.agent, calls Vertex Gemini 2.5 Pro europe-west4, writes to entity_dossiers_cached with gemini-full: prefix (INF-10) | VERIFIED | `vertex.ts:20-21` MODEL_ID='gemini-2.5-pro', LOCATION='europe-west4'; `handler.ts:75` lastTouchHash='gemini-full:...'; `integrations-vertex.ts:126-127` source=['kos.agent'], detailType=['context.full_dossier_requested']; `scripts/trigger-full-dossier.mjs` exists |
| 7 | Dossier cache (entity_dossiers_cached table) + AFTER INSERT trigger on mention_events invalidates cache rows when entity_id non-null; cache backed by Postgres (D-17 deviation from ROADMAP ElastiCache — ACCEPTED override) | VERIFIED | Migration 0012: `CREATE TRIGGER trg_entity_dossiers_cached_invalidate AFTER INSERT ON mention_events`; `cache.ts:29,43,63` exports computeLastTouchHash + readDossierCache + writeDossierCache; ElastiCache deviation accepted per CONTEXT D-17 |

**Score:** 6/7 truths verified (1 PARTIAL on Azure semantic chunk wiring in consumer Lambdas)

### Deferred Items

No items deferred to later milestone phases. The Azure semantic chunk gap is a Phase 6 implementation gap, not a later-phase concern.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `services/granola-poller/src/handler.ts` | Granola poller Lambda handler | VERIFIED | 171 lines; KEVIN_OWNER_ID + D-28 instrumentation; cursor advance = max-edited - 1 min |
| `services/granola-poller/src/notion.ts` | Transkripten DB query + page reading | VERIFIED | 267 lines; 64KB cap; paginated queryTranskriptenSince |
| `services/granola-poller/src/cursor.ts` | notion_indexer_cursor advance logic | VERIFIED | 105 lines; db_kind='transkripten'; advanceCursor |
| `services/granola-poller/src/persist.ts` | agent_runs idempotency + PutEvents | VERIFIED | 134 lines; findPriorOkRun + publishTranscriptAvailable |
| `packages/cdk/lib/stacks/integrations-granola.ts` | wireGranolaPipeline CDK helper | VERIFIED | 182 lines; rate(15 minutes) Europe/Stockholm; GranolaPollerSchedule |
| `scripts/discover-notion-dbs.mjs` | Operator runbook for Transkripten DB id | VERIFIED | exists; --db transkripten argument; idempotent JSON merge |
| `services/transcript-extractor/src/handler.ts` | EventBridge target Lambda entry point | VERIFIED | 278 lines; loads context + writes CC + emits mentions |
| `services/transcript-extractor/src/agent.ts` | Sonnet 4.6 Bedrock + tool_use + Zod | VERIFIED | 265 lines; eu.anthropic.claude-sonnet-4-6; RECORD_TRANSCRIPT_EXTRACT_TOOL |
| `services/transcript-extractor/src/notion.ts` | Command Center row writer (Swedish) | VERIFIED | 141 lines; Uppgift/Typ/Prioritet/Anteckningar/Status; [Granola: title] provenance |
| `services/transcript-extractor/src/persist.ts` | agent_runs + transcripts_indexed + PutEvents | VERIFIED | 317 lines; insertTranscriptIndexed via agent_runs row |
| `packages/azure-search/src/query.ts` | hybridQuery BM25+vector+RRF+semantic | VERIFIED | 98 lines; queryType='semantic'; kos-semantic config |
| `packages/azure-search/src/upsert.ts` | upsertDocuments bulk upload | VERIFIED | 73 lines; mergeOrUploadDocuments; batching |
| `packages/azure-search/src/client.ts` | Azure Search REST client | VERIFIED | 93 lines; AZURE_SEARCH_SECRET_ARN; API_VERSION='2025-09-01' |
| `services/azure-search-indexer-entities/src/handler.ts` | Entities indexer Lambda | VERIFIED | 89 lines; source='entity'; upsertDocuments |
| `services/azure-search-indexer-projects/src/handler.ts` | Projects indexer Lambda | VERIFIED | 69 lines; source='project'; upsertDocuments |
| `services/azure-search-indexer-transcripts/src/handler.ts` | Transcripts indexer (reads agent_runs) | VERIFIED | 77 lines; reads agent_runs WHERE agent_name='transcript-indexed' |
| `services/azure-search-indexer-daily-brief/src/handler.ts` | Daily-brief placeholder (Phase 7) | VERIFIED | 77 lines; graceful no-op until Phase 7 populates daily_brief_log |
| `packages/cdk/lib/stacks/integrations-azure-indexers.ts` | wireAzureSearchIndexers CDK helper | VERIFIED | 219 lines; 4 CfnSchedules; rate(5 min) entities/projects/transcripts; rate(15 min) daily-brief |
| `services/entity-timeline-refresher/src/handler.ts` | Refresh Lambda | VERIFIED | REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline |
| `apps/dashboard/src/app/api/entities/[id]/timeline/route.ts` | Timeline API proxy | VERIFIED | Proxies to dashboard-api; `dashboard-api/src/handlers/timeline.ts` has MV UNION ALL overlay query |
| `packages/cdk/lib/stacks/integrations-mv-refresher.ts` | wireMvRefresher CDK helper | VERIFIED | 155 lines; entity-timeline-refresher-5min; rate(5 minutes) Europe/Stockholm |
| `packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql` | Migration 0012 | VERIFIED | entity_dossiers_cached + trg_entity_dossiers_cached_invalidate + entity_timeline MV + uniq_entity_timeline_event + refresh_entity_timeline() wrapper |
| `packages/context-loader/src/loadContext.ts` | loadContext implementation | PARTIAL | 289 lines; Promise.all parallelism; cache read/write; assembled_markdown; BUT azureSearch parameter optional and no caller injects it — semanticChunks always [] in production |
| `packages/context-loader/src/cache.ts` | Dossier cache read/write | VERIFIED | 97 lines; computeLastTouchHash + readDossierCache + writeDossierCache |
| `packages/context-loader/src/markdown.ts` | buildDossierMarkdown | VERIFIED | 120 lines; conditional section omission; entity + mentions + projects + semantic chunks |
| `packages/context-loader/src/kevin.ts` | loadKevinContextBlock canonical | VERIFIED | 93 lines; single source of truth; 4 services delegate to it |
| `services/dossier-loader/src/handler.ts` | Vertex Gemini full-dossier loader | VERIFIED | 108 lines; context.full_dossier_requested; gemini-full: hash prefix |
| `services/dossier-loader/src/vertex.ts` | Vertex AI client + generateContent | VERIFIED | 116 lines; gemini-2.5-pro; europe-west4; GCP SA from Secrets Manager |
| `packages/cdk/lib/stacks/integrations-vertex.ts` | wireDossierLoader CDK helper | VERIFIED | 133 lines; EventBridge Rule on context.full_dossier_requested; GCP secret grant |
| `scripts/trigger-full-dossier.mjs` | Operator runbook trigger script | VERIFIED | exists; --entity-id UUID validation; PutEvents to kos.agent |
| `scripts/verify-phase-6-e2e.mjs` | E2E quality-multiplier integration test | VERIFIED | 13/13 PASS in mock mode; exit 0 |
| `scripts/verify-phase-6-gate.mjs` | Gate verifier walking all 7 SCs | VERIFIED | exit 0; 0 FAIL; 5 HUMAN-pending markers |
| `.planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-template.md` | Operator-fillable gate evidence | VERIFIED | status=PENDING; all 7 SC slots present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `granola-poller/src/persist.ts` | kos.capture bus / transcript.available | PutEvents Source='kos.capture' DetailType='transcript.available' | WIRED | Line 111-122 `DETAIL_TYPE = 'transcript.available'` confirmed |
| `integrations-granola.ts` | EventBridge Scheduler rate(15 min) Europe/Stockholm | CfnSchedule scheduleExpression='rate(15 minutes)' | WIRED | Lines 169-170 confirmed |
| `granola-poller/src/persist.ts` | agent_runs idempotency | findPriorOkRun agentName='granola-poller' | WIRED | Lines 62-70 confirmed |
| `transcript-extractor/src/agent.ts` | Sonnet 4.6 via bedrock-sdk | model='eu.anthropic.claude-sonnet-4-6-20250929-v1:0' + tool_choice | WIRED | Lines 46, 219 confirmed |
| `transcript-extractor/src/handler.ts` | kos.agent / entity.mention.detected | PutEvents EntityMentionDetectedSchema parse | WIRED | Lines 243-300 confirmed |
| `transcript-extractor/src/notion.ts` | Notion Command Center DB | notion.pages.create with Uppgift/Typ/Prioritet | WIRED | Lines 125-133 confirmed |
| `azure-search/src/query.ts` | Azure AI Search REST API 2025-09-01 | POST /indexes/kos-memory-v1/docs/search + queryType:semantic+kos-semantic | WIRED | Lines 52-67 confirmed |
| `azure-search/src/query.ts` | Cohere v4 embed via @kos/resolver | embedBatch([query], 'search_query') | NOT_VERIFIED | embed.ts imports embedBatch pattern but actual call not directly visible in query.ts grep; confirmed by unit test mocks |
| `@kos/context-loader::loadContext` | @kos/azure-search::hybridQuery | Promise.all branch for semantic chunks via injected azureSearch callable | PARTIAL | Library supports injection but zero consumer Lambdas inject azureSearch — semantic chunks are never populated in production |
| `services/triage/src/handler.ts` | @kos/context-loader::loadContext | imported call before runTriageAgent; assembled_markdown injected | WIRED | Lines 124-132; assembled_markdown passed as kevinContextBlock to runTriageAgent |
| `entity-timeline-refresher/src/persist.ts` | PostgreSQL entity_timeline MV | REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline | WIRED | Line 71 confirmed; fallback to refresh_entity_timeline() on privilege error |
| `dashboard-api/src/handlers/timeline.ts` | entity_timeline UNION ALL mention_events overlay | SQL with false/true AS is_live_overlay | WIRED | Lines 102-126 confirmed |
| `dossier-loader/src/handler.ts` | Vertex AI Gemini 2.5 Pro europe-west4 | cachedContent + generateContent via vertex.ts | WIRED | Lines 68-75; buildFullDossier + writeGeminiDossier with gemini-full: prefix |
| `mention_events AFTER INSERT trigger` | entity_dossiers_cached invalidation | DELETE FROM entity_dossiers_cached WHERE entity_id = NEW.entity_id | WIRED | Migration 0012 lines 59-61: trg_entity_dossiers_cached_invalidate confirmed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `granola-poller/src/handler.ts` | transcript pages from Notion | queryTranskriptenSince → Notion API | Yes — paginated Notion databases.query with last_edited_time filter | FLOWING |
| `transcript-extractor/src/agent.ts` | Extract (action_items + entity_mentions) | AnthropicBedrock messages.create Sonnet 4.6 tool_use | Yes — real LLM call; Zod validation on tool_use block | FLOWING |
| `transcript-extractor/src/notion.ts` | CC page IDs from Notion | notion.pages.create with Swedish properties | Yes — writes to Notion; returns page.id | FLOWING |
| `azure-search/src/query.ts` | SearchHit[] results | Azure REST POST /indexes/kos-memory-v1/docs/search | Yes — real Azure REST call with BM25+vector+semantic | FLOWING (when called) |
| `context-loader/src/loadContext.ts` | semanticChunks: SearchHit[] | azureSearch injectable parameter | No — azureSearch not injected by any consumer Lambda; always [] | HOLLOW_PROP |
| `entity-timeline-refresher/src/persist.ts` | REFRESH SQL | PostgreSQL entity_timeline MV | Yes — REFRESH MATERIALIZED VIEW CONCURRENTLY | FLOWING |
| `dossier-loader/src/vertex.ts` | dossierMarkdown from Gemini | Vertex AI generateContent | Yes — real Gemini 2.5 Pro call in europe-west4 | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| E2E mock: all Phase 6 contracts + flows | `node scripts/verify-phase-6-e2e.mjs --mock` | 13/13 PASS; exit 0 | PASS |
| Gate verifier: all 7 SCs | `node scripts/verify-phase-6-gate.mjs --mock` | 0 FAIL; 5 HUMAN; exit 0 | PASS |
| MEM-03 latency mock | `node scripts/verify-mem-03-latency.mjs --mock` | p95 synthetic PASS < 600ms | PASS |
| Migration 0012 sanity | SQL contains all 5 required sections | trigger + MV + uniq index + cache table + refresh wrapper | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| CAP-08 | 06-00, 06-01 | Granola transcripts polled from Notion Transkripten DB every 15 min using last_edited_time filter | SATISFIED | granola-poller Lambda + 15-min EventBridge Scheduler + cursor.ts + idempotency via agent_runs |
| AGT-04 | 06-00, 06-05 | Auto-context loader pre-call hook injects entity dossiers + Azure AI Search top-10 into agent system prompt | PARTIAL | loadContext() wired in 4 consumer Lambdas with Kevin Context + entity dossiers + mentions + projects; assembled_markdown injected with cache_control:ephemeral; BUT Azure semantic chunks (hybridQuery) not wired from any consumer — semanticChunks always [] |
| AGT-06 | 06-00, 06-02 | Transcript-extractor agent: Sonnet 4.6 reads Granola transcripts, extracts Kevin-action items to Command Center, updates entity dossiers with mention_events | SATISFIED (code) | agent.ts Sonnet 4.6 tool_use; notion.ts Swedish CC schema; persist.ts entity.mention.detected; HUMAN needed for 8/10 actionable quality acceptance |
| MEM-03 | 06-00, 06-03 | Azure AI Search indexed with 4 content types; hybrid BM25+vector+semantic-reranker < 600ms p95 | SATISFIED | 4 indexer Lambdas; hybridQuery implementation; integrations-azure-indexers.ts with per-type schedules; mock latency verifier passes |
| MEM-04 | 06-00, 06-04 | Per-entity timeline MV refreshed every 5 min; live overlay union; dashboard < 50ms p95 at 100k rows | SATISFIED (code) | entity-timeline-refresher + 5-min schedule; entity_timeline MV in migration 0012; dashboard-api timeline.ts MV+UNION ALL query; HUMAN for p95 at 100k rows |
| AUTO-05 | 06-00, 06-01 | Transcript watcher polls Transkripten DB every 15 min, runs extractor | SATISFIED | granola-poller 15-min EventBridge Scheduler; transcript-extractor wired via EventBridge Rule on transcript.available |
| INF-10 | 06-00, 06-05 | Vertex AI Gemini 2.5 Pro wired in europe-west4 for full-dossier loads with context caching | SATISFIED (code) | dossier-loader/vertex.ts gemini-2.5-pro europe-west4; integrations-vertex.ts EventBridge Rule; trigger script; HUMAN for cost per call < $1.50 |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `services/transcript-extractor/src/persist.ts` | `transcripts_indexed` implemented as `agent_runs` row (agent_name='transcript-indexed') — NOT a separate table as PLAN 06-00 specified | WARNING | Documented deliberate deviation from plan spec (Plan 06-00 SUMMARY); azure-search-indexer-transcripts reads from agent_runs accordingly; no functional gap |
| `packages/context-loader/src/loadContext.ts` | `azureSearch?: callable` optional parameter — designed for injection but no consumer injects it | BLOCKER | semanticChunks always [] in all production loadContext calls; AGT-04 "Azure AI Search top-10" promise unmet |
| `services/entity-timeline-refresher/src/persist.ts` | MV named `entity_timeline` (not `entity_timeline_mv` per plan spec) | WARNING | Plan 06-04 prose references `entity_timeline_mv`; actual migration 0012 uses `entity_timeline`; service code correctly references `entity_timeline`; no functional gap |
| `services/granola-poller/src/persist.ts` | `TranscriptAvailableSchema` used but envelope does NOT include `transcript_text`, `recorded_at`, `attendees`, `notion_url` as plan specified — those are in agent_runs.output_json only | WARNING | Documented deliberate deviation (Plan 06-01 SUMMARY "honor shipped code" pattern); transcript-extractor reads body via second Notion call; no semantic gap in pipeline |

### Human Verification Required

### 1. AGT-06 Action Item Quality

**Test:** Kevin reviews Command Center after 30 real Granola transcripts have been processed. Rate each extracted action item as actionable (clear task, clear owner, context sufficient) or not.

**Expected:** At least 8 of every 10 extracted action items are rated actionable.

**Why human:** LLM output quality on real Swedish/English Granola transcripts cannot be asserted programmatically. Requires Kevin's subjective assessment of whether extracted tasks are genuinely useful vs. over-extracted or poorly worded.

### 2. AGT-04 loadContext Latency Budget

**Test:** After 1 day of production traffic, query Langfuse traces filtered to agentName='loadContext' (or check the agentName field in ContextBundle). Compute p95 of elapsed_ms.

**Expected:** p95 elapsed_ms < 800ms; cache_hit rate rising toward 80% after the first day.

**Why human:** Performance budget is only verifiable under real production load with real RDS query times, real Azure Search latency from eu-north-1, and real network conditions. The mock test uses synthetic latency values.

### 3. MEM-04 Dashboard Timeline p95 at 100k Rows

**Test:** With production mention_events volume approaching 100k rows, hit `GET /api/entities/[id]/timeline` for 50 representative entities and capture the elapsedMs from each JSON response. Compute p95.

**Expected:** p95 < 50ms (the entity_timeline MV index on (owner_id, entity_id, occurred_at DESC) should make this achievable).

**Why human:** This performance characteristic is only testable on production data at production row counts. Current database is pre-production.

### 4. INF-10 Vertex Gemini 2.5 Pro Cost per Call

**Test:** Run `node scripts/trigger-full-dossier.mjs --entity-id <real-uuid>` for 3 different entities. Wait 24h for GCP billing to settle. Record the average cost per invocation from the GCP billing console (filter: Vertex AI, region: europe-west4, model: gemini-2.5-pro).

**Expected:** Average cost per call < $1.50.

**Why human:** GCP billing data is not accessible programmatically from the codebase. Requires GCP console access post-deploy.

### 5. SC7 Dossier Cache Hit Rate

**Test:** After 1 day of production traffic, query Langfuse traces for ContextBundle.cache_hit field distribution. Compute the fraction of loadContext calls where cache_hit=true.

**Expected:** cache_hit rate > 80% in steady state (AFTER the first day populates the cache).

**Why human:** Cache hit rate is a production metric that emerges from the combination of entity access patterns, trigger invalidation behavior, and TTL settings. Only observable from live traffic data.

---

## Gaps Summary

**One code-side gap blocks the AGT-04 "Azure semantic chunk injection" requirement.**

The `@kos/context-loader::loadContext` function accepts an optional `azureSearch` callable parameter that, when provided, enables hybrid Azure AI Search semantic chunk retrieval and inclusion in the assembled_markdown injected into agent system prompts. However, none of the four consumer Lambda handlers (triage, voice-capture, entity-resolver, transcript-extractor) pass this parameter. As a result, `semanticChunks` is always an empty array `[]` in all production loadContext calls, and the assembled_markdown contains no semantic context from Azure AI Search.

This directly violates ROADMAP SC3 (AGT-04): "before any downstream agent invocation, AGT-04... queries Postgres entity_index + mention_events (last 20) + **Azure AI Search top-10** + linked projects... injects it into the called agent's system prompt."

**Root cause:** The loadContext API uses dependency injection for the azureSearch callable (to avoid a circular import between @kos/context-loader and @kos/azure-search). Each consumer Lambda must explicitly import `{ hybridQuery }` from `@kos/azure-search` and pass a wrapper function to loadContext. This wiring step was not completed in Plan 06-05 Task 2.

**Fix required:** In each consumer Lambda (triage, voice-capture, entity-resolver, transcript-extractor), add to the loadContext call:
```typescript
import { hybridQuery } from '@kos/azure-search';
// ...
const bundle = await loadContext({
  // existing args...
  azureSearch: ({ rawText, entityIds, topK }) =>
    hybridQuery({ query: rawText, ownerId, entityIds, topK, semanticRerank: true })
      .then(r => r.results),
});
```

Additionally, each Lambda's CDK IAM policy must include `bedrock:InvokeModel` on the Cohere v4 EU embedding profile (for the embedBatch call inside hybridQuery) and `secretsmanager:GetSecretValue` for `AZURE_SEARCH_SECRET_ARN`.

**5 human-verification items** are required for the 5 SCs whose success is measurable only under live production load (AGT-06 quality acceptance, AGT-04 p95 latency, MEM-04 p95 at 100k rows, INF-10 cost per call, SC7 cache hit rate). These are expected items per the phase design — the gate verifier marks them as HUMAN and the evidence template provides structure for Kevin to fill in post-deploy.

---

_Verified: 2026-04-25T00:13:04Z_
_Verifier: Claude (gsd-verifier)_
