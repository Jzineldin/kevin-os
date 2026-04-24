# Phase 6: Granola + Semantic Memory — Context

**Gathered:** 2026-04-24
**Status:** Ready for planning
**Branch:** phase-02-wave-5-gaps (writing directly to main tree, no worktree)

<domain>
## Phase Boundary

The "quality multiplier" phase. Every preceding agent (triage, voice-capture, entity-resolver) and every later agent (email-triage in Phase 4, content-writer in Phase 8, lifecycle automations in Phase 7) gains full entity-dossier awareness via an explicit `loadContext()` helper called before each Bedrock invocation. Granola transcripts auto-flow into Command Center action items + entity mention events. Azure AI Search becomes the semantic substrate for hybrid retrieval. A per-entity timeline materialised view + a Postgres-backed dossier cache make the dashboard reads cheap. Vertex Gemini 2.5 Pro is wired in europe-west4 for the rare "load full dossier" case.

**In scope:**
- CAP-08 + AUTO-05: Granola poller Lambda on EventBridge Scheduler every 15 min Europe/Stockholm; Notion Transkripten DB query with `last_edited_time` filter (D-08); idempotency on `transcript_id`.
- AGT-06: Transcript-extractor Lambda — Sonnet 4.6 via direct AnthropicBedrock SDK (NOT Agent SDK); Bedrock `tool_use` for structured output; writes Command Center rows in Kevin's Swedish schema (Uppgift / Typ / Prioritet / Anteckningar); writes mention_events; emits `entity.mention.detected` for the Phase 2 resolver.
- MEM-03: Azure AI Search hybrid index population — 4 dedicated indexer Lambdas (entities / projects / transcripts / daily_brief) on per-type EventBridge Scheduler; shared `@kos/azure-search` query helper for hybrid BM25 + vector + semantic-rerank; <600 ms p95 query budget.
- AGT-04: `packages/context-loader/` — explicit `loadContext({ entityIds, agentName, captureId }): Promise<ContextBundle>` helper. Returns Kevin Context (always) + per-entity dossiers + recent mention_events + Azure semantic top-10 + linked projects + last 5 document_versions (when they exist). Wired into triage, voice-capture, entity-resolver, transcript-extractor handlers; Bedrock system prompt receives a markdown dossier block with `cache_control: ephemeral`.
- MEM-04: `entity_timeline` materialized view in Postgres + 5-min EventBridge Scheduler refresh + live overlay query for last-10-min mention_events on hot entities; dashboard `/api/entities/[id]/timeline` returns 50 rows in <50 ms p95 at 100k-row scale.
- INF-10: `services/dossier-loader` Lambda — calls Vertex Gemini 2.5 Pro in europe-west4 with context caching (cachedContent API); triggered ONLY by an explicit `context.full_dossier_requested` EventBridge detail-type; <$1.50 avg per call; <10 s p95; output cached to `entity_dossiers_cached` table keyed by `entity_id + last_touch_hash`.
- Postgres-backed dossier cache (D-07 below) with `mention_events` insert trigger for invalidation; >80% hit rate target.

**Out of scope:**
- Email pipeline (Phase 4) — though AGT-04 will be consumed by email-triage once Phase 4 ships.
- Dashboard UI changes beyond the timeline route — handled in Phase 3.
- Lifecycle automation schedules (morning brief / day close) — Phase 7.
- Any agent feature for Phase 8 / 9 / 10.
- Live cloud mutations (no AWS deploy, no Azure provisioning, no Vertex setup, no Notion bootstrap). Operator runbooks documented per plan.
- `MEM-05` document version tracker (Phase 8).

</domain>

<decisions>
## Implementation Decisions

These are the authoritative locks for Phase 6. Source artefacts:
- `<artifacts_to_produce>` recommended defaults from the orchestrator brief
- The 2026-04-23 architectural revision of Locked Decision #3 (direct AnthropicBedrock SDK, not Agent SDK)
- The Phase 2 patterns that proved out in production (triage / voice-capture / entity-resolver Lambdas, @kos/resolver pattern, integrations-* CDK helpers)
- The single-user, ADHD-compatible, calm-by-default product constraints from PROJECT.md / CLAUDE.md

User decisions are deliberately defaulted-by-Claude here per orchestrator instructions ("treat these as locked-in defaults given Kevin is asleep; pick the recommended default and document rationale"). All four gray areas resolved with the recommended defaults.

### Granola pull surface

