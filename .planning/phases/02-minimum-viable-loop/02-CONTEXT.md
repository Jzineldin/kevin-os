# Phase 2: Minimum Viable Loop - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

First daily-usable capture-to-storage loop. Kevin sends a text or voice message (Swedish, English, or code-switched) via Telegram → within ~25s receives an acknowledgment that the message was transcribed (if voice), classified, mapped to the right entities/project, and written to Notion. Three-stage entity resolution (auto-merge / LLM disambiguation / Inbox confirmation) operates without silent merges. Bulk-import tooling seeds ≥ 50 candidate dossiers from Kontakter + Granola + Gmail signatures into the Inbox for batch review.

**In scope:**
- Telegram bot (grammY on Lambda webhook, text + voice)
- Voice pipeline: capture → S3 → Transcribe sv-SE (custom vocab) → triage
- Triage agent (Haiku 4.5) orchestrating subagents
- Voice-capture agent (Haiku 4.5) → structured Notion row
- Entity-resolver agent (Sonnet 4.6) with three-stage ENT-09 scoring
- New "KOS Inbox" Notion DB for unconfirmed entities/merges
- Bulk imports (ENT-05 Kontakter, ENT-06 Granola + Gmail signatures)
- Two-stage Telegram ack UX (instant "⏳ Transcribing…" → final "✅ Saved to X · Y")
- Cohere multilingual v3 embeddings written to pgvector `entity_index.embedding`
- DLQ + idempotency (capture_id ULID) + Phase-1 notification-cap compliance

**Out of scope:**
- iOS Shortcut capture (CAP-02) — deferred to Phase 2.5 or merged with Phase 3
- Azure AI Search document writes — deferred to Phase 6 (schema stays empty)
- Dashboard (Phase 3) — Inbox review happens in Notion directly
- Whisper large-v3 Fargate fallback — speced-only, built only if triggered
- Email ingestion, WhatsApp, Discord, Granola streaming — later capture phases
- Formal WER measurement harness — replaced with Kevin's-gut validation

</domain>

<decisions>
## Implementation Decisions

### Capture surface + latency

- **D-01:** Telegram-only for Phase 2 (CAP-01). grammY on Lambda webhook, bot token from `kos/telegram-bot-token` Secrets Manager entry (placeholder today, Kevin creates via @BotFather before deploy). CAP-02 iOS Shortcut deferred.
- **D-02:** Two-stage acknowledgment UX. (a) Instant ack within ≤ 2 s on capture: "⏳ Transcribing…" (or for text, "⏳ Classifying…"). (b) Final ack when complete: `✅ Saved to [entity] · [project]`. If > 45 s without completion, push "🕐 Still processing — reference `cap_<ULID>`" and continue async. 25-second budget is an SLO, not a hard deadline; the two-stage UX means Kevin isn't staring at the phone.
- **D-03:** Transcribe uses batch `StartTranscriptionJob` (not streaming). Voice memos are async; streaming adds WebSocket complexity with no Kevin-visible benefit at this phase.
- **D-04:** Capture Lambda MUST NOT invoke agents directly. It publishes `capture.received` to `kos.capture` bus with `capture_id` ULID + S3 ref; an EventBridge rule triggers the transcribe Lambda (for voice) or the triage Lambda (for text). Enforces the Phase-1 contract (ARCHITECTURE.md).

### Embedding model + vector store

- **D-05:** Embedding model = **Bedrock Cohere Embed Multilingual v3** (`cohere.embed-multilingual-v3`, 1024 dims, native Swedish + English). Stays on AWS credits. Best fit for Kevin's code-switched content per multilingual benchmarks.
- **D-06:** Recreate Azure AI Search index to 1024 dims to match Cohere output. Zero-document migration (no docs yet). Schema bump committed to code; deploy recreates via Lambda bootstrap custom resource.
- **D-07:** **pgvector-first**, Azure-later. Entity-resolver reads `entity_index.embedding` via pgvector HNSW (already live). Azure Search index stays empty-schema for Phase 6 full-dossier loads. Writes to pgvector happen on entity creation and on indexer sync; Azure stays dormant.
- **D-08:** Embedding content source per entity = concatenation of `Name | Aliases | SeedContext | Role | Org | Relationship` Notion properties, trimmed to 8k tokens. Re-embed on Notion sync when any of those fields change.

