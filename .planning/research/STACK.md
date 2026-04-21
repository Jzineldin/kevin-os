# Stack Research: Kevin OS (KOS)

**Domain:** Multi-source, multi-agent personal AI operating system
**Researched:** 2026-04-21
**Confidence:** HIGH (all major choices verified against official docs or Context7; versions current as of Q1-Q2 2026)

---

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

---

## Layer-by-Layer Decisions

### 1. Agent Orchestration — Claude Agent SDK

**Verdict:** Use `@anthropic-ai/claude-agent-sdk` (TypeScript). Do not use LangGraph, CrewAI, AutoGen, or custom agentic loops.

**Version:** v0.2.71 on npm as of March 2026; v0.2.111+ required for Opus 4.7 (not needed for KOS which uses Sonnet 4.6 + Haiku 4.5). Install `@anthropic-ai/claude-agent-sdk@latest`.

**Why not LangGraph:** LangGraph adds a graph abstraction layer (state machines, edges, nodes) that solves multi-agent problems for teams of 5+ agents with complex conditional routing. KOS has 8 v1 agents with linear fan-out from a triage agent. The SDK's `AgentDefinition` + subagents covers this in <50 lines. LangGraph would add 300+ lines of boilerplate and a new mental model with no benefit at this scale.

**Bedrock integration:** Set `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION=us-east-1`. The SDK routes through Bedrock transparently. No code change vs direct Anthropic API.

**Production deployment pattern for Lambda:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

export const handler = async (event: EventBridgeEvent<...>) => {
  for await (const message of query({
    prompt: buildPrompt(event),
    options: {
      allowedTools: ["Read", "Bash"],  // restrict to what each agent needs
      agents: {
        "entity-resolver": {
          description: "Extracts and fuzzy-matches named entities",
          prompt: ENTITY_RESOLVER_PROMPT,
          tools: ["Bash"]  // Bash calls Notion API via CLI wrapper
        }
      }
    }
  })) {
    if ("result" in message) await persistResult(message.result);
  }
};
```

**Cost per agent invocation:** Haiku 4.5 triage = ~$0.001; Sonnet 4.6 entity-resolver = ~$0.008; daily brief = ~$0.04. At 50 events/day: ~$1.50/day = ~$45/month inference (covered by credits).

**Confidence:** HIGH — verified against official docs at code.claude.com

---

### 2. Memory Layer — Notion + Azure AI Search + Vertex Gemini

**Notion API v2022-06-28** is the current stable version. April 2026 changes (heading_4, tab, tab_group blocks) are additive. Existing integrations continue unchanged. Key pattern for KOS:

```typescript
import { Client } from "@notionhq/client";  // @notionhq/client v2.x
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Entity lookup
const results = await notion.databases.query({
  database_id: ENTITIES_DB_ID,
  filter: { property: "Name", title: { contains: entityName } }
});
```

**Azure AI Search** (`azure-search-documents` v11.6.0, REST API `2025-09-01`): Use hybrid mode — keyword + vector + semantic reranker — in a single request. Index documents at write time (Granola transcripts, email summaries, chat history). Query at read time (entity dossier construction, context injection).

Pattern: BM25 keyword search (exact names/dates) + HNSW vector search (semantic meaning) → RRF merge → semantic reranker (Bing-grade re-ranking). Start with `k=50, top=10`. Semantic ranking costs extra ($5.38/1K queries on Basic tier) — worth it for entity timeline queries; skip for simple lookups.

**Azure tier recommendation:** Basic (1 replica, 1 partition) = ~$75/month from Azure credits. Don't use Free tier (shared, 2GB limit). Scale to Standard S1 only if index exceeds 15GB.

**Vertex AI Gemini 2.5 Pro:** Call only when loading full entity dossiers (all emails + transcripts + notes for a person). Context caching available at 25% of input price — use it aggressively for the "Kevin Context" page that goes into every agent system prompt. Use `CLAUDE_CODE_USE_VERTEX=1` pattern mirrored for SDK but call Vertex directly via `@google-cloud/vertexai` SDK for Gemini.

**Cost per dossier load (500K tokens input):** $1.25 at <200K pricing escalated to $2.50/M for >200K = ~$1.25 per call. Do not call per-message; cache aggressively.

**Confidence:** MEDIUM — Notion API version from official docs; Azure Search API version from official docs; Gemini pricing verified but pricing changes frequently.

---

### 3. Voice Transcription — AWS Transcribe

**Use:** `StartTranscriptionJob` (batch, for voice memos POSTed via iOS Shortcut — async is fine) or `StartStreamTranscription` (streaming, for real-time Telegram voice notes).

**Swedish:** Swedish (`sv-SE`) is supported for both batch and streaming. Added to streaming in October 2024. Important limitation: **language identification does NOT support Swedish** — always specify `LanguageCode: "sv-SE"` explicitly or auto-detect will fail.

**Code-switching (Swedish-English):** This is the biggest risk. AWS Transcribe does NOT support multi-language detection per utterance. When Kevin code-switches mid-sentence ("Vi ska ha ett möte about the roadmap"), transcription will degrade on the non-primary language segment. Mitigation: add custom vocabulary with common Kevin-specific terms (company names: "Tale Forge", "Outbehaving", "Almi"; names: "Damien", "Christina", "Marcus"). Custom vocabularies improve accuracy on domain-specific terms but don't fix mid-sentence language switching.

**Fallback strategy:** If accuracy is insufficient on real Kevin voice, fall back to a self-hosted Whisper (`large-v3` on a Lambda container image with GPU layer, or EC2 g4dn.xlarge spot instance). Do not over-engineer upfront — validate on 20 real voice memos first.

**Lambda invocation pattern:**
```typescript
import { TranscribeClient, StartTranscriptionJobCommand } from "@aws-sdk/client-transcribe";