- **D-01 [LOCKED — recommended default]**: Granola input source is the existing **Notion Transkripten DB**, not the Granola REST API. Phase 2 Plan 02-09 (`bulk-import-granola-gmail`) already proved the Transkripten path works (single Notion token; no separate `kos/granola-api-key`). Phase 6 reuses the same Notion client, the same secret, and the same DB ID resolution pattern. Granola REST stays specced-only — would only be revisited if the Transkripten DB lag becomes intolerable, and even then via a separate plan.
- **D-02 [LOCKED — recommended default]**: Poll cadence = **every 15 min**, schedule expression `rate(15 minutes)`, timezone `Europe/Stockholm`, `flexibleTimeWindow: OFF`. Matches AUTO-05 exactly. Polling uses `last_edited_time` filter against a per-DB cursor in `notion_indexer_cursor` (existing table, dbKind = `transkripten`); on first run the cursor is initialised to `now() - 24h` so backlog from the prior day catches up without crushing Notion API quotas.
- **D-03 [LOCKED]**: Idempotency key = `transcript_id` (Notion page id). The granola-poller writes `agent_runs` rows keyed by `capture_id := transcript_id` + `agent_name = 'granola-poller'` and short-circuits if a prior `status='ok'` row exists for the same id. Mirrors the D-21 pattern from Phase 2.

### Granola → extractor handoff event

- **D-04 [LOCKED]**: New EventBridge detail-type `transcript.available` on the existing `kos.capture` bus. Schema (added to `packages/contracts/src/events.ts`):
  ```
  { capture_id: ULID, transcript_id: NotionPageId, title: string,
    transcript_text: string (≤ 64 KB), recorded_at: ISO, attendees?: string[],
    notion_url: string }
  ```
  `kos.capture` (not `kos.agent`) because this is a capture event semantically equivalent to "voice memo arrived" — a new piece of raw input enters the system. Downstream EventBridge rule on `transcript.available` invokes `services/transcript-extractor`.

### Transcript-extractor agent shape

- **D-05 [LOCKED — recommended default]**: AGT-06 extraction output format = **Bedrock `tool_use` (structured tools)**. Defines a single tool `record_transcript_extract` with a typed JSON schema for `{ action_items: ActionItem[], entity_mentions: EntityMention[], summary: string }`. Validated server-side via Zod (mirrors Phase 2 entity-resolver pattern). Rationale: matches the AnthropicBedrock direct-SDK pattern from Phase 2; cleaner than XML/markdown parsing; tool_use is first-class on Bedrock for both Sonnet 4.6 and Haiku 4.5.
- **D-06 [LOCKED]**: Model = **Sonnet 4.6** on the EU inference profile (`eu.anthropic.claude-sonnet-4-6`). Sonnet is the right tier for transcript reading (long context, accurate extraction) — Haiku miscount entity mentions on 30-min transcripts. Cost budget per transcript: ≤ $0.10 average (Sonnet 4.6 input ≈ $3/M tokens; a 30-min transcript ≈ 7-15k input tokens + 2k output ≈ $0.04–$0.08).
- **D-07 [LOCKED]**: Command Center write target schema = Kevin's Swedish schema `Uppgift / Typ / Prioritet / Anteckningar` (matches the Phase 2 voice-capture `voice-capture/src/notion.ts` pattern). Action items prefixed with `[Granola: <transcript title>]` in `Anteckningar` for provenance. Status defaults to `Att göra` (To Do); Kevin curates manually.
- **D-08 [LOCKED]**: For each `entity_mentions[i]` extracted, the extractor emits `entity.mention.detected` to `kos.agent` (existing schema, unchanged) — the Phase 2 entity-resolver Lambda picks them up unchanged. No bypass of the resolver's three-stage pipeline.

### Azure AI Search topology

- **D-09 [LOCKED — recommended default]**: **One indexer Lambda per content type**, not a single unified indexer. Four Lambdas:
  - `services/azure-search-indexer-entities` — pulls from `entity_index` (delta on `updated_at` cursor).
  - `services/azure-search-indexer-projects` — pulls from `project_index` (delta on `updated_at`).
  - `services/azure-search-indexer-transcripts` — pulls from new `transcripts_indexed` table populated by transcript-extractor.
  - `services/azure-search-indexer-daily-brief` — placeholder Lambda + schedule; Phase 7 populates the source table. Wave-3 Lambda is built but has zero documents until Phase 7 lands.
  Per-type schedulers (5 min for entities/projects, 5 min for transcripts, 15 min for daily brief). Rationale: cleaner separation, smaller blast radius on bugs, per-type backoff if Azure throttles (RU/min ceilings on Basic tier), independent operator restart, independent Sentry breadcrumbs.