### Entity resolver + Inbox

- **D-09:** ENT-09 scoring = **hybrid trigram + embedding cosine**. Formula: `score = max(0.6 × trigram, 0.6 × cosine, 0.3 × trigram + 0.7 × cosine)`. `trigram` = PostgreSQL `pg_trgm` similarity between mention text and canonical `Name+Aliases`. `cosine` = pgvector cosine between mention-context embedding and `entity_index.embedding`. Covers typos (Damian↔Damien) AND semantic matches (our CTO → Henrik).
- **D-10:** Thresholds per ENT-09: `score > 0.95` AND secondary signal → auto-merge with audit row. `0.75 ≤ score ≤ 0.95` → Sonnet 4.6 disambiguation prompt with top 5 candidates. `score < 0.75` → queue in KOS Inbox for Kevin to confirm.
- **D-11:** **Secondary signal for > 0.95 auto-merge = project co-occurrence**. Auto-merge only when the matched dossier's `LinkedProjects` overlaps with any project mentioned in the current capture (same capture_id). Prevents Damian↔Damien cross-project false merges while letting obvious same-project rephrasings auto-resolve. Every auto-merge writes a row to `agent_runs` (audit log) regardless.
- **D-12:** LLM disambiguation (0.75–0.95) uses Sonnet 4.6 with a structured prompt: `{ mention: ..., context: ..., candidates: [{id, name, aliases, role, last_touch}] }` → returns one of `{matched_id}` or `"unknown"`. Timeout 5 s, retry once on transient failure, fall through to Inbox on final failure. Budget ≤ $0.01 per resolution.
- **D-13:** **KOS Inbox = new Notion database** under 🏠 Kevin page. Properties: `Proposed Entity Name` (title), `Type` (select: Person/Project/Org/Other), `Candidate Matches` (relation → Entities DB, multi), `Source Capture ID` (text), `Status` (select: Pending / Approved / Merged / Rejected), `Confidence` (number), `Raw Context` (text, 500 chars), `Created` (date). Bootstrap script extended to create this DB alongside Entities/Projects/KevinContext/LegacyInbox.
- **D-14:** Kevin approves/merges via Notion directly (no dashboard yet). Status flip triggers normal notion-indexer sync (next 5-min poll) → entity committed to `entity_index` when `Status=Approved`, archived when `Rejected`. Merge: `Status=Merged` + sets a `MergedInto` relation field → indexer writes `agent_runs` audit row + updates any mention_events FK pointers.
- **D-15:** Three-stage pipeline applies to people, projects, and orgs. All three types route through the same resolver; `Type` disambiguation happens in the voice-capture agent before the resolver runs.

### Voice validation

- **D-16:** **Kevin's-gut validation, no formal WER harness**. Kevin uses the bot for ≥ 1 week of real usage. Phase 2 completion gate = "Kevin reports transcripts are usable enough to trust for Notion writes." If recurring errors appear, iterate on the `vocab/sv-se-v1.txt` seed file + redeploy via Transcribe CustomResource (idempotent update) — no phase boundary for vocab iteration.
- **D-17:** **Whisper large-v3 Fargate fallback = spec'd but not built**. If Kevin reports transcripts are unusable AND vocab iteration doesn't fix it, a Phase 2.5 would add the Fargate service. Not pre-built. Spec lives in the plan for discoverability.
- **D-18:** **Phase 2a / 2b split**. Phase 2a = build and deploy the pipeline (bot + transcribe + agents + resolver + Inbox DB + bulk imports). Phase 2b = Kevin uses it, reports back, iterates vocab if needed, flips the "done" flag. Phase 2a can verify-pass before Phase 2b closes.

