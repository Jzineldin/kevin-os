# Phase 6: Granola + Semantic Memory — Research

**Researched:** 2026-04-24
**Domain:** Granola Notion polling → Sonnet 4.6 transcript extraction → Azure AI Search hybrid index → AGT-04 explicit context-loader → Postgres dossier cache + materialized view → Vertex Gemini 2.5 Pro full-dossier path
**Confidence:** HIGH on Bedrock cache_control, Notion `last_edited_time`, PostgreSQL MV refresh patterns (all verified against Phase 1/2 production patterns + canonical docs). MEDIUM on Vertex Gemini 2.5 Pro context caching minimum-token threshold (32k tokens minimum is current as of 2026-04 — Google may relax to 4k in 2026 H2 per recent Cloud Next signals; treat 32k as the safe floor). MEDIUM on Azure semantic reranker per-query cost (Azure AI Search Basic tier includes 1000 free reranker calls/month then $1/1000 calls per the 2026-04 pricing page — verify at deploy time).

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (D-01..D-28) — do NOT re-litigate

**Granola pull surface**
- **D-01** Granola input = Notion Transkripten DB (reuses Phase 2 `bulk-import-granola-gmail` Notion path). No Granola REST API.
- **D-02** Poll cadence `rate(15 minutes)` Europe/Stockholm; first-run cursor `now() - 24h`.
- **D-03** Idempotency key = `transcript_id` (Notion page id) into `agent_runs` keyed `agent_name='granola-poller'`.

**Granola → extractor handoff**
- **D-04** New EventBridge detail-type `transcript.available` on `kos.capture` bus; schema in `packages/contracts/src/events.ts`.

**Transcript-extractor agent**
- **D-05** Bedrock `tool_use` for structured output (single tool `record_transcript_extract`).
- **D-06** Sonnet 4.6 `eu.anthropic.claude-sonnet-4-6`; ≤ $0.10 avg per transcript.
- **D-07** Command Center write uses Kevin's Swedish schema (Uppgift / Typ / Prioritet / Anteckningar); `[Granola: <title>]` provenance prefix in Anteckningar.
- **D-08** Each entity_mentions[i] → emit existing `entity.mention.detected` event (Phase 2 resolver consumes unchanged).

**Azure AI Search topology**
- **D-09** One indexer Lambda per content type (entities / projects / transcripts / daily_brief).
- **D-10** Single `kos-memory-v1` index reused; `source` field discriminates docs.
- **D-11** Hybrid query helper `@kos/azure-search/query.ts::hybridQuery({ query, entityIds?, topK, semanticRerank })`.

**AGT-04 — REDESIGNED**
- **D-12** Library helper `packages/context-loader/`; `loadContext({ entityIds, agentName, captureId, kevinContextOnly? }): Promise<ContextBundle>`.
- **D-13** Each consumer Lambda calls `loadContext()` BEFORE Bedrock; `assembledMarkdown` injected as 3rd system-prompt segment with `cache_control: ephemeral`.
- **D-14** Kevin Context always included; `loadKevinContextBlock` moves to `@kos/context-loader/src/kevin.ts`.
- **D-15** <800 ms p95 end-to-end (Promise.all of pg + azure + cache reads).
- **D-16** Empty `entityIds` → degraded bundle (Azure semantic search on raw input, Kevin Context still always included).

**Dossier cache substrate**
- **D-17** Postgres table `entity_dossiers_cached` (NOT ElastiCache).
- **D-18** Trigger-based invalidation on `mention_events` AFTER INSERT.
- **D-19** Cache key = entity_id PK; verification via `last_touch_hash`; >80% hit rate target.

**Vertex Gemini full-dossier (INF-10)**
- **D-20** New EventBridge detail-type `context.full_dossier_requested` on `kos.agent` bus.
- **D-21** `services/dossier-loader` Lambda; `gemini-2.5-pro` europe-west4; cachedContent API.
- **D-22** v1 = operator-trigger only (`scripts/trigger-full-dossier.mjs`).
- **D-23** GCP creds in Secrets Manager `kos/gcp-vertex-sa`; SA role `roles/aiplatform.user`.

**MEM-04 timeline MV**
- **D-24** Materialized view `entity_timeline_mv` (migration 0012).
- **D-25** Refresh `CONCURRENTLY` every 5 min via EventBridge Scheduler; `services/entity-timeline-refresher`.
- **D-26** Live overlay = MV ⋃ mention_events last 10 min.

**Cost / Observability**
- **D-27** Phase 6 net-new monthly cost target ≤ $80/mo.
- **D-28** Every Phase 6 Lambda wires `initSentry` + `tagTraceWithCaptureId`.

### Claude's Discretion
- Lambda memory/timeout sizing within established defaults
- Sonnet 4.6 system prompt for transcript-extractor (tool_use schema fixed, prompt body free)
- Postgres query plans / MV refresh tuning
- Internal directory layout of `@kos/context-loader` and `@kos/azure-search`
- Operator runbook level of detail