- **D-10 [LOCKED]**: Index reuse = **single `kos-memory-v1` index** (already created in Phase 1 Plan 01-05, recreated to 1024 dims in Phase 2 Plan 02-03 / Azure recreate). All four indexer Lambdas write into the same index; documents distinguished by `source` field (`entity` / `project` / `transcript` / `daily_brief`) and `entity_ids` (Collection(String)) for relational lookup. Schema additions deferred to operator runbook (uses the same `wireAzureSearch` schema-fingerprint mechanism — schema bump → CustomResource diff → operator runs `cdk deploy`).
- **D-11 [LOCKED]**: Hybrid query helper = `packages/azure-search/src/query.ts` exporting `hybridQuery({ query, entityIds?, topK = 10, semanticRerank = true })`. One Azure REST call per invocation: BM25 (text) + vector (Cohere v4 embedding of query) + RRF merge + `kos-semantic` reranker. Returns `{ results: SearchHit[], elapsedMs: number, queryId: string }`. Cohere v4 is reused via `@kos/resolver` `embedBatch(['<query>'], 'search_query')`.

### Auto-context loader (AGT-04) shape — REDESIGNED per 2026-04-23 revision

- **D-12 [LOCKED]**: AGT-04 ships as a **synchronous library helper** in `packages/context-loader/` (NOT an Agent-SDK pre-call hook, NOT a separate Lambda). Public surface:
  ```
  loadContext({ entityIds: string[], agentName: string, captureId: string,
                kevinContextOnly?: boolean }): Promise<ContextBundle>
  ```
  Where `ContextBundle = { kevinContext: string, entityDossiers: Dossier[], recentMentions: MentionRow[], semanticChunks: SearchHit[], linkedProjects: ProjectRow[], assembledMarkdown: string, elapsedMs: number, cacheHit: boolean }`.
- **D-13 [LOCKED]**: Each consumer Lambda (triage, voice-capture, entity-resolver, transcript-extractor; later email-triage in Phase 4 etc.) calls `loadContext()` BEFORE invoking Bedrock. The returned `assembledMarkdown` is inserted as a third element in the system prompt array (after the BASE prompt and the Kevin Context block) with `cache_control: { type: 'ephemeral' }`. Pattern follows the existing triage / disambig wiring exactly (cache_control on each text segment).
- **D-14 [LOCKED]**: Kevin Context is ALWAYS included (no `kevinContextOnly: false` skip path) — the existing `loadKevinContextBlock(ownerId)` helper in `services/triage/src/persist.ts` is moved into `packages/context-loader/src/kevin.ts` so all consumers share one implementation. Phase 6 deletes the duplicated copies in triage/voice-capture/entity-resolver `persist.ts` and replaces with `import { loadKevinContextBlock } from '@kos/context-loader'`.
- **D-15 [LOCKED]**: Performance budget for `loadContext()` = **<800 ms p95** end-to-end including: Postgres entity-dossier query, recent mentions query, Azure hybrid query, dossier cache read. Cache hit path target <50 ms p95. The 800 ms budget is consumed in parallel: Promise.all of {pg dossier, pg mentions, pg projects, azure query, dossier cache}.
- **D-16 [LOCKED]**: When `entityIds` is empty (e.g., triage of a fresh inbound text where no entity has been resolved yet), `loadContext()` returns a degraded bundle = `{ kevinContext, entityDossiers: [], recentMentions: [], semanticChunks: <azure semantic search on raw input text top-5>, linkedProjects: [], ... }`. The semantic chunk path makes triage smarter even without resolved entities.

### Dossier cache substrate

- **D-17 [LOCKED — recommended default]**: Dossier cache lives in **Postgres** as a new table `entity_dossiers_cached`, NOT ElastiCache Serverless. Schema:
  ```
  entity_dossiers_cached(
    entity_id uuid PRIMARY KEY REFERENCES entity_index(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL,
    last_touch_hash text NOT NULL,    -- SHA-256(name || last_touch || mention_events.max(occurred_at))
    dossier_markdown text NOT NULL,   -- assembled bundle (Kevin Context excluded — added at call time)
    semantic_chunks jsonb NOT NULL,   -- snapshot of last azure top-10 hits (entity scoped)
    cached_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,  -- cached_at + 1 hour (TTL belt; trigger is the primary invalidation)
    last_used_at timestamptz NOT NULL DEFAULT now()
  )
  ```
  Rationale: Phase 1 RDS Proxy already handles this access pattern; ElastiCache adds a new service ($10/mo per the brief but more significantly a new ops surface) for a single-user system; Postgres lookup latency is well under the budget. Revisit only if cache hit rate stays <50% after 1 production week, or if pg load from cache reads is observed >5% of total RDS CPU.