### Agent orchestration

- **D-19:** Triage + voice-capture + entity-resolver implemented as **separate Lambdas**, not one Lambda running Agent SDK internally. EventBridge routes: triage writes `triage.routed` event on `kos.triage` bus → separate rule invokes voice-capture Lambda → it publishes `mention.resolved` events for the resolver. Keeps per-agent scaling + DLQs + cap boundaries clean. Matches ARCHITECTURE.md event contracts.
- **D-20:** All three agents use Claude Agent SDK TypeScript (`@anthropic-ai/claude-agent-sdk` v0.2.111+) with `CLAUDE_CODE_USE_BEDROCK=1`. Models: triage + voice-capture = Haiku 4.5 (`eu.anthropic.claude-haiku-4-5`). Entity-resolver = Sonnet 4.6 (`eu.anthropic.claude-sonnet-4-6`). Auto-context loader (AGT-04) injects entity dossiers pre-call on voice-capture + resolver.
- **D-21:** Idempotency key = `capture_id` ULID. Every agent Lambda checks `agent_runs` for prior completion of the same `capture_id + stage` and short-circuits. Prevents double-processing on EventBridge retries.

### Bulk imports

- **D-22:** **ENT-05 Kontakter**: one-shot Lambda reads Kontakter Notion DB (ID to be confirmed from Kevin), emits candidate dossiers to KOS Inbox with `Status=Pending`, `Source Capture ID="bulk-kontakter-<date>"`. Kevin batch-approves in Notion. Idempotent on re-run (skip if Proposed Entity Name already in Inbox + Entities).
- **D-23:** **ENT-06 bulk import from Granola + Gmail**: separate one-shot Lambda. Granola: enumerates last 90 days of transcripts via Granola API (MCP available locally but not in Lambda — use REST directly with API key in new `kos/granola-api-key` secret). Extracts capitalised-name mentions + context. Gmail: read-only OAuth read of kevin@tale-forge.app signatures + From: headers from last 90 days. ≥ 50 candidate dossiers target per roadmap.
- **D-24:** Bulk imports write to KOS Inbox only. Never auto-commit to Entities DB. Kevin reviews in batches.

### Observability

- **D-25:** **Langfuse tracing wired now** (deferred from Phase 1). Every Bedrock invocation (triage, voice-capture, entity-resolver, disambiguation) emits OTel spans to Langfuse cloud (free tier). Captures: tokens, cost, latency, prompt, response, any tool calls. Traces queryable by `capture_id` for debugging. `kos/langfuse-public-key` + `kos/langfuse-secret-key` added to Secrets Manager.
- **D-26:** **Sentry for Lambda error tracking**. `@sentry/aws-serverless` in every agent + capture Lambda. Free tier sufficient.

### Claude's Discretion
- Exact Claude Agent SDK prompt structure for each agent (system prompts, tool schemas, cache_control placement)
- Lambda memory/timeout sizing per agent (defaults: 512 MB / 30 s, bump as needed)
- S3 key structure for audio / transcripts (rough form: `audio/{YYYY}/{MM}/{capture_id}.{ext}`)
- pg_trgm + HNSW index tuning for resolver hot path
- Internal structure of the voice-capture agent's "classify & parse to Notion row" prompt
- Granola API exact endpoints + pagination (research step will confirm against current Granola docs)
- Gmail OAuth consent flow UX (one-time setup before ENT-06 runs)