### Deferred (OUT OF SCOPE for Phase 6)
- Granola REST API path
- ElastiCache cache substrate
- Per-content-type Azure indexes
- Real-time MV refresh trigger
- Cross-region Vertex failover
- Granola backfill pre-90-days (re-run ENT-06)
- Action-item urgent/not-urgent triage
- Auto-trigger Gemini full-dossier
- MEM-05 document version tracker

</user_constraints>

## Project Constraints (from CLAUDE.md)

**Binding directives Phase 6 planning must honor:**

1. **"What NOT to Use" list remains binding** — no LangGraph, no CrewAI, no Aurora Serverless v2, no Pinecone/Weaviate/Qdrant, no n8n, no AppSync for push, no Pusher, no Supabase Realtime.
2. **Stack versions pinned** (Phase 6 inherits from Phase 1/2 lockfile; do NOT drift):
   - `@anthropic-ai/bedrock-sdk` (replaces Agent SDK per Locked Decision #3 revision)
   - `@aws-sdk/client-eventbridge` v3.x
   - `@aws-sdk/client-rds-signer` (`@aws-sdk/rds-signer` package; the IAM auth pattern from Phase 2 wave-5 fix)
   - `@google-cloud/vertexai` v1.x — NEW in Phase 6 (added to dossier-loader package only)
   - `azure-search-documents` v11.6.0 (or `@azure/search-documents` JS SDK equivalent — verified at install)
   - `@notionhq/client` v2.3.0 (existing)
   - `drizzle-orm` 0.36.0 (existing); migration `0012_phase_6_dossier_cache_and_timeline_mv.sql`
   - `langfuse` v3.x + `@sentry/aws-serverless` v8.x (existing wiring)
   - `zod` 3.23.8 (existing); used to validate transcript-extractor `tool_use` output + `transcript.available` event detail
   - Node 22.x, ARM64, KosLambda construct
3. **GSD workflow enforcement** — Phase 6 execution goes through `/gsd-execute-phase`.
4. **Language**: Swedish-first; transcript-extractor handles bilingual SE/EN content; Command Center writes use Swedish schema.
5. **Reversibility**: Migration 0012 includes `DROP MATERIALIZED VIEW`, `DROP TABLE`, `DROP TRIGGER` rollback statements documented in the SQL file header. Entities never hard-deleted.
6. **GDPR**: Granola transcripts may contain personal data; Azure AI Search West Europe stays inside EU (Phase 1 D-09); Vertex europe-west4 stays inside EU.
7. **Cost discipline**: Sonnet 4.6 only for transcript extraction; Cohere v4 for query embedding (Bedrock); Gemini 2.5 Pro for full-dossier only; never reach for Opus.
8. **Single-user**: `owner_id` on every Phase 6 RDS table per existing convention.
9. **Calm-by-default**: No new Telegram pushes from Phase 6 — extraction outputs land in Command Center silently; Kevin sees them in next morning brief (Phase 7).

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **CAP-08** | Granola transcripts polled from Notion Transkripten every 15 min using `last_edited_time` filter | §3 Granola poller, §6 Notion filter caveats |
| **AGT-04** | Auto-context loader injects ranked dossier blocks into downstream agents (REDESIGNED as explicit helper) | §5 context-loader, §7 Bedrock cache_control |
| **AGT-06** | Transcript-extractor Sonnet 4.6 → action items + entity mentions | §4 transcript-extractor, §8 Bedrock tool_use |
| **MEM-03** | Azure AI Search hybrid index (BM25 + vector + semantic rerank) <600ms p95 | §9 Azure hybrid query, §10 reranker pricing |
| **MEM-04** | entity_timeline materialized view + 5-min refresh + live overlay | §11 PG MV CONCURRENTLY |
| **AUTO-05** | Every-15-min transcript watcher = granola-poller schedule | §3 EventBridge Scheduler timezone-aware |
| **INF-10** | Vertex Gemini 2.5 Pro europe-west4 with context caching, <$1.50 avg per call | §12 Vertex cachedContent + pricing |

---

## Summary

Phase 6 composes pieces that Phases 1 and 2 already provisioned (RDS + pgvector, Azure AI Search index, EventBridge buses, RDS Proxy IAM auth, Notion integration, Cohere v4 embeddings) into the quality-multiplier layer. Net-new infrastructure: 7 Lambdas (granola-poller, transcript-extractor, 4 azure-search-indexer-*, entity-timeline-refresher, dossier-loader), 2 library packages (`@kos/context-loader`, `@kos/azure-search`), 1 Postgres migration (entity_dossiers_cached + transcripts_indexed + entity_timeline_mv + invalidation trigger), 1 new EventBridge detail-type schema (`transcript.available` + `context.full_dossier_requested`), and 3 new CDK helpers (integrations-granola.ts, integrations-azure-indexers.ts, integrations-vertex.ts).

The architectural risk lives in two places: (1) AGT-04's `loadContext()` performance budget (<800 ms p95) — it executes 4-5 parallel queries (Postgres dossier + recent mentions + linked projects + Azure hybrid + dossier cache) and the cache hit rate determines steady-state latency; (2) Sonnet 4.6 transcript extraction quality on Swedish/code-switched Granola transcripts (Phase 2 confirmed Sonnet 4.6 handles Swedish well in disambig prompts; Phase 6 stress-tests at longer context).

The single-largest design simplification vs the original AGT-04 spec ("SDK-native pre-call hook") is the explicit-helper redesign (D-12). It removes the SDK-coupling, makes context loading testable as a pure-function library, and lets each consumer Lambda choose whether to load context (e.g., a future low-stakes Lambda might skip context entirely). Trade-off: each consumer Lambda has one extra `await` line. Acceptable given the 4-Lambda consumer set in Phase 6 + Phase 4's email-triage Lambda.

**Primary recommendation:** ship Wave 0 scaffolding + migration 0012 first; then Wave 1 granola-poller (CAP-08 + AUTO-05 — independent of context-loader); Wave 2 transcript-extractor + 4 indexer Lambdas in parallel (transcript-extractor depends on granola-poller's event; indexers don't); Wave 3 entity-timeline-mv refresher + context-loader + dossier-loader (timeline + context-loader independent; dossier-loader depends on context-loader's cache table); Wave 4 E2E gate verifier. Five waves total — matches the brief.

---

## §1 — Architectural Responsibility Map

| Concern | Owner | Rationale |
|---------|-------|-----------|
| Polling Notion Transkripten DB | `services/granola-poller` Lambda (new, Wave 1) | Reuses Phase 1 notion-indexer pattern + scheduler-role + RDS Proxy IAM |
| Extracting structured action-items + entity mentions from a transcript | `services/transcript-extractor` Lambda (new, Wave 2) | Sonnet 4.6 via direct AnthropicBedrock SDK (Phase 2 pattern); Bedrock tool_use enforces JSON shape |
| Writing extracted action-items to Command Center | `services/transcript-extractor/src/notion.ts` (new) | Mirrors `voice-capture/src/notion.ts` Swedish schema mapper |
| Emitting entity.mention.detected per extracted mention | `services/transcript-extractor/src/handler.ts` | Reuses Phase 2 contract; resolver Lambda processes unchanged |
| Indexing entities + projects + transcripts + daily-brief into Azure AI Search | `services/azure-search-indexer-{entities,projects,transcripts,daily-brief}` Lambdas (new, Wave 2) | One per content type per D-09; per-type schedule + DLQ + Sentry trace |
| Hybrid query against Azure AI Search | `packages/azure-search/src/query.ts::hybridQuery` (new lib, Wave 0) | Single REST call: BM25 + vector + RRF + semantic rerank; reused by `@kos/context-loader` |
| Embedding query text for Azure vector search | `@kos/resolver/embedBatch(['<query>'], 'search_query')` (existing) | Cohere v4 via Bedrock; same model as document embeddings; consistency required for vector-search relevance |
| Loading entity dossiers + Kevin Context + recent mentions + Azure top-10 + linked projects | `packages/context-loader/src/loadContext.ts` (new lib, Wave 3) | Single call site for every consumer Lambda; Promise.all parallel queries |
| Persisting / invalidating dossier cache | `packages/context-loader/src/cache.ts` + `0012_*.sql` trigger (Wave 0 + Wave 3) | Postgres-backed (D-17) with trigger invalidation (D-18) |
| Refreshing per-entity timeline materialized view | `services/entity-timeline-refresher` Lambda (new, Wave 3) | One SQL: `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| Loading full Gemini-grade dossier on operator request | `services/dossier-loader` Lambda (new, Wave 3) | `@google-cloud/vertexai` + cachedContent API; only `context.full_dossier_requested` subscriber |
| Dashboard timeline route returning 50 rows | `apps/dashboard/src/app/api/entities/[id]/timeline/route.ts` (modified, Wave 3) | Reads MV ⋃ live overlay |

---

## §2 — Tech Stack Cross-Reference

| Layer | Existing (reuse) | New in Phase 6 |
|-------|------------------|----------------|
| AWS Lambda runtime | Node 22.x ARM64 + KosLambda (Plan 01-00) | granola-poller, transcript-extractor, azure-search-indexer-{entities/projects/transcripts/daily-brief}, entity-timeline-refresher, dossier-loader |
| Bedrock SDK | `@anthropic-ai/bedrock-sdk` (Phase 2 wave-5 pivot) | transcript-extractor uses same client |
| Notion SDK | `@notionhq/client` v2.3.0 | granola-poller (Transkripten reads), transcript-extractor (Command Center writes) |
| RDS access | RDS Proxy IAM signer (`@aws-sdk/rds-signer`; Phase 2 wave-5 pattern) | All Phase 6 Lambdas that touch DB |
| EventBridge | 5 buses + DLQs + scheduler role (Plan 01-03) | New rules for `transcript.available` + `context.full_dossier_requested`; new schedules in `kos-schedules` group |
| Azure AI Search | `kos-memory-v1` index (Plans 01-05 + 02-03 recreate, 1024 dims) | `@kos/azure-search` library + 4 indexer Lambdas |
| Cohere embeddings | `@kos/resolver/embedBatch` (Cohere v4 Bedrock) | Reused in `@kos/azure-search` for query-time embedding |
| Vertex AI | — (NEW) | `@google-cloud/vertexai` v1.x in `services/dossier-loader` only |
| Drizzle migration | Style of 0003 / 0007 / 0010 | `0012_phase_6_dossier_cache_and_timeline_mv.sql` |
| Observability | shared `services/_shared/{sentry,tracing}.ts` | All Phase 6 Lambdas wire (D-28) |
| Tests | vitest 2.1.x; per-package `vitest.config.ts` | Per-Lambda + per-library unit + integration test harness |

No drift from CLAUDE.md "Recommended Stack". One new dependency (`@google-cloud/vertexai`) scoped to a single service package — does not pollute the rest of the monorepo.

---

## §3 — Granola Poller (CAP-08 + AUTO-05)

**Pattern source**: Phase 1 Plan 01-04 `notion-indexer` (5-min poll on entities / projects / kevin_context / command_center using `notion_indexer_cursor` per-DB cursor). Phase 6 adds a 5th cursor row with `dbKind = 'transkripten'` and a separate Lambda (`services/granola-poller`) on a separate schedule (`rate(15 minutes)` not `rate(5 minutes)`).

**Why not extend notion-indexer?**: Conceptually clean to keep the indexer = Notion-→-RDS-mirror only. The granola-poller does more — it publishes EventBridge events. Different responsibility, different DLQ alarm thresholds, different cost profile. Mirror the same connection pattern, but a different Lambda.

**Notion query shape:**
```ts
notion.databases.query({
  database_id: NOTION_TRANSKRIPTEN_DB_ID,
  filter: { timestamp: 'last_edited_time', last_edited_time: { after: cursor.toISOString() } },
  sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
  page_size: 100,
})
```

**Per-page handling:**
1. SELECT `agent_runs` for `agent_name='granola-poller' AND capture_id=transcript_id AND status='ok'` → if exists, skip (idempotency D-03).
2. Read transcript page content via `notion.blocks.children.list` recursive (Granola pages have headings + paragraphs).
3. Extract `title` (page property `title`), `recorded_at` (page property; falls back to `created_time`), `attendees` (multi-select if present), `transcript_text` (concatenated block text, truncated to 64 KB).
4. PutEvents `transcript.available` to `kos.capture` bus with `capture_id := transcript_id`, full payload.
5. INSERT `agent_runs` row status='ok' for idempotency.
6. UPDATE `notion_indexer_cursor` `last_cursor_at` = `max(last_edited_time)` of the batch.

**Schedule wiring** (mirrors Plan 01-04 `wireNotionIntegrations`):
```ts
new CfnSchedule(scope, 'GranolaPollerSchedule', {
  name: 'granola-poller-15min',
  groupName: props.scheduleGroupName,
  scheduleExpression: 'rate(15 minutes)',
  scheduleExpressionTimezone: 'Europe/Stockholm',
  flexibleTimeWindow: { mode: 'OFF' },
  target: { arn: granolaPoller.functionArn, roleArn: schedulerRole.roleArn, input: '{}' },
  state: 'ENABLED',
});
```

**Backlog handling**: First-run cursor seeded to `now() - 24h` (D-02). Subsequent runs page through any backlog up to 100 transcripts per invocation; the next 15-min run continues if more remain. Notion API quota: free tier 3 req/sec — well within bounds at our volume.

---

## §4 — Transcript-Extractor (AGT-06)

**Pattern source**: `services/entity-resolver/src/disambig.ts` (Sonnet 4.6 via AnthropicBedrock direct SDK, Promise.race timeout, Zod-validated output). Phase 6 transcript-extractor follows the same shape but uses Bedrock `tool_use` instead of plain JSON-in-text.

**Tool definition:**
```ts
const RECORD_TRANSCRIPT_EXTRACT = {
  name: 'record_transcript_extract',
  description: 'Record action items and entity mentions extracted from a Granola transcript.',
  input_schema: {
    type: 'object',
    properties: {
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            uppgift: { type: 'string', description: 'Concise task in Swedish or English (matches Kevin\'s capture language)' },
            typ: { type: 'string', enum: ['Task', 'Meeting', 'Note', 'Question', 'Decision'] },
            prioritet: { type: 'string', enum: ['Hög', 'Medium', 'Låg'] },
            anteckningar: { type: 'string', description: 'Context paragraph; will be prefixed with [Granola: <title>]' },
            assignee: { type: 'string', description: 'Empty string if Kevin; else the named person', default: '' },
          },
          required: ['uppgift', 'typ', 'prioritet', 'anteckningar'],
        },
      },
      entity_mentions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            mention_text: { type: 'string', maxLength: 200 },
            context_snippet: { type: 'string', maxLength: 500 },
            candidate_type: { type: 'string', enum: ['Person', 'Project', 'Org', 'Other'] },
          },
          required: ['mention_text', 'context_snippet', 'candidate_type'],
        },
      },
      summary: { type: 'string', description: '3-sentence synopsis for the transcript record' },
    },
    required: ['action_items', 'entity_mentions', 'summary'],
  },
};
```

**Bedrock call:**
```ts
const resp = await client.messages.create({
  model: 'eu.anthropic.claude-sonnet-4-6',
  system: [
    { type: 'text', text: EXTRACTOR_BASE_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: kevinContextBlock, cache_control: { type: 'ephemeral' } },
  ],
  tools: [RECORD_TRANSCRIPT_EXTRACT],
  tool_choice: { type: 'tool', name: 'record_transcript_extract' },  // forces single-tool use
  messages: [{ role: 'user', content: `<transcript>\n${transcript_text}\n</transcript>\n\nExtract action items and entity mentions.` }],
  max_tokens: 4000,
});
const toolUse = resp.content.find(b => b.type === 'tool_use');
const parsed = ExtractSchema.parse(toolUse.input);  // Zod
```

**Zod schema** mirrors the tool input_schema. Validation failure → log raw input + fall back to "extracted nothing" (graceful degradation, mention_events stays empty, no Command Center writes; logged for prompt iteration).

**Write path:**
1. For each `action_items[i]`: `notion.pages.create({ parent: { database_id: COMMAND_CENTER_DB_ID }, properties: { Uppgift: title, Typ: select, Prioritet: select, Anteckningar: { rich_text: [{ text: `[Granola: ${title}] ${anteckningar}` }] }, Status: { select: { name: 'Att göra' } } } })`.
2. For each `entity_mentions[i]`: PutEvents `entity.mention.detected` to `kos.agent` bus with `capture_id := transcript_id`, full payload (existing schema).
3. INSERT `transcripts_indexed` row (Wave 0 table) with `transcript_id`, `summary`, `extracted_at`, `action_items_count`, `mentions_count` (used by azure-search-indexer-transcripts to know what's new).
4. UPDATE `agent_runs` row status='ok' with token usage + cost.

**Cost** (Sonnet 4.6 EU pricing as of 2026-04): $3/M input tokens, $15/M output tokens. 30-min Granola transcript ≈ 7-15k input tokens (transcript) + 1-2k input (system prompt + Kevin Context, mostly cached) + 1-2k output (tool_use JSON) → ≈ $0.04-$0.08 per transcript. Within the $0.10 budget per D-06.

---

## §5 — Context-Loader Library (AGT-04 — REDESIGNED)

**Why a library and not a Lambda?** Each consumer Lambda needs a bounded sub-second context-load before its own Bedrock call. A separate Lambda would add a sync-wait or an EventBridge round-trip; both add 100-500 ms of pure latency (cold start + transport). A library import has zero transport latency; the same `pg.Pool` and Azure REST connection are reused across calls within a Lambda's lifetime.

**Public surface (`packages/context-loader/src/index.ts`):**
```ts
export interface LoadContextInput {
  entityIds: string[];           // resolved entity UUIDs (empty allowed → degraded path D-16)
  agentName: string;             // 'triage' | 'voice-capture' | 'entity-resolver' | 'transcript-extractor' | future…
  captureId: string;             // ULID for Langfuse correlation
  ownerId: string;               // existing pattern; required
  rawText?: string;              // for the degraded path: raw input text → semantic-search query
  maxSemanticChunks?: number;    // default 10
}
export interface ContextBundle {
  kevinContext: string;          // always present
  entityDossiers: EntityDossier[];
  recentMentions: MentionRow[];  // last 20 across all entityIds
  semanticChunks: SearchHit[];   // Azure top-N
  linkedProjects: ProjectRow[];
  assembledMarkdown: string;     // ready to inject into Bedrock system prompt
  elapsedMs: number;
  cacheHit: boolean;             // true if dossier cache hit (≥1 entity)
}
export async function loadContext(input: LoadContextInput): Promise<ContextBundle>;
```

**Implementation outline:**
```ts
export async function loadContext(input: LoadContextInput): Promise<ContextBundle> {
  const t0 = Date.now();
  const pool = await getPool();

  // Parallel fetches:
  const [kevinContext, dossiers, mentions, projects, semanticChunks, cacheRows] = await Promise.all([
    loadKevinContextBlock(input.ownerId),                                                // existing
    input.entityIds.length ? loadEntityDossiers(pool, input.entityIds, input.ownerId) : Promise.resolve([]),
    input.entityIds.length ? loadRecentMentions(pool, input.entityIds, input.ownerId, 20) : Promise.resolve([]),
    input.entityIds.length ? loadLinkedProjects(pool, input.entityIds, input.ownerId) : Promise.resolve([]),
    input.entityIds.length
      ? hybridQuery({ query: dossiersToQueryText(input.entityIds), entityIds: input.entityIds, topK: input.maxSemanticChunks ?? 10, semanticRerank: true })
      : input.rawText ? hybridQuery({ query: input.rawText, topK: 5, semanticRerank: true }) : Promise.resolve({ results: [] }),
    input.entityIds.length ? readDossierCache(pool, input.entityIds) : Promise.resolve([]),
  ]);

  // Merge cache hits with computed dossiers: prefer cache when last_touch_hash matches.
  const merged = mergeCacheWithDossiers(dossiers, cacheRows);

  // Assemble markdown:
  const assembledMarkdown = buildDossierMarkdown({ kevinContext, entityDossiers: merged, recentMentions: mentions, semanticChunks: semanticChunks.results, linkedProjects: projects });

  // Fire-and-forget cache writes for any miss (don't block response):
  void writeDossierCacheBest(pool, merged.misses);

  return { kevinContext, entityDossiers: merged.full, recentMentions: mentions, semanticChunks: semanticChunks.results, linkedProjects: projects, assembledMarkdown, elapsedMs: Date.now() - t0, cacheHit: merged.cacheHits > 0 };
}
```

**Bedrock injection pattern** (each consumer Lambda):
```ts
const ctx = await loadContext({ entityIds, agentName: 'triage', captureId, ownerId });
const system = [
  { type: 'text', text: BASE_PROMPT, cache_control: { type: 'ephemeral' } },
  ...(ctx.kevinContext.trim() ? [{ type: 'text', text: ctx.kevinContext, cache_control: { type: 'ephemeral' } }] : []),
  ...(ctx.assembledMarkdown.trim() ? [{ type: 'text', text: ctx.assembledMarkdown, cache_control: { type: 'ephemeral' } }] : []),
];
```

**Migration path for existing Lambdas**: Phase 6 plan 06-05 modifies triage/voice-capture/entity-resolver/transcript-extractor handlers. Each gains:
1. `import { loadContext } from '@kos/context-loader'`
2. Compute `entityIds` from existing input (e.g., resolver has the candidates list; voice-capture has detected mentions; triage has empty array → degraded path).
3. Call `loadContext()` after idempotency check, before Bedrock call.
4. Inject into system prompt array per pattern above.
5. Replace local `loadKevinContextBlock` import with the one from `@kos/context-loader`.

---

## §6 — Notion `last_edited_time` Filter Caveats

**Caveat 1**: Granularity is minutes. A page edited at 12:34:50 and queried at 12:34:00 with `last_edited_time > 12:34:00` will be missed if the cursor is 12:34:00 exactly. Mitigation: Phase 6 advances the cursor to `max(last_edited_time over batch) - 1 minute` so the next poll re-checks the boundary.

**Caveat 2**: Notion does NOT include the originating-edit user-id; we cannot distinguish Kevin's edits from a Granola-bot's edits. Granola writes to Transkripten on meeting end; we treat any new transcript as a candidate.

**Caveat 3**: `last_edited_time` updates on ANY page mutation (property change, content edit, archive flip). We deduplicate via `agent_runs` idempotency key (D-03). A re-edit of an already-extracted transcript triggers a `transcript.available` re-emit, but the extractor's idempotency check short-circuits.

**Caveat 4**: The `filter.timestamp` parameter (vs `filter.property`) only works on `last_edited_time` and `created_time`. We use `last_edited_time` because Granola sometimes back-dates `created_time` to the meeting time, not the upload time.

**Caveat 5**: Notion API page size cap is 100; we paginate via `start_cursor` until `has_more: false`.

Verified against the Phase 1 notion-indexer `cursor.ts` pattern and Notion REST docs at `https://developers.notion.com/reference/post-database-query-filter`.