- **D-18 [LOCKED]**: Invalidation = **trigger-based**. New SQL trigger `entity_dossiers_cached_invalidate` on `mention_events` AFTER INSERT — when a row inserts with non-null `entity_id`, DELETE FROM `entity_dossiers_cached` WHERE `entity_id` = NEW.entity_id. Cheap, immediate, no race with reads (the next read recomputes). Plus the 1-hour TTL as a belt.
- **D-19 [LOCKED]**: Cache key = `entity_id` (PK). The `last_touch_hash` field is a verification stamp checked on read — if hash differs from current entity row, treat as miss (defensive against missed trigger fires, e.g., after migrations). Hit rate target: **>80%** in steady state.

### Gemini full-dossier path (INF-10)

- **D-20 [LOCKED — recommended default]**: Gemini invocation trigger = **new EventBridge detail-type `context.full_dossier_requested` on `kos.agent` bus**, NOT a flag on `entity.mention.detected`. Rationale: separate detail-type makes cost monitoring obvious (one CloudWatch metric per detail-type), keeps the fast path clean, allows distinct DLQ + retry policy for the expensive call, and mirrors how the rest of the event taxonomy is structured.
- **D-21 [LOCKED]**: `services/dossier-loader` Lambda = single subscriber to `context.full_dossier_requested`. Uses `@google-cloud/vertexai` v1.x; region `europe-west4`; model `gemini-2.5-pro`; context caching via `cachedContent` API (24-h TTL on the cached prefix; Kevin Context + entity dossier base block cached). Output written to `entity_dossiers_cached.dossier_markdown` with a special `last_touch_hash = 'gemini-full:' || sha256(...)` so the next AGT-04 read picks it up.
- **D-22 [LOCKED]**: Trigger surface in v1 = **operator-only** (no automatic trigger from voice-capture / triage). A future plan can add an automatic trigger when an entity hasn't had a Gemini-cached dossier in N days; not in scope for Phase 6. Trigger script `scripts/trigger-full-dossier.mjs` (operator runbook) emits the event on demand for testing + manual invocation.
- **D-23 [LOCKED]**: GCP credentials = new Secrets Manager entry `kos/gcp-vertex-sa` containing the service-account JSON for a project with Vertex AI enabled in europe-west4. Operator pre-creates the SA out-of-band; Phase 6 docs the SA roles required (`roles/aiplatform.user`).

### Entity timeline materialized view (MEM-04)

- **D-24 [LOCKED]**: Materialized view name = `entity_timeline_mv`. Migration 0010 creates:
  ```
  CREATE MATERIALIZED VIEW entity_timeline_mv AS
  SELECT me.entity_id, me.id AS event_id, me.source, me.context,
         me.occurred_at, me.created_at, me.capture_id
  FROM mention_events me
  WHERE me.entity_id IS NOT NULL
  ORDER BY me.entity_id, me.occurred_at DESC;
  CREATE UNIQUE INDEX entity_timeline_mv_pk ON entity_timeline_mv(event_id);
  CREATE INDEX entity_timeline_mv_by_entity_time ON entity_timeline_mv(entity_id, occurred_at DESC);
  ```
- **D-25 [LOCKED]**: Refresh strategy = `REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline_mv` every 5 min via EventBridge Scheduler. CONCURRENTLY required to avoid lock-out of dashboard reads; needs the unique index above (which we have). Refresh Lambda = `services/entity-timeline-refresher` (small Lambda; calls one SQL via RDS Proxy IAM auth; <2 s expected; 30 s timeout).
- **D-26 [LOCKED]**: Live overlay = dashboard `/api/entities/[id]/timeline` does:
  ```
  SELECT * FROM entity_timeline_mv WHERE entity_id = $1 ORDER BY occurred_at DESC LIMIT 50
  UNION ALL
  SELECT entity_id, id AS event_id, source, context, occurred_at, created_at, capture_id
    FROM mention_events
    WHERE entity_id = $1 AND occurred_at > now() - interval '10 minutes'
    AND id NOT IN (SELECT event_id FROM entity_timeline_mv WHERE entity_id = $1)
  ORDER BY occurred_at DESC LIMIT 50;
  ```
  Returns at most 50 rows. Read budget <50 ms p95 at 100k mention_events.