### Folded Todos
None — no pending todos matched Phase 2 scope.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project definition & scope
- `.planning/PROJECT.md` — KOS vision, constraints, ADHD compatibility rules, active threads
- `.planning/REQUIREMENTS.md` — Phase 2 owns CAP-01, AGT-01/02/03, ENT-03/04/05/06/09, INF-08 (WER)
- `.planning/ROADMAP.md` §Phase 2 — goal, 5 success criteria, dependency on Phase 1 entity graph
- `.planning/STATE.md` — locked decisions D-01..D-15 (Phase 1); open questions 1+2 resolved

### Research & stack rationale
- `.planning/research/STACK.md` — Claude Agent SDK + grammY + Bedrock + Langfuse version pins
- `.planning/research/ARCHITECTURE.md` — event contracts (`capture.received` → `triage.routed` → `mention.resolved`), Fargate vs Lambda split, memory layer topology
- `.planning/research/PITFALLS.md` — Agent SDK cache_control on Bedrock, Claude Agent SDK Bedrock parity, Cohere Embed multilingual dim pinning

### Phase 1 carry-forward
- `.planning/phases/01-infrastructure-foundation/01-CONTEXT.md` — D-01..D-15 (infrastructure locks)
- `.planning/phases/01-infrastructure-foundation/01-RESEARCH.md` — pgvector 0.8.0 HNSW, Bedrock regions, Transcribe sv-SE
- `.planning/phases/01-infrastructure-foundation/01-00-SUMMARY.md` through `01-08-SUMMARY.md` — what actually shipped in Phase 1

### External specs
- Claude Agent SDK TypeScript reference — `https://code.claude.com/docs/en/agent-sdk/typescript` (subagents, hooks, Bedrock)
- grammY docs — `https://grammy.dev/` (webhook on Lambda, media handling)
- AWS Transcribe sv-SE — `https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html`
- Bedrock Cohere Embed multilingual — `cohere.embed-multilingual-v3` model card
- Langfuse Claude Agent SDK integration — `https://langfuse.com/integrations/frameworks/claude-agent-sdk`
- Azure AI Search vector reindex — `https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-create-index` (dim migration)