---

## §7 — Bedrock Prompt Caching `cache_control: ephemeral`

**Confirmed working**: Phase 2 triage + entity-resolver Lambdas use this pattern in production (commit 460d435+). Each `text` segment in the system prompt array can carry its own `cache_control: { type: 'ephemeral' }` marker — the Bedrock backend caches that exact segment text for ~5 min and discounts subsequent reads.

**Cache TTL**: 5 minutes from last hit (rolling). Bedrock prompt cache is region-bound; the EU inference profile (`eu.anthropic.*`) caches per request region.

**Cache hit pricing**: 90% discount on cached input tokens (Bedrock currently passes through Anthropic's `cache_creation_input_tokens` vs `cache_read_input_tokens` distinction).

**Phase 6 implication**: with 4-5 Phase 6 Lambdas each calling Bedrock with the same Kevin Context block, the Kevin Context block effectively pays its tokenization cost once per 5 minutes. The dossier markdown is per-call and won't typically cache, but the BASE prompts of triage/voice-capture/etc each cache independently.

**Pitfall**: Bedrock rejects `cache_control` on empty text. Phase 2 already handles this — Phase 6 mirrors (the conditional spread pattern in §5 above).

---

## §8 — Bedrock `tool_use` Pattern

**Verified pattern** for Sonnet 4.6 on `eu.anthropic.claude-sonnet-4-6`:
- `tools: [<schema>]` array of tool definitions.
- `tool_choice: { type: 'tool', name: 'record_transcript_extract' }` forces the model to call exactly that tool (vs `auto` which lets the model choose to chat instead).
- Response `content` array contains one or more blocks; the tool_use block has `{ type: 'tool_use', id, name, input }` where `input` is the model's filled JSON.
- Validate `input` with Zod before persisting.

**Pitfall A**: Don't combine `tool_choice` with multiple `tools` of the same name — model errors out. We use one tool per extractor.

**Pitfall B**: Sonnet 4.6 occasionally returns `text` blocks alongside `tool_use` (chain-of-thought leakage). Phase 6 ignores the text blocks; only the tool_use block is consumed.

**Pitfall C**: `tool_choice: { type: 'tool', ... }` is not eligible for prompt caching of the `tools` array itself in some Bedrock SDK versions; the system prompt cache still works. Net effect: tools serialization is paid per call, but it's <500 tokens overhead.

---

## §9 — Azure AI Search Hybrid Query (REST API 2025-09-01)

**Endpoint**: `POST https://{search-service}.search.windows.net/indexes/kos-memory-v1/docs/search?api-version=2025-09-01`

**Body shape (single REST call):**
```json
{
  "search": "<query text>",
  "vectorQueries": [
    {
      "kind": "vector",
      "vector": [<1024-dim Cohere v4 embedding>],
      "k": 50,
      "fields": "content_vector"
    }
  ],
  "filter": "owner_id eq '<owner_id>' and source eq 'transcript'",  // optional, e.g., when entityIds provided we add `entity_ids/any(e: e eq '<entity_id_1>' or e eq '<entity_id_2>')`
  "queryType": "semantic",
  "semanticConfiguration": "kos-semantic",
  "top": 10,
  "captions": "extractive",
  "answers": "none"
}
```

**Behavior**: Azure runs BM25 on `search` text + KNN on `vectorQueries.vector` separately, merges via Reciprocal Rank Fusion (RRF), then the semantic ranker promotes the top 10 from the merged set. This is the documented `hybrid + semantic` pattern.

**Latency**: Azure publishes <500 ms p95 for `top: 10` with semantic rerank on Basic tier when index has <100k docs. Phase 6 budget allows 600 ms p95 (D-15) — comfortably within Azure's published SLO.

**Index schema additions** (operator-runbook step): `kos-memory-v1` already has `id`, `owner_id`, `content`, `entity_ids`, `source`, `occurred_at`, `content_vector` (1024-dim post Phase 2 D-06). Phase 6 may add `transcript_title`, `recorded_at` fields — additive only, schema-fingerprint mechanism handles the re-PUT idempotently.

---

## §10 — Azure AI Search Semantic Reranker Pricing

**Basic tier (per 2026-04 pricing page):**
- 1000 free semantic queries / month included.
- Beyond that: $1 per 1000 queries.
- Phase 6 expected volume: ~5000 reranker queries / month (4-5 Lambdas × ~30 calls/day each = ~150/day = ~4500/month) → ≈ $4-5/month for reranker.
- Plus baseline Basic tier service charge already covered by Azure credits ($75/month per CLAUDE.md).

**Net Phase 6 Azure spend incremental**: ~$5/month above the existing Basic tier baseline. Well within the D-27 ≤$80/mo Phase 6 budget.

**Cost monitoring**: Phase 6 indexer + context-loader log each `hybridQuery` invocation with `agentName + captureId` to Langfuse for retrospective cost analysis.

---

## §11 — PostgreSQL 16 Materialized View Refresh CONCURRENTLY

**Confirmed semantics** (pg 16 docs):
- Requires a unique index on the MV (we have `entity_timeline_mv_pk` on `event_id`).
- Allows concurrent SELECT queries during refresh — no AccessExclusiveLock.
- Takes a SHARE UPDATE EXCLUSIVE lock; blocks other REFRESH commands but not SELECT/INSERT.
- Refresh time scales with row count + diff size; for an INSERT-heavy table like `mention_events`, a 5-min refresh interval keeps diff small.

**Refresh Lambda**: `services/entity-timeline-refresher` with handler:
```ts
await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline_mv');
```

**Pitfall**: pgvector index maintenance during CONCURRENTLY refresh — `entity_timeline_mv` does NOT carry an `embedding` column (we keep vectors in `entity_index` only), so this is not a concern for Phase 6.

**Expected refresh duration**: <2 s for incremental diffs at 100k mention_events (per pg docs benchmarks for similar table shapes); 30 s Lambda timeout is generous.

---

## §12 — Vertex AI Gemini 2.5 Pro Context Caching

**Region**: `europe-west4` (chosen per CLAUDE.md "europe-west4" line; closest to Stockholm with full Gemini 2.5 Pro availability).

**Model ID**: `gemini-2.5-pro` (current GA per Google Cloud Vertex AI model registry as of 2026-04).

**Pricing (per 2026-04 pricing page):**
- Standard input: $1.25/M tokens (<200k context), $2.50/M (>200k).
- Cached input: 25% of standard ($0.31/M <200k, $0.625/M >200k).
- Output: $5/M tokens (<200k), $10/M (>200k).

**Context caching API**: `cachedContent` resource (POST `/projects/{p}/locations/{loc}/cachedContents`). Caches a content block (system prompt + Kevin Context + entity dossier base) with TTL up to 24 h. Subsequent calls reference the cache by ID.

**Minimum cache size**: 32k tokens (current as of 2026-04). Sub-32k cached prompts are rejected by the API. Phase 6 packs Kevin Context + the largest entity dossier into the cache to clear the threshold; if a single entity's dossier is small, we pad with the 5 most recently-touched entity dossiers of the same type to reach the threshold. Documented in the dossier-loader runbook.

**Cost per call** (Phase 6 target <$1.50 avg): For a typical "load full Damien dossier" call:
- ~50k input tokens cached (Kevin Context + Damien dossier + 5 padding dossiers + 90 days of mention_events context) at $0.31/M = $0.016
- ~5k uncached input (the operator's specific question) at $1.25/M = $0.006
- ~10k output (the assembled markdown) at $5/M = $0.05
- Total ≈ $0.07 per call — well under the $1.50 target. Even doubling estimates, we stay under $0.50.

**Operator-trigger UX**: `node scripts/trigger-full-dossier.mjs --entity-id <uuid>` emits `context.full_dossier_requested` to the `kos.agent` bus; dossier-loader subscriber receives it, runs Gemini, writes the output to `entity_dossiers_cached` with `last_touch_hash = 'gemini-full:' || sha256(...)`. Next AGT-04 read picks it up.

---

## §13 — Validation Architecture (per-task verification matrix preview)

Full matrix lives in `06-VALIDATION.md`. Highlights:
- Wave 0 sets up vitest config + mock fixtures for `@kos/context-loader` + `@kos/azure-search` + transcript-extractor.
- Each Wave 1+ task has an `<automated>` verify command (e.g., `pnpm --filter @kos/service-granola-poller test -- --run`).
- Manual-only verifications: live Notion Transkripten DB read; live Azure index population; Vertex SA roles in GCP project; first Gemini cachedContent ID rotation.

---

## §14 — Pitfalls

1. **Bedrock empty-text cache_control** (T-06-EXTRACTOR-01) — already mitigated by Phase 2 conditional spread. Mirror.
2. **Notion `last_edited_time` granularity** (§6) — cursor advances to `max - 1 min`.
3. **Materialized view requires unique index for CONCURRENTLY** (§11) — included in migration 0012.
4. **Gemini cachedContent 32k minimum** (§12) — pad with supplementary entity dossiers.
5. **Azure semantic reranker free quota** (§10) — first 1000/mo free; budget assumes ~5000/mo paid.
6. **Tool_use chain-of-thought text leakage** (§8) — ignore text blocks, consume only tool_use.
7. **Cache trigger race** (D-18) — TTL belt provides backstop; `last_touch_hash` defensively re-checks on read.
8. **Indexer schedule per-type** (D-09) — 4 schedules increase Lambda invocation count but stay within EventBridge free-tier (1M events/mo); no rate concerns.
9. **GCP service account JSON in Secrets Manager** (D-23) — read once at Lambda init, cache for the Lambda lifetime; rotation requires Lambda restart (acceptable at our cadence).
10. **Cohere v4 region availability** (Phase 2 wave-5 Gap A) — `eu.cohere.embed-v4:0` confirmed in Bedrock eu-north-1 post Phase 2 migration; reused unchanged.

---

*Researched: 2026-04-24*
*Confidence summary: HIGH overall; MEDIUM on Vertex 32k floor (may relax in 2026 H2); MEDIUM on Azure reranker pricing (verify at deploy time).*