### Cost discipline (binding)

- **D-27 [LOCKED]**: **Phase 6 net-new monthly cost envelope target ≤ $80/mo at production volume**:
  - Azure semantic reranker: ~$30-50/mo (Basic tier free for first 1000 reranker calls/month; Kevin's volume sits comfortably in the chargeable band — budget assumes 5k reranks/mo).
  - Vertex Gemini 2.5 Pro: ~$10-30/mo (operator-triggered only in v1; <100 invocations/mo expected).
  - Postgres dossier cache: $0 (existing RDS).
  - EventBridge schedulers: ~$1.
  - Lambda invocations: <$2 (Granola poll = 96/day; indexer poll = 288/day each × 4 = 1152/day; refresh = 288/day).
  No ElastiCache. No new vector store. No always-on Gemini.

### Sentry / Langfuse

- **D-28 [LOCKED]**: Every Phase 6 Lambda (granola-poller, transcript-extractor, 4 azure-search-indexer-*, entity-timeline-refresher, dossier-loader) wires `initSentry` + `tagTraceWithCaptureId(capture_id)` per the Plan 02-10 pattern. transcript_id is used as capture_id for granola-poller + transcript-extractor (Phase 2 contract: capture_id is whatever ULID-or-equivalent that uniquely identifies the originating event).

### Claude's Discretion

- Lambda memory/timeout sizing within the established defaults (granola-poller = 512 MB / 1 min; transcript-extractor = 1 GB / 5 min; indexer Lambdas = 512 MB / 2 min; refresher = 256 MB / 30 s; dossier-loader = 1 GB / 10 min).
- Exact Sonnet 4.6 system prompt for transcript-extractor (will be hand-tuned during Phase 6 execution; tool_use schema is fixed by D-05).
- Exact Postgres query plans for context-loader (PG planner choices, materialized view refresh tuning).
- Internal directory layout of `packages/context-loader/` and `packages/azure-search/`.
- Exact Gemini system prompt + cachedContent boundary for dossier-loader (will be tuned for cost).
- Operator runbook formatting + level of detail.

### Folded Todos
None — STATE.md Active Todos are Phase 1 / Phase 4 / Phase 3 concerns; nothing Phase-6-shaped pending.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project definition & scope
- `.planning/PROJECT.md` — KOS vision; **Locked Decision #3 REVISED 2026-04-23** (direct AnthropicBedrock SDK, not Agent SDK; downstream AGT-04 redesign mandatory)
- `.planning/REQUIREMENTS.md` — Phase 6 owns CAP-08, AGT-04, AGT-06, MEM-03, MEM-04, AUTO-05, INF-10
- `.planning/ROADMAP.md` §Phase 6 — goal, 6 success criteria, dependency on Phase 1 + Phase 2
- `.planning/STATE.md` — locked decisions (1–14); #3 supersession noted in PROJECT.md

### Phase 1 carry-forward (artefacts already shipped)
- `.planning/phases/01-infrastructure-foundation/01-05-SUMMARY.md` — Azure AI Search `kos-memory-v1` index live (binary quantization at creation, recreated to 1024 dims in Phase 2 D-06)
- `.planning/phases/01-infrastructure-foundation/01-02-SUMMARY.md` — RDS PostgreSQL 16 + pgvector + RDS Proxy IAM auth pattern
- `.planning/phases/01-infrastructure-foundation/01-03-SUMMARY.md` — 5 EventBridge buses + DLQs + `kos-schedules` group (granola-poller + indexer schedulers + entity-timeline-refresher schedule live here)
- `.planning/phases/01-infrastructure-foundation/01-04-SUMMARY.md` — notion-indexer pattern (Phase 6 mirrors for granola-poller); RDS Proxy connection pattern
- `packages/cdk/lib/stacks/integrations-azure.ts` — pattern for Phase 6's azure-search-indexer wiring (CustomResource fingerprint + KosLambda + grantRead pattern)
- `packages/cdk/lib/stacks/integrations-notion.ts` — pattern for Phase 6's granola-poller scheduler wiring (`CfnSchedule` + scheduler role + `grantInvoke`)

### Phase 2 carry-forward (proven patterns to mirror)
- `.planning/phases/02-minimum-viable-loop/02-VERIFICATION.md` — honest evidence-pattern format; lists Phase 2's lived gaps (M1, INF-08 waiver) and the AnthropicBedrock SDK pivot in commit 460d435
- `services/triage/src/{handler,agent,persist}.ts` — direct AnthropicBedrock pattern; idempotency via agent_runs; tagTraceWithCaptureId; loadKevinContextBlock (to be moved into @kos/context-loader)
- `services/entity-resolver/src/{handler,disambig}.ts` — Sonnet 4.6 pattern; Promise.race timeout; Zod-validated tool output
- `services/voice-capture/src/notion.ts` — Kevin's Swedish CC schema (Uppgift / Typ / Prioritet / Anteckningar) — transcript-extractor mirrors this
- `services/bulk-import-granola-gmail/src/granola.ts` — Notion Transkripten DB id discovery + page reading (granola-poller reuses)
- `packages/resolver/src/{candidates,score,embed,index}.ts` — pattern for `@kos/context-loader` and `@kos/azure-search` library packages (single barrel `index.ts`, named exports, vitest unit tests)
- `services/_shared/{sentry,tracing}.ts` — D-28 instrumentation; every new Phase 6 Lambda imports both
- `packages/db/src/schema.ts` — current Drizzle schema; Phase 6 adds `entity_dossiers_cached` + `transcripts_indexed` tables + `entity_timeline_mv` materialized view in migration 0012 (next-numbered after 0011)

### External specs
- Azure AI Search REST API `2025-09-01` — hybrid query syntax (`vectorQueries` + `semanticConfiguration`) — `https://learn.microsoft.com/en-us/azure/search/search-get-started-vector`
- Azure AI Search hybrid + semantic ranking — `https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview`
- Vertex AI Gemini 2.5 Pro context caching API — `https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview` (cachedContent minimum 32k tokens)
- Vertex AI Gemini 2.5 Pro pricing — `https://cloud.google.com/vertex-ai/generative-ai/pricing` ($1.25/M input <200k, $2.50/M >200k)
- PostgreSQL 16 `REFRESH MATERIALIZED VIEW CONCURRENTLY` — `https://www.postgresql.org/docs/16/sql-refreshmaterializedview.html` (locking semantics)
- Bedrock prompt caching `cache_control: ephemeral` — `https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html`
- Notion `last_edited_time` filter — `https://developers.notion.com/reference/post-database-query-filter` (timestamp filter caveats)
- AnthropicBedrock SDK `tool_use` — `https://docs.anthropic.com/en/api/messages` (tool_choice: auto vs required)

### Project conventions
- `CLAUDE.md` §"Recommended Stack" — Bedrock Sonnet 4.6 + Haiku 4.5; Azure AI Search Basic with binary quantization; Vertex Gemini 2.5 Pro with context caching; pgvector on RDS not Aurora Serverless v2
- `CLAUDE.md` §"What NOT to Use" — exclusion list still binding (no LangGraph, no n8n, no Aurora Serverless v2, no Pinecone, no Supabase Realtime, no Pusher, no AppSync)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `packages/cdk/lib/constructs/kos-lambda.ts` — KosLambda (Node 22 ARM64, externalised `@aws-sdk/*`, 30-day log retention, `createRequire` banner). Every Phase 6 Lambda uses this — same constructor signature.
- `packages/cdk/lib/stacks/events-stack.ts` — 5 `kos.*` buses + DLQs already live. New rules simply target the relevant bus (`kos.capture` for `transcript.available`, `kos.agent` for `entity.mention.detected` + `context.full_dossier_requested`).
- `packages/cdk/lib/stacks/integrations-stack.ts` — thin orchestration class. Phase 6 adds three helpers: `wireGranolaPipeline`, `wireAzureSearchIndexers`, `wireDossierLoader` — each in its own file (`integrations-granola.ts`, `integrations-azure-indexers.ts`, `integrations-vertex.ts`) to mirror the Phase 1/2 split-by-helper pattern.
- `services/notion-indexer/` — existing Notion client wiring + RDS Proxy IAM auth pattern; granola-poller copies the connection-bootstrap shape.
- `services/bulk-import-granola-gmail/src/granola.ts` — Transkripten DB ID discovery + page-content reading pattern; granola-poller reuses.
- `services/azure-search-bootstrap/src/index-schema.ts` — `kos-memory-v1` schema; Phase 6 may need to extend the schema with new fields (e.g., `transcript_title`, `recorded_at`); change goes through schema-fingerprint mechanism so the existing CustomResource handles re-PUT idempotently.
- `packages/resolver/src/embed.ts` — Cohere v4 embedBatch (`eu.cohere.embed-v4:0`); reused in Phase 6 by `@kos/azure-search` for query-time embedding (`'search_query'` input type).
- `services/triage/src/persist.ts::loadKevinContextBlock` — moves to `packages/context-loader/src/kevin.ts` in Phase 6 Wave 0.
- `services/_shared/{sentry,tracing}.ts` — D-28 wiring template.

### Established Patterns

- **Per-plan helper file** in `packages/cdk/lib/stacks/` — Phase 6 follows: `integrations-granola.ts` (Plan 06-01), `integrations-azure-indexers.ts` (Plan 06-03), `integrations-vertex.ts` (Plan 06-05).
- **`KosLambda` + per-helper wiring** — Phase 6 mirrors Plan 01-04's `wireNotionIntegrations` shape exactly (props interface, return interface, scheduler role pattern, `grantInvoke` per Lambda, IAM `rds-db:connect` for DB callers).
- **Drizzle SQL migrations** hand-authored — Phase 6 adds `0012_phase_6_dossier_cache_and_timeline_mv.sql` (single file, multiple statements; matches the Phase 2 multi-statement style of `0003_cohere_embedding_dim.sql`).
- **IAM grants** — belt-and-braces with explicit `PolicyStatement` (Phase 1 retro). `rds-db:connect` on the Proxy DbiResourceId for any Lambda touching the DB. `bedrock:InvokeModel` on the EU inference profile + foundation-model ARNs for Sonnet 4.6 (transcript-extractor) + Cohere v4 (azure-search-indexer-* embedding queries) + Vertex (dossier-loader uses `secretsmanager:GetSecretValue` only — Vertex auth via SA JSON).
- **CustomResource DELETE handlers** echo `event.PhysicalResourceId` (Phase 1 retro).
- **Lambdas in private isolated subnets need Secrets Manager VPC interface endpoint** — already in place from Phase 2 wave-5; granola-poller + transcript-extractor + dossier-loader land in `PRIVATE_WITH_EGRESS` subnets (granola-poller needs Notion API; transcript-extractor needs Bedrock; dossier-loader needs Vertex), so they get `vpc + securityGroups + privateSubnets` per the Phase 2 wave-5 pattern.
- **Schedule expression timezone** = `Europe/Stockholm` always; `flexibleTimeWindow: OFF` always; `state: 'ENABLED'`.
- **Notion DB IDs** loaded from `scripts/.notion-db-ids.json` (existing `loadNotionIds()` helper in `integrations-notion.ts`); Phase 6 extends the JSON schema to include `transkripten` (the existing `bulk-import-granola-gmail` flow already discovers this dynamically — Phase 6 promotes it to a stable file entry so the granola-poller has a deterministic DB ID at synth time).

### Integration Points

- `kos.capture` bus — granola-poller publishes `transcript.available` here.
- `kos.agent` bus — transcript-extractor publishes `entity.mention.detected` here (existing schema, unchanged); dossier-loader subscribes to `context.full_dossier_requested` here.
- `entity_index.embedding` (1024-dim Cohere v4) — read by `@kos/azure-search` to populate Azure documents; read by AGT-04 dossier path.
- `kevin_context` table — read by `@kos/context-loader` (`loadKevinContextBlock`).
- `notion_indexer_cursor` — granola-poller writes new row with `dbKind = 'transkripten'`.
- New tables (Wave 0 migration 0012): `entity_dossiers_cached`, `transcripts_indexed` (records each transcript that hit Azure to support the indexer cursor), and the materialized view `entity_timeline_mv`.
- New Notion DB ID needed in `scripts/.notion-db-ids.json`: `transkripten` (already discoverable via `bulk-import-granola-gmail` — Phase 6 migrates it to a stable bootstrap entry).

</code_context>

<specifics>
## Specific Ideas

- **Quality-multiplier ordering**: Wave 1 = granola-poller. Wave 2 = transcript-extractor + azure-search-indexer (parallel; no file conflict). Wave 3 = entity-timeline-mv migration + entity-timeline-refresher + context-loader + dossier-loader (entity-timeline + context-loader can run parallel; dossier-loader depends on context-loader's table schema for cache writes — same wave but file-distinct). Wave 4 = E2E gate verifier. The brief recommended Wave 3 split (timeline first, then context+dossier) — accepted as planned in 06-04 vs 06-05.
- **Transcript-extractor input length**: Granola transcripts can be long (90 min meeting ≈ 30k tokens). Sonnet 4.6 supports 200k context; Phase 6 budget is one transcript per call, no chunking. If a transcript exceeds 100k tokens (rare), split-and-summarise pre-pass — but no need to build that until empirically required.
- **Notion `last_edited_time` filter caveats**: Notion returns `last_edited_time` at minute granularity. Polling every 15 min with a `last_edited_time > cursor` filter is safe; Phase 6 sets the cursor to `now() - 15 minutes` after each successful run to avoid the off-by-one race. Same pattern Phase 1 notion-indexer uses for entities/projects.
- **Bedrock `cache_control: ephemeral` placement**: per the existing triage agent pattern, every text segment in the system prompt array gets its own cache_control marker. The dossier markdown block is the third segment (BASE prompt → Kevin Context → dossier) so Kevin Context cache stays warm across consumers, and the dossier varies per call.
- **Hybrid query `topK` rationale**: 50 documents to BM25 + vector; RRF merges to 20; semantic reranker promotes top 10 to caller. This is the Azure-recommended ratio (50→10 for `kos-semantic` config; reranker max input is 50 docs).
- **AGT-04 "no entityIds" path** (D-16): triage receives a fresh inbound capture with no resolved entities. The degraded bundle still calls Azure semantic search on the raw input text — top 5 chunks become `semanticChunks`. Triage's prompt sees "Possibly related context (low confidence): <chunks>" — pure assistive context, no decision-forcing.
- **Materialized view CONCURRENTLY refresh**: requires the unique index on `event_id`. Phase 6 migration 0012 creates the index in the same transaction as the MV; refresh CONCURRENTLY then becomes safe from lock-out. Refresh duration <2 s expected at 100k rows; 30 s timeout is generous.
- **Dossier cache `last_touch_hash`**: SHA-256 over a deterministic string `entity.name || entity.last_touch.toISOString() || mention_max(entity_id)`. Recomputed on read; if mismatch, treat as miss. Cheap (single SQL query for max(occurred_at)).
- **Gemini cost discipline**: each `cachedContent` reuse costs 25% of standard input tokens. Operator-only invocation in v1 (D-22) means absolute cost ceiling is bounded by Kevin's manual triggers. Future-phase auto-trigger gets its own budget alarm.
- **Phase 4 dependency**: email-triage agent (Phase 4) will import `@kos/context-loader`. Phase 6 must publish the package + name correctly so Phase 4 can wire it without Phase 4 needing to retroactively update Phase 6 code. Naming: `@kos/context-loader`, default export `loadContext`.
- **No dashboard UI changes in scope** beyond the timeline route update — Phase 3 already owns the dashboard surfaces; Phase 6 just augments the entity-page data source.

</specifics>

<deferred>
## Deferred Ideas

- **Auto-trigger Gemini full-dossier** when stale (e.g., last cache > 7 days) — operator-only in v1 per D-22; phase 7+ may auto-trigger as part of weekly review.
- **Granola REST API** — Transkripten path is sufficient; revisit if lag intolerable.
- **ElastiCache Serverless dossier cache** — Postgres path picked first (D-17); revisit if cache-hit metrics fall below 50% in production or pg load suffers.
- **Per-content-type Azure indexes** — single index reused (D-10); split only if write contention or schema divergence demands it.
- **Real-time MV refresh** (LISTEN/NOTIFY trigger) — 5-min cron is sufficient given the 10-min live overlay; trigger-based refresh is a Phase 7+ concern if dashboard freshness ever becomes the bottleneck.
- **Cross-region Vertex failover** — single region (europe-west4); GCP credit budget covers this for 12+ months.
- **Granola-poller backfill** of all-time transcripts — only the 24-h backlog on first run; ENT-06 (Phase 2) already handled the 90-day backfill into KOS Inbox. Re-running ENT-06 is the Phase 6 backfill story (operator runbook).
- **Action-item triage** (urgent vs not-urgent classification on Granola action items) — currently every extracted action item lands in Command Center with default `Att göra` status; triage classification is Phase 7's lifecycle automation territory.
- **Document version tracker (MEM-05)** — Phase 8.

### Reviewed Todos (not folded)
None — STATE.md Active Todos are Phase 1 / Phase 4 / Phase 3 concerns; nothing Phase-6-shaped pending.

</deferred>

---

*Phase: 06-granola-semantic-memory*
*Context gathered: 2026-04-24 (no live discussion — defaults locked per orchestrator brief)*