### Project conventions
- `CLAUDE.md` §"Recommended Stack" — Bedrock Haiku 4.5 + Sonnet 4.6, Cohere Embed on Bedrock, grammY, Langfuse
- `CLAUDE.md` §"What NOT to Use" — exclusion list still binding

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/cdk/lib/constructs/kos-lambda.ts` — KosLambda (Node 22 ARM64, externalized `@aws-sdk/*`, 30-day log retention). Every Phase 2 Lambda uses this.
- `packages/cdk/lib/stacks/events-stack.ts` — 5 `kos.*` EventBridge buses + DLQs live. New rules simply target the relevant bus.
- `packages/cdk/lib/stacks/integrations-notion.ts` — `wireNotionIntegrations` helper pattern; the Phase 2 bot/agents wire via a similar helper to keep `integrations-stack.ts` thin.
- `packages/db/src/schema.ts` — 8 tables including `entity_index`, `mention_events`, `agent_runs`, `event_log`. New tables needed: `telegram_messages` (raw inbound), `capture_events` (ULID-keyed). Added via new migrations 0003/0004.
- `services/notion-indexer/` — existing Notion client wiring; reuse for bulk imports.
- `services/push-telegram/` — cap + quiet-hours wrapper. Phase 2 agents invoke this Lambda (not Telegram API directly) so the cap stays inline.

### Established Patterns
- Per-plan helper file in `packages/cdk/lib/stacks/` (e.g. `integrations-notion.ts`, `integrations-azure.ts`) — Phase 2 adds `integrations-telegram.ts`, `integrations-voice.ts`, `integrations-agents.ts`
- `packages/cdk/lib/stacks/integrations-stack.ts` is the thin composition layer; helpers get called from its constructor
- Drizzle migrations hand-authored in SQL (`0001_initial.sql`, `0002_hnsw_index.sql`) — Phase 2 adds 0003+
- IAM grants: `.grantRead/Write()` cross-stack fails silently; always belt-and-braces with an explicit `PolicyStatement` (Phase 1 retro)
- CustomResource DELETE handlers MUST echo `event.PhysicalResourceId` unchanged (Phase 1 retro)
- Lambdas that read Secrets Manager from private-isolated subnets need a Secrets Manager VPC interface endpoint — if Phase 2 adds any VPC Lambdas, add the endpoint (currently removed post-Phase-1 bastion teardown)

### Integration Points
- `kos.capture` bus — Telegram bot + iOS Shortcut (future) publish here
- `kos.triage` bus — triage agent writes to here with routing decisions
- `kos.agent` bus — subagents consume from here
- `kos.output` bus — Phase 3 dashboard SSE + push-telegram consume from here
- `kos/notion-token` Secrets Manager — already seeded with K-OS integration token
- `entity_index.embedding` column (vector(1024)) — Phase 2 writes to this; schema change needed from current 1536

</code_context>

<specifics>
## Specific Ideas

- Kevin's voice inputs are **bilingual code-switched Swedish-English**, often mid-sentence. Examples from the plan: "Ping Damien om convertible loan detaljerna", "Boka möte med Jezper kl 14 i morgon", "Kolla AWS-kostnader för Tale Forge". Resolver + transcribe must handle both languages without mode-switching.
- Telegram bot replies should respect Kevin's ADHD-friendly principle: short, scannable. One line for success, one for errors. No stack traces. "⏳" and "✅" emoji are the main status affordances.
- Auto-merge audit rows: every single merge (auto or manual) MUST write to `agent_runs` with `action='entity_merge'`, `source_id`, `target_id`, `score`, `secondary_signal`, `agent_run_id`. Zero exceptions.
- Quiet hours (20:00–08:00 Stockholm) still apply to Phase 2 Telegram acks. The capture bot replies during quiet hours because replies are synchronous responses to Kevin-initiated messages, but agent-originated pushes (e.g., "meeting in 10 min") respect quiet hours. The `push-telegram` Lambda already enforces this; Phase 2 must route through it.
- Kevin will want to see which embedding model produced each entity's vector. Add `embedding_model` (text) column to `entity_index` so we can migrate later without losing provenance.
- Phase 2 runs in parallel with Phase 1's notion-indexer (every 5 min). When an agent creates a new entity, it writes to Notion first, then waits for the indexer to sync it into Postgres. Agents never write directly to `entity_index` — Notion is source-of-truth (CONTEXT Phase 1 D-11).

</specifics>

<deferred>
## Deferred Ideas

- **iOS Shortcut capture (CAP-02)** — deferred to Phase 2.5 or bundled with Phase 3 dashboard
- **Azure AI Search document writes** — deferred to Phase 6 when full dossier loads + Gemini 2.5 Pro arrive
- **Whisper large-v3 Fargate fallback** — spec'd only; built only if Kevin reports unusable transcripts AND vocab iteration doesn't fix
- **Streaming Transcribe** — batch is sufficient for async Telegram; streaming a Phase 7+ concern
- **Email ingestion, WhatsApp, Discord, Granola streaming, Chrome extension** — later capture phases (CAP-03..07)
- **Dashboard Inbox view** — Phase 3 renders the same KOS Inbox DB as cards
- **Manual entity merge UI** — Phase 3 (ENT-07); Phase 2 merges via Notion Status field + indexer sync
- **Entity timeline view + "What you need to know" AI block** — Phase 3+ (ENT-08)
- **EmailEngine + Baileys + Postiz Fargate services** — Phases 4 + 5
- **Multi-user / tenant isolation** — deferred indefinitely (single-user product)
- **Formal WER harness + Whisper fallback trigger** — superseded by Kevin's-gut validation per D-16

### Reviewed Todos (not folded)
None — no pending todos matched Phase 2 scope.

</deferred>

---

*Phase: 02-minimum-viable-loop*
*Context gathered: 2026-04-22*
