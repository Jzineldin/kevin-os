<!-- GSD:project-start source:PROJECT.md -->
## Project

**Kevin OS (KOS) — Personal Operating System**

A personal operating system for Kevin El-zarka — founder/CEO of Tale Forge AB (AI storytelling app for children, Swedish-first) and CTO of Outbehaving (side project). KOS is an entity-centric brain that ingests every input channel Kevin uses (voice memos, email, calendar, Granola transcripts, Discord, WhatsApp, LinkedIn DMs, browser-highlighted text), routes it through specialized AI agents that share a common memory layer, and surfaces a calm visual dashboard with auto-loaded context per person/project. The system is designed for an ADHD founder running multiple companies in parallel — zero categorization friction on capture, full-context responses on output.

**Core Value:** **Kevin never has to re-explain context.** When he mentions Damien, Christina, Almi, or any entity in his world, the system has already loaded the full dossier (every email, every meeting, every doc, every decision involving that entity) before responding. Every input gets routed automatically. Every output is context-aware. The system maintains itself; Kevin only writes raw input and reads curated output.

### Constraints

- **Cloud**: AWS-primary (using $20k credits), Azure for AI Search ($5k credits), Google for Gemini long-context ($2k credits). Hetzner deprecated after migration.
- **Privacy**: Pragmatic — AWS for data, trusted vendors (Anthropic, Notion, Telegram) acceptable, no third-party cookie-holders for LinkedIn/WhatsApp (build those ourselves).
- **Language**: Swedish-first capture (voice, text). Bilingual SE/EN throughout. AWS Transcribe + Claude both handle Swedish well.
- **Timeline**: 8+ weekends to v1 (full quality, not rushed). Can ship sub-pieces sooner for early use.
- **Single-user**: Kevin only. No teams, no shared accounts, no permission system.
- **ADHD compatibility**: Zero categorization friction on input. Calm-by-default on output (no notification fatigue). Voice-first capture wherever possible.
- **Reversibility**: Everything reversible. No destructive operations without explicit Approve. Migration markers (e.g., `[MIGRERAD]`, `[SKIPPAT-DUP]`) prepended for audit trail.
- **Compliance**: GDPR (EU operations + Swedish entity data + working with EU child data via Tale Forge). Voice/email data stays in EU regions where possible (S3 eu-north-1, Bedrock us-east-1 acceptable since LLM doesn't store).
- **Cost**: Aim for ~$200-400/mo all-in steady state. Cloud credits cover ~12-18 months of inference + infra at production volume.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Claude Agent SDK (TypeScript) | `@anthropic-ai/claude-agent-sdk` v0.2.111+ | Agent orchestration runtime | Official Anthropic runtime; Bedrock-native via `CLAUDE_CODE_USE_BEDROCK=1`; subagents, hooks, MCP all first-class; v0.2.111+ required for Opus 4.7 (Sonnet 4.6 works on earlier) |
| AWS Bedrock (Claude Sonnet 4.6 + Haiku 4.5) | API version 2024-02-29 | Primary LLM inference | Already wired; $20k credits; Haiku 4.5 for triage (~$0.001/call), Sonnet 4.6 for reasoning (~$0.01/call); no third-party data routing |
| Vertex AI Gemini 2.5 Pro | `google-cloud-aiplatform` SDK latest | Long-context entity dossier loads (1M tokens) | Only model with reliable 1M-token context; $1.25/M input (<200K ctx) / $2.50/M input (>200K ctx); use only for full dossier loads, not routine calls |
| Notion API | v2022-06-28 (current stable) | Entity graph substrate + memory source of truth | Already structured; human-inspectable; April 2026 changes are additive only; existing Transkripten/Entities/Projects DBs reused directly |
| Azure AI Search | REST API `2025-09-01`, SDK `azure-search-documents` v11.6.0 | Hybrid semantic memory (keyword + vector + semantic reranking) | Best-in-class hybrid search with RRF merging; semantic reranker available on Basic+ tier; $5k Azure credits; single API call for keyword+vector |
| RDS PostgreSQL 16 | `db.t4g.medium` instance | Primary relational store (entity graph, chat history, agent logs, document versions) | See DB section; pgvector extension yes; Aurora Serverless v2 explicitly NOT recommended for this workload |
| AWS EventBridge | Serverless | Internal event routing (inbound events → Lambda targets) | Native AWS; zero ops; content-based filtering; <100ms latency; costs pennies at KOS volume |
| AWS Lambda (Node.js 22.x) | Runtime `nodejs22.x` | Event-driven agent invocations, short tasks (<15 min) | Agent invocations are event-driven and bursty; Lambda charges only for execution time; use for triage agent, email triage, transcript extractor, daily briefs |
| AWS ECS Fargate | Platform 1.4.0, ARM64 | Long-running stateful services: EmailEngine, Baileys, Postiz | Services need persistent TCP connections (IMAP IDLE, WhatsApp WebSocket); Lambda's 15-min max and cold starts are hostile to these; single-task deployments |
| Next.js | 15.x (App Router) | Dashboard frontend | App Router + React Server Components stable for 2 years; Server Actions remove need for a separate API layer for dashboard reads; Vercel deployment (see Frontend section) |
| grammY | v1.38+ | Telegram bot framework (TypeScript) | TypeScript-first, webhook + long-polling both supported, excellent for Lambda deployment, thriving ecosystem of plugins |
## Layer-by-Layer Decisions
### 1. Agent Orchestration — Claude Agent SDK
### 2. Memory Layer — Notion + Azure AI Search + Vertex Gemini
### 3. Voice Transcription — AWS Transcribe
### 4. Event Router — AWS EventBridge (primary) + no n8n
- **Default bus:** AWS service events (S3 ObjectCreated for audio/transcripts, SES inbound, Lambda failures)
- **Custom bus `kos-events`:** KOS-specific events (Telegram message received, email classified, entity detected, daily brief triggered)
- **Rules:** Pattern match on `detail-type` → Lambda target
- **Scheduler:** EventBridge Scheduler (not cron-rule) for AUTO-01/02/03/04/05. Scheduler supports one-time + cron, timezone-aware (Stockholm), retry policy.
### 5. Compute — Lambda vs Fargate
| Service | Compute | Reason |
|---------|---------|--------|
| Triage agent | Lambda (nodejs22.x, 512MB, 30s timeout) | Invoked per event; <5s typical; no persistent state |
| Email-triage agent | Lambda (nodejs22.x, 1GB, 5min timeout) | Runs every 2h; stateless; parallel execution fine |
| Transcript extractor | Lambda (nodejs22.x, 512MB, 1min timeout) | Polling trigger every 15min; short execution |
| Morning/evening brief | Lambda (nodejs22.x, 1GB, 10min timeout) | Scheduled; one-shot; needs more context window = more tokens = more time |
| EmailEngine | Fargate (1 vCPU, 2GB RAM, 1 task) | IMAP IDLE = persistent TCP connection; cannot tolerate Lambda termination |
| Baileys WhatsApp | Fargate (1 vCPU, 2GB RAM, 1 task) | WhatsApp WebSocket = persistent; session state must survive Lambda cold starts |
| Postiz | Fargate (0.5 vCPU, 1GB RAM, 1 task) | Internal job queue + Redis + Next.js in same container; always-on |
- EmailEngine: 1 vCPU × 0.04048/hr + 2GB × 0.004445/hr × 730hr = ~$35.91/month
- Baileys: same = ~$35.91/month
- Postiz: 0.5 vCPU = ~$19/month
- Total Fargate: ~$91/month (covered by AWS credits for 12+ months)
### 6. Database — RDS PostgreSQL 16 (NOT Aurora Serverless v2)
- Scale-to-zero is now production-ready, but Aurora Serverless v2 minimum is 0.5 ACU = $0.06/hour even idle = $43.80/month baseline
- At KOS volume (predictable, light load), a `db.t4g.medium` RDS instance costs ~$26/month with 1-year reserved = 40% cheaper
- Aurora Serverless v2 HNSW index for pgvector has known issues (queries fall back to sequential scan under certain capacity conditions — confirmed AWS re:Post issues)
- Provisioned Aurora is 17% more expensive than equivalent RDS for steady workloads
- Fast entity lookup by embedding similarity before calling Azure Search
- Deduplication of entities at insertion time (cosine similarity check)
- Emergency fallback if Azure credits run out
- Logical replication improvements (useful for read replicas later)
- MERGE statement (cleaner upserts for entity resolution)
- Row-level security (single-user app, but good hygiene)
### 7. Frontend — Next.js 15 on Vercel
- Vercel created Next.js. Edge runtime, ISR, Server Actions, and streaming SSR work perfectly on Vercel; Amplify has historically lagged 1-2 major Next.js versions in support
- Vercel GDPR DPA exists; data transfer from EU to US covered by standard contractual clauses
- Vercel's CDN has Stockholm PoP (AWS eu-north-1 region nearby)
- Hobby plan = free for single-user; Pro = $20/month if you need more build minutes
- Amplify Gen 2 is improving but adds AWS-specific config overhead you don't need for a single-user dashboard
- AppSync Events is WebSocket-based and costs $0.08/million connection-minutes. Fine for scale but overkill for one user
- Pusher Channels free tier = 100 simultaneous connections, 200K messages/day — works but adds a third-party in the data path
- SSE is a native browser API, works through Vercel Edge, is unidirectional (server → browser = exactly what KOS needs for push), and costs $0 to implement
### 8. Auth — Static Bearer Token (skip Cognito, skip Clerk)
### 9. Real-time Push — SSE (Server-Sent Events)
- Unidirectional push from server to browser dashboard
- Works natively in Next.js Route Handlers on Vercel
- No third-party dependencies
- Agent invocations push status via an SQS queue → Lambda polls/writes to SSE stream
### 10. Self-Hosted Services on Fargate
#### EmailEngine
- **Image:** `postalsys/emailengine:latest` (official Docker Hub)
- **Critical constraint:** EmailEngine does NOT support horizontal scaling. Run exactly ONE Fargate task. Do not set `desiredCount > 1`.
- **Persistence:** Redis (ElastiCache Serverless = ~$10/month for low usage) required as EmailEngine's data store. Do not use in-memory Redis (task restarts lose all IMAP state)
- **Config via env vars:** `EENGINE_REDIS=redis://...`, `EENGINE_WORKERS=4`
- **Licensing:** Source-available; requires paid license after 14-day trial. License cost: ~$99/year (self-hosted). Budget this.
- **Cost:** $35.91/month Fargate + $10/month ElastiCache + $99/year license = ~$54/month
#### Baileys WhatsApp Gateway
- **Use `fazer-ai/baileys-api` or `PointerSoftware/Baileys-2025-Rest-API`** — both are maintained REST wrappers around WhatsApp-Baileys. Do not use `Evolution API` (too heavy, designed for multi-tenant SaaS).
- **Session persistence:** Mount EFS volume to `/app/data` for WhatsApp session keys. If session keys are lost, you have to re-scan QR code.
- **Memory:** 2GB RAM; Baileys WebSocket + message queue can spike
- **TOS risk:** WhatsApp unofficial API. Kevin is using personal number for personal aggregation only. Low ban risk, but not zero. Keep fallback: Telegram is primary capture, WhatsApp is secondary.
- **Cost:** $35.91/month Fargate + $0.30/month EFS = ~$36/month
#### Postiz
- **Image:** Use official Postiz Docker image. Postiz bundles PostgreSQL 16, Valkey 8 (Redis fork), Node.js 22, nginx in a single container (RHEL 10 base).
- **Single-container design:** Correct for Fargate single-task. Don't attempt to split services.
- **Persistent storage:** EFS for PostgreSQL data directory and media uploads
- **MCP endpoint:** `/api/mcp/{API_KEY}` via Streamable HTTP. Wire this as an MCP server in the agent SDK's `mcpServers` config.
- **Cost:** $19/month Fargate (0.5 vCPU) + $0.30/month EFS = ~$20/month
### 11. Browser Extension — Chrome MV3
- Background: `"service_worker"` (string, not array) replaces background pages
- Service workers terminate when idle; do NOT rely on in-memory state between events
- Message passing: always `return true` from `onMessage` if using async `sendResponse`
- For LinkedIn DOM scraping: content script runs on `https://www.linkedin.com/messaging/*`; reads DOM, POSTs to KOS webhook via `fetch()` with Bearer token
### 12. Telegram Bot — grammY (TypeScript)
- KOS is a TypeScript monorepo. Mixing Python for Telegram bot means a second Lambda runtime, second dependency tree, second CI pipeline
- grammY is TypeScript-first with outstanding type coverage. Bot API methods are fully typed
- grammY's webhook adapter is Lambda-compatible out of the box via `webhookCallback(bot, "aws-lambda")`
- python-telegram-bot v21+ is excellent but adds Python runtime to a TS stack without benefit
### 13. iOS Shortcut → Webhook Auth
### 14. Logging and Observability
- Claude Agent SDK: via LangChain instrumentation + OpenTelemetry spans
- Amazon Bedrock: full trace support including AgentCore
- Every tool call, subagent invocation, model completion captured as OTel span
| Concern | Tool | Cost/month |
|---------|------|-----------|
| LLM traces + costs | Langfuse cloud (free tier) | $0 |
| Lambda logs | CloudWatch Logs (30-day retention) | ~$3 |
| Lambda/Fargate traces | X-Ray | ~$2 |
| Error tracking | Sentry free tier | $0 |
## Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@notionhq/client` | v2.x | Notion API client | All Notion database reads/writes |
| `@aws-sdk/client-transcribe` | v3.x | AWS Transcribe invocation | Voice transcription in Lambda |
| `@aws-sdk/client-s3` | v3.x | S3 operations | Audio upload, document storage |
| `@aws-sdk/client-secrets-manager` | v3.x | Secrets retrieval | API keys, OAuth tokens in Lambda |
| `@aws-sdk/client-ses` | v3.x | Email sending | Approved email drafts |
| `azure-search-documents` | v11.6.0 | Azure AI Search operations | Semantic memory queries |
| `@google-cloud/vertexai` | v1.x | Gemini 2.5 Pro calls | Full entity dossier loads |
| `grammy` | v1.38+ | Telegram bot | CAP-01 Telegram inbound |
| `langfuse` | v3.x | LLM observability | All agent invocations |
| `@sentry/aws-serverless` | v8.x | Error tracking in Lambda | All Lambda handlers |
| `@sentry/nextjs` | v8.x | Error tracking in Next.js | Dashboard frontend |
| `zod` | v3.x | Schema validation | Validating inbound webhooks, agent outputs |
| `drizzle-orm` | v0.30+ | Postgres ORM | Entity graph, chat history, agent logs |
| `drizzle-kit` | v0.20+ | DB migrations | Schema management |
| `pgvector` (drizzle extension) | latest | pgvector types in Drizzle | Entity embedding queries |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| LangGraph | Graph abstraction is over-engineering for 8 agents with linear fan-out; adds 300+ lines of boilerplate; slower cold starts on Lambda | Claude Agent SDK subagents (20 lines, same result) |
| CrewAI | Python-first; verbose role/goal/backstory YAML; no TypeScript parity; designed for team-of-agents simulation, not production event routing | Claude Agent SDK |
| Aurora Serverless v2 | 17% more expensive than provisioned RDS for steady load; HNSW pgvector index has known capacity-scaling issues; minimum 0.5 ACU idle cost | RDS PostgreSQL 16 `db.t4g.medium` |
| Pinecone / Weaviate / Qdrant | Adds a third vector database vendor when pgvector + Azure AI Search already covers the use case; extra monthly cost ($25-70/month) for no benefit at KOS scale | pgvector on RDS + Azure AI Search |
| Supabase Realtime | Supabase is a full BaaS stack — you'd be adding its auth, DB, and realtime just to use the realtime layer; KOS already has its own Postgres and auth | SSE via Next.js Route Handler |
| AWS AppSync | WebSocket-based, costs $0.08/million connection-minutes, requires GraphQL schema; overkill for single-user unidirectional push | SSE (free, native to Next.js) |
| Pusher | Third-party vendor in data path; 200K messages/day free but adds latency hop and account dependency | SSE |
| n8n self-hosted | Visual workflow tool that fights you when you need code-level control; Hetzner VPS already deprecated; equivalent functionality in EventBridge rules | AWS EventBridge + Lambda |
| python-telegram-bot | Forces Python runtime into a TypeScript stack; no benefit at KOS scale; worse Lambda cold starts | grammY (TypeScript) |
| AWS Cognito / Clerk | Auth infrastructure for a single-user personal tool is over-engineering; Cognito's hosted UI is dated; Clerk is $25/month for features not needed | Static Bearer token in Secrets Manager |
| Unipile (LinkedIn) | €49/month + LinkedIn ban escalation Q1 2026; cookie-on-vendor violates privacy constraints | Custom Chrome extension (MV3, unpacked) |
| Evolution API (WhatsApp) | Designed for multi-tenant commercial SaaS; heavy (Node + Redis + separate DB); overkill for single personal number | `fazer-ai/baileys-api` or `PointerSoftware/Baileys-2025-Rest-API` |
| Tailscale for iOS auth | Requires Tailscale background app + network extension; adds setup friction to the Action Button capture flow | HMAC-signed Bearer token |
| Unlimited CloudWatch log retention | Log storage is $0.03/GB/month; unretained logs from agent invocations accumulate fast | 30-day retention on all log groups |
## Cost Summary — Steady State (~$200-280/month)
| Service | Monthly Cost | Notes |
|---------|-------------|-------|
| AWS Lambda (all agents) | ~$2 | Essentially free tier at KOS volume |
| RDS PostgreSQL 16 db.t4g.medium | ~$52 on-demand / ~$31 reserved | Reserved 1-year recommended |
| ECS Fargate (EmailEngine + Baileys + Postiz) | ~$91 | Covered by AWS credits |
| ElastiCache Serverless (EmailEngine Redis) | ~$10 | Covered by AWS credits |
| EFS (Baileys + Postiz persistence) | ~$1 | |
| AWS S3 (audio, docs, transcripts) | ~$3 | ~100GB eu-north-1 |
| AWS Transcribe | ~$22 | ~30 min/day voice |
| AWS EventBridge + Scheduler | ~$1 | |
| AWS SES | ~$1 | <1K emails/month |
| AWS Secrets Manager | ~$1 | |
| AWS CloudWatch Logs (30-day) | ~$3 | |
| AWS X-Ray | ~$2 | |
| Azure AI Search (Basic tier) | ~$75 | Covered by Azure credits |
| Vertex AI Gemini 2.5 Pro | ~$10-30 | Only full dossier loads; cache aggressively |
| Vercel (Hobby → Pro) | ~$0-20 | Hobby likely sufficient |
| Langfuse | ~$0 | Free tier sufficient |
| Sentry | ~$0 | Free tier sufficient |
| EmailEngine license | ~$8/month (amortized) | $99/year |
| **Total** | **~$220-282/month** | AWS credits absorb ~$170/month for 12+ months |
## Version Compatibility
| Package | Compatible With | Notes |
|---------|----------------|-------|
| `@anthropic-ai/claude-agent-sdk` v0.2.111+ | Node.js 18+, Bedrock us-east-1 | `CLAUDE_CODE_USE_BEDROCK=1` env var required |
| `@notionhq/client` v2.x | Notion API 2022-06-28 | Stable; April 2026 changes additive only |
| `azure-search-documents` v11.6.0 | REST API `2025-09-01` | Latest stable on PyPI as of research date |
| `grammy` v1.38+ | Telegram Bot API 8.x | `webhookCallback(bot, "aws-lambda")` for Lambda |
| Next.js 15.x | Tailwind v4, shadcn/ui latest, React 19 | `npx shadcn@latest init` handles compatibility |
| Drizzle ORM v0.30+ | PostgreSQL 16 + pgvector 0.8.0 | Use `drizzle-orm/pg-core` with custom pgvector types |
| `@google-cloud/vertexai` v1.x | Gemini 2.5 Pro `gemini-2.5-pro` model ID | Context caching via `cachedContent` API |
## Installation
# Agent orchestration
# Notion
# AWS SDK (use individual modules, not the monolith aws-sdk)
# Azure AI Search
# Telegram bot
# Observability
# Database (Drizzle)
# Validation
# Frontend
# Python (for any Python-based Lambda handlers, e.g., custom Transcribe postprocessing)
## Sources
- [Claude Agent SDK overview — code.claude.com](https://code.claude.com/docs/en/agent-sdk/overview) — confirmed TypeScript v0.2.71 / Python v0.1.48, Bedrock integration, subagent patterns (HIGH confidence)
- [Claude Agent SDK TypeScript reference — code.claude.com](https://code.claude.com/docs/en/agent-sdk/typescript) — AgentDefinition API, webhookCallback patterns (HIGH confidence)
- [Langfuse Claude Agent SDK integration](https://langfuse.com/integrations/frameworks/claude-agent-sdk) — confirmed OTel-based tracing (HIGH confidence, April 2026)
- [Langfuse Amazon Bedrock integration](https://langfuse.com/integrations/model-providers/amazon-bedrock) — confirmed Bedrock tracing (HIGH confidence)
- [Azure AI Search hybrid search overview](https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview) — RRF merging, semantic ranking, API version 2025-09-01 (HIGH confidence)
- [azure-search-documents PyPI](https://pypi.org/project/azure-search-documents/) — v11.6.0 latest (HIGH confidence)
- [Notion changes-by-version](https://developers.notion.com/reference/changes-by-version) — API version stable at 2022-06-28 (HIGH confidence)
- [AWS Transcribe supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html) — Swedish `sv-SE` supported; no language identification for Swedish (HIGH confidence)
- [Aurora Serverless v2 production deep dive, andrewbaker.ninja, February 2026](https://andrewbaker.ninja/2026/02/21/scaling-aurora-serverless-v2-postgresql-a-production-deep-dive/) — scaling rate issues, cost comparison (MEDIUM confidence — blog, not official)
- [Aurora Serverless v2 pgvector HNSW issue — AWS re:Post](https://repost.aws/questions/QUCjnj-8NNTne60CKtmh7b4w/aurora-serverless-v2-pgvector-hsnw-index-not-used) — confirmed HNSW index fallback issue (HIGH confidence — official AWS community)
- [EmailEngine Docker installation](https://learn.emailengine.app/docs/installation/docker) — single-instance constraint, Redis requirement (HIGH confidence — official docs)
- [EmailEngine no horizontal scaling](https://learn.emailengine.app/docs/advanced/performance-tuning) — confirmed (HIGH confidence — official docs)
- [Postiz MCP endpoint + Docker pattern](https://crunchtools.com/self-hosting-postiz-rhel10-one-container-six-platforms-zero-saas/) — single-container design confirmed (MEDIUM confidence — third-party article, cross-referenced with Postiz GitHub)
- [Vertex AI Gemini 2.5 Pro pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) — $1.25/$2.50 per M tokens, context caching 25% discount (HIGH confidence — official Google Cloud pricing page)
- [Chrome MV3 migration guide](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers) — service worker patterns, MV2 sunset (HIGH confidence — official Chrome developer docs)
- [grammY npm package](https://www.npmjs.com/package/grammy) — v1.38+ latest, Lambda webhook support (HIGH confidence — official npm)
- [AWS decision guide Fargate vs Lambda](https://docs.aws.amazon.com/decision-guides/latest/fargate-or-lambda/fargate-or-lambda.html) — official guidance on persistent connections (HIGH confidence — official AWS docs)
- [Webhook authentication strategies 2026 — Hooklistener](https://www.hooklistener.com/learn/webhook-authentication-strategies) — HMAC patterns for iOS Shortcut (MEDIUM confidence — technical guide)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