const transcribe = new TranscribeClient({ region: "eu-north-1" });  // Stockholm
await transcribe.send(new StartTranscriptionJobCommand({
  TranscriptionJobName: `kos-${Date.now()}`,
  Media: { MediaFileUri: `s3://kos-audio-eu/${audioKey}` },
  MediaFormat: "m4a",
  LanguageCode: "sv-SE",
  OutputBucketName: "kos-transcripts-eu",
  Settings: { VocabularyName: "kos-custom-vocab" }
}));
// Poll via EventBridge rule watching S3 kos-transcripts-eu prefix
```

**Cost:** $0.024/minute batch, $0.024/minute streaming. At 30 min/day: $0.72/day = ~$22/month.

**Confidence:** HIGH — AWS docs verified; Swedish support confirmed in official changelog.

---

### 4. Event Router — AWS EventBridge (primary) + no n8n

**Verdict:** EventBridge only. Decomission n8n completely after migration (already planned as MIG-02).

**Why not n8n:** n8n is a visual workflow tool. KOS's event routing logic (triage agent classification → sub-agent invocation) requires code-level control that n8n's node model fights. n8n on Hetzner is already being deprecated. Running n8n on Fargate would cost $15-20/month for a service that does less than 20 lines of EventBridge rules + Lambda.

**EventBridge architecture for KOS:**
- **Default bus:** AWS service events (S3 ObjectCreated for audio/transcripts, SES inbound, Lambda failures)
- **Custom bus `kos-events`:** KOS-specific events (Telegram message received, email classified, entity detected, daily brief triggered)
- **Rules:** Pattern match on `detail-type` → Lambda target
- **Scheduler:** EventBridge Scheduler (not cron-rule) for AUTO-01/02/03/04/05. Scheduler supports one-time + cron, timezone-aware (Stockholm), retry policy.

Example scheduler for morning brief:
```json
{
  "ScheduleExpression": "cron(0 7 ? * MON-FRI *)",
  "ScheduleExpressionTimezone": "Europe/Stockholm",
  "Target": { "Arn": "arn:aws:lambda:eu-north-1:...:function:kos-morning-brief" }
}
```

**Cost:** $1/million events + $0.10/million invocations scheduler. At KOS volume (~500 events/day): ~$0.50/month.

**Confidence:** HIGH — EventBridge official docs; n8n recommendation from ecosystem analysis.

---

### 5. Compute — Lambda vs Fargate

**Rule:** Lambda for event-driven invocations; Fargate for persistent connections.

| Service | Compute | Reason |
|---------|---------|--------|
| Triage agent | Lambda (nodejs22.x, 512MB, 30s timeout) | Invoked per event; <5s typical; no persistent state |
| Email-triage agent | Lambda (nodejs22.x, 1GB, 5min timeout) | Runs every 2h; stateless; parallel execution fine |
| Transcript extractor | Lambda (nodejs22.x, 512MB, 1min timeout) | Polling trigger every 15min; short execution |
| Morning/evening brief | Lambda (nodejs22.x, 1GB, 10min timeout) | Scheduled; one-shot; needs more context window = more tokens = more time |
| EmailEngine | Fargate (1 vCPU, 2GB RAM, 1 task) | IMAP IDLE = persistent TCP connection; cannot tolerate Lambda termination |
| Baileys WhatsApp | Fargate (1 vCPU, 2GB RAM, 1 task) | WhatsApp WebSocket = persistent; session state must survive Lambda cold starts |
| Postiz | Fargate (0.5 vCPU, 1GB RAM, 1 task) | Internal job queue + Redis + Next.js in same container; always-on |

**Fargate cost estimate:**
- EmailEngine: 1 vCPU × 0.04048/hr + 2GB × 0.004445/hr × 730hr = ~$35.91/month
- Baileys: same = ~$35.91/month
- Postiz: 0.5 vCPU = ~$19/month
- Total Fargate: ~$91/month (covered by AWS credits for 12+ months)

**Lambda cost:** $0.20/million invocations + $0.0000166667/GB-second. At 200 invocations/day × 365 = 73K invocations/year → essentially free tier.

**Storage for Fargate (persistent):** EFS (Elastic File System) mounted to Fargate tasks for EmailEngine (IMAP cache) and Baileys (session keys). EFS standard = $0.30/GB-month. Expect <1GB each = ~$0.60/month total.

**Confidence:** HIGH — AWS official decision guide verified; cost from AWS pricing calculator patterns.

---

### 6. Database — RDS PostgreSQL 16 (NOT Aurora Serverless v2)

**Verdict:** `db.t4g.medium` RDS PostgreSQL 16 in `eu-north-1` (Stockholm), Multi-AZ disabled for dev, enable for production.

**Why NOT Aurora Serverless v2:**
- Scale-to-zero is now production-ready, but Aurora Serverless v2 minimum is 0.5 ACU = $0.06/hour even idle = $43.80/month baseline
- At KOS volume (predictable, light load), a `db.t4g.medium` RDS instance costs ~$26/month with 1-year reserved = 40% cheaper
- Aurora Serverless v2 HNSW index for pgvector has known issues (queries fall back to sequential scan under certain capacity conditions — confirmed AWS re:Post issues)
- Provisioned Aurora is 17% more expensive than equivalent RDS for steady workloads

**pgvector: YES — install it.** Even though Azure AI Search handles primary semantic search, pgvector on Postgres enables:
- Fast entity lookup by embedding similarity before calling Azure Search
- Deduplication of entities at insertion time (cosine similarity check)
- Emergency fallback if Azure credits run out

```sql
CREATE EXTENSION vector;
ALTER TABLE entities ADD COLUMN embedding vector(1536);
CREATE INDEX ON entities USING hnsw (embedding vector_cosine_ops);
```

Use `text-embedding-3-small` (OpenAI) or Bedrock's Titan Embeddings for generating entity embeddings.

**PostgreSQL 16 features relevant to KOS:**
- Logical replication improvements (useful for read replicas later)
- MERGE statement (cleaner upserts for entity resolution)
- Row-level security (single-user app, but good hygiene)

**Multi-AZ:** Start without. KOS is for one person; 30 minutes of downtime during failover is acceptable. Enable when you're running daily operations on it.

**Storage:** gp3 (not gp2). 20GB provisioned = $2.30/month. Autoscaling to 100GB.

**Cost (db.t4g.medium, single-AZ, Stockholm):** ~$52/month on-demand; ~$31/month 1-year reserved. Use reserved immediately — this DB runs 24/7.

**Confidence:** HIGH — AWS docs + production analysis article verified; pgvector HNSW issue confirmed via AWS re:Post.

---

### 7. Frontend — Next.js 15 on Vercel

**Framework:** Next.js 15.x, App Router only, React Server Components standard. No Pages Router.

**Styling:** Tailwind CSS v4 + shadcn/ui. Tailwind v4 uses CSS-native `@theme` instead of `tailwind.config.js` — no config file needed for basic setup. shadcn/ui is not a package — it's a CLI that copies component code into your project. This is intentional: you own the components, can customize freely.

```bash
npx create-next-app@latest kos-dashboard --typescript --tailwind --app
npx shadcn@latest init
npx shadcn@latest add card table calendar badge
```

**Deployment: Vercel, not AWS Amplify.** Rationale:
- Vercel created Next.js. Edge runtime, ISR, Server Actions, and streaming SSR work perfectly on Vercel; Amplify has historically lagged 1-2 major Next.js versions in support
- Vercel GDPR DPA exists; data transfer from EU to US covered by standard contractual clauses
- Vercel's CDN has Stockholm PoP (AWS eu-north-1 region nearby)
- Hobby plan = free for single-user; Pro = $20/month if you need more build minutes
- Amplify Gen 2 is improving but adds AWS-specific config overhead you don't need for a single-user dashboard

**Real-time updates:** Server-Sent Events (SSE) via Next.js Route Handler, NOT AWS AppSync, NOT Pusher.

Rationale for SSE:
- AppSync Events is WebSocket-based and costs $0.08/million connection-minutes. Fine for scale but overkill for one user
- Pusher Channels free tier = 100 simultaneous connections, 200K messages/day — works but adds a third-party in the data path
- SSE is a native browser API, works through Vercel Edge, is unidirectional (server → browser = exactly what KOS needs for push), and costs $0 to implement

```typescript
// app/api/events/route.ts
export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // Subscribe to EventBridge or SQS queue via polling
      const send = (data: string) =>
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      // ...cleanup on client disconnect
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
  });
}
```

**Cost:** Vercel Hobby = $0/month. Vercel Pro = $20/month. SSE = $0. Total dashboard: ~$0-20/month.

**Confidence:** HIGH — Next.js 15 + shadcn/ui + Tailwind v4 compatibility verified via official shadcn docs; Vercel GDPR from official DPA.

---

### 8. Auth — Static Bearer Token (skip Cognito, skip Clerk)

**Verdict:** No auth framework. Single-user app. Use a static long-lived API token stored in AWS Secrets Manager.

**Why not Cognito:** Cognito is free up to 50K MAU, but it adds JWK rotation, Cognito User Pool setup, callback URLs, and session management for... one user. The configuration overhead is disproportionate. Cognito is designed for apps with user registration flows.

**Why not Clerk:** Clerk's DX is excellent but costs $25/month for the Pro plan if you need any SSO or advanced features. Free tier covers 10K MAU — fine for one user, but you're still adding a third-party identity vendor to a private OS.

**Recommended pattern:**
1. Generate a 256-bit random token: `openssl rand -hex 32`
2. Store in AWS Secrets Manager as `kos/dashboard-token`
3. Next.js middleware checks `Authorization: Bearer <token>` on all routes
4. iOS Shortcut and Chrome extension include the token as a header
5. Rotate manually every 6 months

```typescript
// middleware.ts
import { NextResponse } from "next/server";
export function middleware(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.KOS_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
```

**If you want a login page for browser access:** Add a single hard-coded password check in a login route handler. Store the session in a signed httpOnly cookie. No OAuth needed.

**Cost:** $0.40/month (Secrets Manager).

**Confidence:** HIGH — standard pattern for single-user internal tools; no library-specific version dependencies.

---

### 9. Real-time Push — SSE (Server-Sent Events)

See Frontend section above. SSE is the correct choice for this architecture:
- Unidirectional push from server to browser dashboard
- Works natively in Next.js Route Handlers on Vercel
- No third-party dependencies
- Agent invocations push status via an SQS queue → Lambda polls/writes to SSE stream

If SSE proves insufficient (e.g., bidirectional needed), upgrade to `socket.io` before reaching for AppSync.

**Cost:** $0.

---

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

**Total self-hosted Fargate stack: ~$110/month** (covered by AWS credits).

**Confidence:** MEDIUM — EmailEngine scaling limitation from official docs; Baileys container patterns from community repos; Postiz single-container design from recent RHEL 10 deep dive article.

---

### 11. Browser Extension — Chrome MV3

**Manifest Version:** V3 only. MV2 is fully phased out for new submissions as of 2024. MV3 enforcement is complete.

**Distribution:** Unpacked (load via `chrome://extensions → Load unpacked`) for personal use. No need to publish to Chrome Web Store for a single-user tool. Publishing requires $5 developer fee + review process + policy compliance for LinkedIn DOM scraping (which may get rejected). Unpacked is simpler and faster.

**Key MV3 patterns:**
- Background: `"service_worker"` (string, not array) replaces background pages
- Service workers terminate when idle; do NOT rely on in-memory state between events
- Message passing: always `return true` from `onMessage` if using async `sendResponse`
- For LinkedIn DOM scraping: content script runs on `https://www.linkedin.com/messaging/*`; reads DOM, POSTs to KOS webhook via `fetch()` with Bearer token

```json
// manifest.json excerpt
{
  "manifest_version": 3,
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://www.linkedin.com/messaging/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "host_permissions": ["https://www.linkedin.com/*", "https://api.kevinos.app/*"]
}
```

**Highlight-to-KOS:** Context menu item via `chrome.contextMenus.create` in service worker. Right-click selected text → "Send to KOS" → POST to `/api/capture` with `text`, `url`, `title`.

**LinkedIn DM ingestion:** Voyager API (LinkedIn's internal GraphQL API) via content script using existing session cookies. This is what the project spec calls for. Monitor for LinkedIn API changes — they've escalated enforcement in Q1 2026 per project context.

**Cost:** $0 (no Web Store publication).

**Confidence:** HIGH — MV3 status from official Chrome developer docs; MV2 sunset timeline confirmed.

---

### 12. Telegram Bot — grammY (TypeScript)

**Verdict:** grammY v1.38+, TypeScript, NOT python-telegram-bot.

**Why grammY over python-telegram-bot:**
- KOS is a TypeScript monorepo. Mixing Python for Telegram bot means a second Lambda runtime, second dependency tree, second CI pipeline
- grammY is TypeScript-first with outstanding type coverage. Bot API methods are fully typed
- grammY's webhook adapter is Lambda-compatible out of the box via `webhookCallback(bot, "aws-lambda")`
- python-telegram-bot v21+ is excellent but adds Python runtime to a TS stack without benefit

**Deployment:** Webhook mode on Lambda (NOT long-polling). Register webhook URL on startup:

```typescript
import { Bot, webhookCallback } from "grammy";
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

bot.on("message:voice", async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  // Download file → upload to S3 → trigger transcription Lambda
  await ctx.reply("Got it, processing voice memo...");
});

export const handler = webhookCallback(bot, "aws-lambda");
```

**Voice notes:** `ctx.message.voice` gives you the file_id; download via Telegram Bot API file endpoint → store in S3 `kos-audio-eu` → trigger transcription job.

**Cost:** $0 (Telegram bots are free).

**Confidence:** HIGH — grammY official docs + version confirmed via npm.

---

### 13. iOS Shortcut → Webhook Auth

**Verdict:** Static HMAC-signed requests. Not Tailscale (too complex for a single-device personal tool). Not OAuth (no browser flow from Shortcuts).

**Pattern:**
1. iOS Shortcut sends `POST /api/capture/voice` with:
   - `Authorization: Bearer <static-token>` (from Secrets Manager)
   - `X-Timestamp: <unix-ts>` (for replay protection)
   - `X-Signature: HMAC-SHA256(secret, body + timestamp)`
2. Lambda handler verifies signature + timestamp within ±5 minutes
3. Audio file is base64-encoded in body for <5MB voice memos; for larger files, Shortcut first gets a presigned S3 upload URL, uploads directly, then sends the S3 key

**Why not Tailscale:** Tailscale on iOS requires the Tailscale app running in the background + network extension. For a Shortcut that fires on the Action Button, you want zero setup friction. HMAC with a static secret is battle-tested and invisible to Kevin.

**Why not OAuth:** iOS Shortcuts support OAuth flows poorly (requires browser redirect); overkill for single-user.

**Cost:** $0.

**Confidence:** MEDIUM — iOS Shortcuts webhook patterns from community docs + Hooklistener security guide; specific iOS HMAC implementation is standard but not officially documented by Apple.

---

### 14. Logging and Observability

**Primary LLM tracing: Langfuse** (self-hosted on Fargate OR cloud-hosted on langfuse.com).

Langfuse has native integration with:
- Claude Agent SDK: via LangChain instrumentation + OpenTelemetry spans
- Amazon Bedrock: full trace support including AgentCore
- Every tool call, subagent invocation, model completion captured as OTel span

Use langfuse.com (cloud) initially — free tier covers KOS volume. Migrate to self-hosted if cost becomes a factor.

```typescript
import { Langfuse } from "langfuse";
const lf = new Langfuse();
const trace = lf.trace({ name: "triage-agent", input: event });
// Wrap agent SDK calls with Langfuse tracing
```

**Infrastructure logging: CloudWatch Logs** for all Lambda functions and Fargate tasks. Structured JSON logs. Set retention to 30 days (avoid unlimited retention = unbounded cost).

**Tracing: AWS X-Ray** for Lambda execution traces. Automatically captures DynamoDB, S3, SES calls. Add `aws-xray-sdk-node` to Lambda functions that call multiple AWS services.

**Error alerting: Sentry** (not CloudWatch Alarms for errors). Sentry captures unhandled exceptions with stack traces + breadcrumbs. Free tier (5K errors/month) sufficient. Integrate in Next.js dashboard and Lambda handlers via `@sentry/nextjs` and `@sentry/aws-serverless`.

**Stack:**
| Concern | Tool | Cost/month |
|---------|------|-----------|
| LLM traces + costs | Langfuse cloud (free tier) | $0 |
| Lambda logs | CloudWatch Logs (30-day retention) | ~$3 |
| Lambda/Fargate traces | X-Ray | ~$2 |
| Error tracking | Sentry free tier | $0 |

**Confidence:** HIGH — Langfuse Claude Agent SDK integration from official Langfuse docs (April 2026 announcement); CloudWatch/X-Ray from AWS docs.

---

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

---

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

---

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

---

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

---

## Installation

```bash
# Agent orchestration
npm install @anthropic-ai/claude-agent-sdk

# Notion
npm install @notionhq/client

# AWS SDK (use individual modules, not the monolith aws-sdk)
npm install @aws-sdk/client-transcribe @aws-sdk/client-s3 @aws-sdk/client-ses @aws-sdk/client-secrets-manager @aws-sdk/client-eventbridge

# Azure AI Search
npm install @azure/search-documents  # v11.6.0

# Telegram bot
npm install grammy

# Observability
npm install langfuse @sentry/aws-serverless @sentry/nextjs

# Database (Drizzle)
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg

# Validation
npm install zod

# Frontend
npx create-next-app@latest kos-dashboard --typescript --tailwind --app
npx shadcn@latest init
```

```bash
# Python (for any Python-based Lambda handlers, e.g., custom Transcribe postprocessing)
pip install claude-agent-sdk azure-search-documents google-cloud-aiplatform langfuse
```

---

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

---

*Stack research for: Kevin OS (KOS) — multi-source, multi-agent personal AI operating system*
*Researched: 2026-04-21*
