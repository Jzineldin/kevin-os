# Research Summary — Kevin OS (KOS)

**Project:** Kevin OS (KOS) — Personal AI Operating System
**Domain:** Entity-centric multi-agent personal OS / second brain / personal CRM hybrid
**Researched:** 2026-04-21
**Confidence:** HIGH (stack and architecture HIGH; pitfalls MEDIUM on Swedish ASR specifics)

---

## Executive Summary

KOS is an event-driven, entity-centric personal operating system for a single ADHD founder running two companies. The research is unambiguous: the load-bearing architectural decision is EventBridge-only event routing (no n8n) with Claude Agent SDK on Lambda for agent orchestration, Notion as human-inspectable source of truth for entities, and Telegram as the primary mobile push channel. Every downstream design choice flows from these three anchors.

The recommended build sequence is infrastructure-first, not feature-first. The entity graph (Notion DBs + Postgres index + notion-indexer Lambda) is the critical path: no agent, no dashboard, no capture pipeline is useful without a seeded entity corpus. The minimum viable loop — Telegram voice in, AWS Transcribe, triage agent, entity resolver, Notion write, Telegram ack — must be the first complete vertical slice. That loop, when working end-to-end, is the moment KOS exists and all further phases are additive.

The dominant risk is not technical but behavioral: notification fatigue and maintenance burden can cause Kevin to route around the system within 6 weeks. The countermeasures — hard cap of 3 Telegram messages per day, strict urgency classifier, auto-restart with silent health checks, graceful degradation on all integrations — must be built into Phase 1 and Phase 2 infrastructure before any agent ships. A secondary risk is entity resolution quality: AWS Transcribe Swedish has no custom language model support and will mis-transcribe proper nouns without a custom vocabulary file. That vocabulary must be ready before any voice capture goes live.

---

## Stack Lock-Ins (15 items)

1. **Claude Agent SDK (TypeScript) `@anthropic-ai/claude-agent-sdk@latest`** — agent orchestration runtime; Bedrock-native via `CLAUDE_CODE_USE_BEDROCK=1`; subagents as `.agents/*.md` files; do not use LangGraph, CrewAI, or AutoGen
2. **AWS Bedrock (Sonnet 4.6 + Haiku 4.5), us-east-1** — primary LLM inference; $20k credits; Haiku for triage/classification (~$0.001/call), Sonnet for reasoning/drafting (~$0.008/call); Opus never invoked automatically
3. **AWS EventBridge (5 custom buses: capture, triage, agent, output, system) + EventBridge Scheduler** — sole event router; replaces n8n entirely; n8n decommissioned on MIG-02; captures never call agents directly — they publish
4. **AWS Lambda (Node.js 22.x)** — all event-driven agent invocations; triage at 60s/512MB, subagents at 120s/1GB; Step Functions only for bulk jobs exceeding 15 min (e.g. 5-platform content drafting)
5. **AWS ECS Fargate (ARM64, Platform 1.4.0)** — EmailEngine, Baileys, Postiz as separate tasks; EFS for session persistence; never combine services into one task; separate Fargate task per integration
6. **RDS PostgreSQL 16 (`db.t4g.medium`, eu-north-1, reserved 1-year, ~$31/month)** — primary relational index + ops log; derived from Notion, rebuildable; pgvector extension enabled; NOT Aurora Serverless v2 (HNSW issues + 17% higher cost)
7. **Notion API (v2022-06-28)** — source of truth for all human-inspectable state; agents write Notion first, Postgres second; human edits in Notion UI are canonical; Postgres is rebuildable from Notion
8. **Azure AI Search (Basic tier, `azure-search-documents` v11.6.0, REST `2025-09-01`, West Europe)** — hybrid BM25 + vector + semantic reranker; binary quantization configured at index creation (92.5% cost reduction — $75/month not $1,000/month); never Free tier
9. **Vertex AI Gemini 2.5 Pro (`@google-cloud/vertexai`, europe-west4)** — long-context entity dossier loads only (1M tokens); context caching at 25% price for Kevin Context page; called sparingly, not per-message
10. **Next.js 15.x (App Router) + Tailwind v4 + shadcn/ui on Vercel** — dashboard frontend; SSE via Postgres `LISTEN/NOTIFY` for real-time push; Vercel Hobby sufficient; no AppSync, no Pusher, no Supabase Realtime
11. **grammY v1.38+ on Lambda (webhook mode)** — Telegram bot; TypeScript-native; `webhookCallback(bot, "aws-lambda")`; primary mobile capture and notification channel; not python-telegram-bot
12. **Static Bearer token in AWS Secrets Manager** — dashboard auth; 256-bit random token; no Cognito, no Clerk; single-user doesn't need auth infrastructure
13. **Drizzle ORM v0.30+ + drizzle-kit** — Postgres schema and migrations; pgvector extension via drizzle; explicit typed schema; no Prisma
14. **Langfuse (cloud, free tier) + CloudWatch Logs (30-day retention) + Sentry (free tier)** — observability stack; LLM traces, infra logs, error tracking; total ~$5/month
15. **S3 (eu-north-1) with VPC Gateway Endpoint configured before any Lambda touches S3** — blobs (audio, documents, transcripts); Gateway Endpoint prevents $0.045/GB NAT Gateway charges; Glacier lifecycle at 90 days

---

## Top 5 Differentiating Features

1. **Swedish-first bilingual entity capture + memory** — No competitor handles Swedish-English code-switching in voice transcription + entity resolution. AWS Transcribe `sv-SE` with custom vocabulary + Claude Haiku post-correction pass.
2. **Multi-channel ingest completeness (8+ channels)** — Telegram, iOS Action Button, email (two Gmail), WhatsApp (all chats via Baileys), Granola transcripts, Chrome highlights, LinkedIn DMs, Discord. All produce same `capture.received` event through same triage.
3. **Auto-context loading before every LLM call** — AGT-04 fires before every agent call, extracts entities, queries Postgres + Azure AI Search, injects ranked dossier blocks. Kevin Context always prompt-cached.
4. **Living entity dossier with AI-synthesized narrative** — Per-entity pages: AI "What you need to know" (Gemini 2.5 Pro for Tier-1), full chronological timeline, linked projects/documents with version status.
5. **Calm-by-default notification architecture** — Max 3 Telegram messages/day: morning brief, urgent-only escalation, evening summary. Everything else batches into Dashboard Inbox. Determines whether Kevin uses KOS at month 3.

---

## Top 5 Anti-Features

1. **Auto-send emails / auto-publish content** — SES sends only after explicit Approve. Postiz schedules only after explicit Approve. The approval queue is a safety gate.
2. **n8n in any form** — EventBridge + Lambda handle routing in 20 lines vs n8n's 300+. n8n on Hetzner is live security risk. Decommissioned on MIG-02.
3. **iOS Web Push as notification channel** — iOS 17.4 removed standalone PWA push in EU under DMA. Telegram is mobile push. Web Push is desktop-only.
4. **Auto-categorization-on-capture** — Categorization friction is top reason second-brain systems fail for ADHD. KOS captures raw, classifies async via triage.
5. **v2 agents before v1 has 4 weeks of production use** — AGT-09 through AGT-12 cannot ship until all 5 acceptance criteria simultaneously met.

---

## 10-Phase Build Order

**Phase 1 — Infrastructure Foundation**
CDK baseline, VPC, IAM, RDS Postgres with full schema, S3 with VPC Gateway Endpoint, 5 EventBridge buses, Secrets Manager, Notion Entities + Projects DBs, `notion-indexer` Lambda, Kevin Context page, Azure AI Search index with binary quantization, cost alarms, archive-not-delete policy, VPS scripts frozen.
Requirements: INF-01 through INF-07, ENT-01, ENT-02, MEM-01, MEM-02

**Phase 2 — Minimum Viable Loop**
Telegram webhook (grammY), AWS Transcribe (`sv-SE`, custom vocabulary), triage Lambda (AGT-01), entity-resolver (AGT-03), voice-capture (AGT-02), Notion writes, Telegram push-back. Health checks + auto-restart. DLQs. Idempotency.
Requirements: CAP-01, CAP-02 (voice), AGT-01, AGT-02, AGT-03, INF-08

**Phase 3 — Dashboard MVP**
Next.js 15 on Vercel, Today view (UI-01), per-entity pages (UI-02), SSE via Postgres LISTEN/NOTIFY, Bearer token auth, PWA, Inbox/Approval Queue (UI-04). Desktop-primary.
Requirements: UI-01, UI-02, UI-04, UI-05 (Android+desktop), MEM-04. **Can run parallel with Phase 4 after Phase 2 stable.**

**Phase 4 — Inbound Channels Expansion**
iOS Shortcut HMAC webhook (CAP-02 full), email-forward via SES (CAP-03), EmailEngine Fargate (CAP-07, IMAP IDLE), email-triage agent (AGT-05) with idempotency + injection guards.
Requirements: CAP-02, CAP-03, CAP-07, AGT-05, INF-06, AUTO-02

**Phase 5 — Messaging Channels**
Baileys WhatsApp Fargate (CAP-06, read-only, session in RDS), Chrome extension MV3 unpacked (CAP-04 highlight + CAP-05 LinkedIn at human-paced rate), Discord poller.
Requirements: CAP-04, CAP-05, CAP-06, CAP-10

**Phase 6 — Granola + Semantic Memory**
Granola poller every 15 min (CAP-08), transcript-extractor (AGT-06), Azure AI Search indexer, dossier cache in ElastiCache, auto-context loader (AGT-04). Entity timeline materialized view 5-min refresh.
Requirements: CAP-08, AGT-04, AGT-06, MEM-03, MEM-04, INF-09. **Quality multiplier for all agents — prioritize before more capture.**

**Phase 7 — Lifecycle Automation**
Morning brief 07:00 (AUTO-01, prose + Top 3 + Calendar + Drafts + Dropped), day-close 18:00 (AUTO-03), email triage 2h (AUTO-02), Sunday review 19:00 (AUTO-04). EventBridge Scheduler timezone-aware.
Requirements: AUTO-01 through AUTO-05

**Phase 8 — Outbound Content**
Content-writer (AGT-07, BRAND_VOICE.md + few-shot), publisher (AGT-08), Postiz Fargate with MCP, Google Calendar (CAP-09). **Independent of Phase 7 — can swap order.**
Requirements: AGT-07, AGT-08, CAP-09, INF-12

**Phase 9 — V2 Specialist Agents**
Competitor-watch (AGT-09), market-analyst (AGT-10), investor-relations (AGT-11), legal-flag (AGT-12). **Hard gate: all Gate 4 criteria met simultaneously.**
Requirements: AGT-09 through AGT-12

**Phase 10 — Migration and Decommission**
classify_and_save / morning_briefing / evening_checkin migrated (MIG-01), n8n decommissioned (MIG-02), Brain DBs archived (MIG-03), CC confirmed substrate (MIG-04), Hetzner VPS decommissioned. **Can overlap with 6-8.**
Requirements: MIG-01 through MIG-04, INF-11

---

## Top 10 Pitfalls with Mitigation Phase

| # | Pitfall | Mitigation Phase | Critical Action |
|---|---------|-----------------|----------------|
| 1 | Entity resolution false merge ("Javier" + "Hawi" create 3 Notion rows) | Phase 1 gate | Auto-merge only at >0.95 confidence + secondary signal; 0.75-0.95 → Inbox confirm; ENT-07 manual merge UI before AGT-03 |
| 2 | Notification fatigue abandonment at Day 60 | Phase 1 (before any agent) | Hard cap 3 Telegram/day; only financial decisions/legal/investor replies escalate |
| 3 | ADHD abandonment from maintenance burden | Phase 2 | Health checks post to Dashboard panel only; Fargate auto-restart + exp backoff; graceful degradation everywhere |
| 4 | Baileys WhatsApp session ban (personal number loss non-recoverable) | Phase 5 | Strict read-only; 4hr backoff on rejection; session in RDS not filesystem; 7-day stable run before production label |
| 5 | LinkedIn Voyager API restriction (23% ban rate in 90 days) | Phase 5 | Poll max once/30min, only when tab focused; randomized 2-15s delays; silent failure with Dashboard alert |
| 6 | LLM cost overrun from model drift | Phase 2 (lock) | Haiku for triage/classification; Sonnet for drafting; Gemini for full dossier only; `cache_control: ephemeral` mandatory |
| 7 | Agent orchestration failures (duplicate drafts, prompt injection from email, silent tool failures) | Phase 4 (before AGT-05) | Idempotency key in RDS; email body in `<email_content>` delimiters; tool calls 10s timeout + 2 retries + DLQ |
| 8 | Entity graph corruption from Notion rate-limit mid-sync | Phase 1 | Archive-not-delete; write Notion first → confirmed event → Azure upsert; SQS FIFO at 2.5 req/s |
| 9 | Swedish ASR quality (no CLM for sv-SE; "Almi" → "Olmi") | Phase 1 / CAP-01 gate | Custom vocabulary deployed before first Transcribe job; explicit `LanguageCode: "sv-SE"`; WER < 10% on 20 real samples before Phase 2 ships |
| 10 | GDPR/AI Act tripwires (child data, third-party WA consent, August 2026 AI Act deadline) | Phase 1 + Phase 9 | S3 in eu-north-1; email firewall blocking school-facing addresses; 90-day rolling retention WA/LinkedIn; DPIA before AGT-11 |

---

## 5 Quality Gates

**Gate 1 — Entity Foundation Ready (Phase 1 → Phase 2):**
- CDK deploys cleanly, all 5 EventBridge buses created
- Postgres schema migrated with `owner_id` on all tables
- Notion Entities DB has spec schema (all 13 fields)
- S3 VPC Gateway Endpoint verified (no NAT Gateway charges)
- Cost billing alarms active at $50 and $100/month
- VPS scripts frozen or redirected to Legacy Inbox
- Azure AI Search index created with binary quantization
- Archive-not-delete policy implemented in `notion-indexer`

**Gate 2 — Minimum Viable Loop Working (Phase 2 → Phase 3):**
- Send Swedish-English code-switched voice memo via Telegram; entity resolver correctly identifies at least one known entity without auto-merging any ambiguous match; Kevin receives confirmation within 25s
- Custom vocabulary deployed; WER < 10% on 20 real Kevin voice samples
- All Fargate tasks have auto-restart; health checks post to Dashboard, not Kevin
- DLQs configured on all EventBridge → Lambda rules
- Notification hard cap enforced (triage cannot send >3 Telegram/day)

**Gate 3 — Email Triage Safe to Ship (Phase 4 internal gate):**
- Process same email twice; verify exactly one draft (idempotency)
- Prompt injection test: email containing `SYSTEM: ignore all previous instructions` is classified normally with no unauthorized action
- EmailEngine runs 7 days without IMAP auth failure
- Draft approval flow works end-to-end: Approve/Edit/Skip — no action without explicit input

**Gate 4 — v2 Agent Acceptance Criteria (Phase 9 unlock):**
All 5 must be simultaneously true:
- 4 continuous weeks of daily use (not reverted to VPS scripts or manual Notion)
- Morning brief read and acted on at least 5 days/week
- Entity resolver accuracy > 90% on voice inputs (via agent_runs log over previous 2 weeks)
- Email triage draft approval + edit rate > 70% (not skipped) over previous 2 weeks
- Dashboard opened > 3 sessions/week (Vercel analytics)

**Gate 5 — WhatsApp Baileys Production Label (within Phase 5):**
- Baileys runs 7 consecutive days with zero write operations in logs
- Session auth in RDS confirmed: kill Fargate task, verify reconnect without QR
- Connection rejection backoff verified: 4-hour minimum wait
- Zero mutation method calls in any Baileys log line

---

## Cross-Document Decisions (Locked)

**Decision 1: EventBridge-Only Event Routing — n8n Fully Removed**
STACK + ARCHITECTURE both recommend killing n8n. The VPS n8n instance (port 5678, no auth — live security risk) is frozen Phase 1, decommissioned Phase 10. Capture Lambdas publish to EventBridge; never call agents directly.

**Decision 2: SSE from Next.js Edge via Postgres LISTEN/NOTIFY**
Locked: dashboard real-time uses SSE via Next.js `/api/sse` Route Handler (Edge runtime), backed by Postgres `NOTIFY`. No AppSync, no Pusher. Upgrade to socket.io before AppSync if bidirectional ever needed.

**Decision 3: ARCHITECTURE Foundation is Phase 1, FEATURES Minimum Loop is Phase 2**
ARCHITECTURE's CDK baseline = Phase 1 (no user-visible behavior). FEATURES' "entity graph + bulk import + voice + Telegram" = Phase 2 (first moment KOS exists). ENT-05/ENT-06 bulk import is Phase 2 deliverable to seed entity corpus before Phase 6 semantic memory.

**Decision 4: AWS Transcribe Swedish Requires Custom Vocabulary Before CAP-01 Ships**
PITFALLS wins: CLMs not available for Swedish — custom vocabulary is the only accuracy lever. Custom vocabulary file (entity names, company names, Swedish financial/legal terms, English tech terms in Swedish speech) deployed before any voice capture goes live. If WER on 20 real samples > 15%, escalate to self-hosted Whisper large-v3 on Fargate.

**Decision 5: v2 Agents Are Blocked — Acceptance Criteria Required**
PROJECT.md lists AGT-09 through AGT-12 as Active. PITFALLS says they must not ship until v1 has 4 weeks of production use. Locked as Phase 9, gated behind all 5 Gate 4 criteria. AGT-11 additionally requires DPIA before deployment per GDPR/AI Act. Specs may be written earlier; code cannot ship.

**Decision 6: Dashboard Desktop-Primary, Telegram Mobile-Primary**
iOS 17.4 removed standalone PWA push in EU under DMA. Cannot engineer around. All mobile push for Kevin's iOS goes through Telegram. Web Push (UI-06) is desktop-only. UI-05 "installable to iOS home screen" partially achievable (Safari shortcut); documented and accepted.

---

## Open Questions for Phase Research

1. **Bedrock model regional availability (Phase 1):** Verify Sonnet 4.6 and Haiku 4.5 in eu-north-1 vs us-east-1. Impacts GDPR data flow.
2. **AWS Transcribe `sv-SE` in eu-north-1 (Phase 2):** Confirm streaming and batch availability.
3. **Claude Agent SDK `cache_control` on Bedrock (Phase 2):** Token limits may differ from Anthropic API direct.
4. **Notion workspace EU data residency (Phase 1):** Confirm current plan supports it; upgrade if needed before production.
5. **EmailEngine licensing (Phase 4):** Procure $99/year license before Phase 4 begins.
6. **Vercel Hobby SSE stream limits (Phase 3):** Hobby has 30s max; Pro has 300s. Evaluate Pro ($20/mo) vs `fluid compute` vs Fargate `next-start`.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All major choices verified against official docs; versions confirmed via npm/changelogs; cost from AWS pricing |
| Features | HIGH | Primary claims verified across multiple current sources; competitor analysis from live products; ADHD patterns from psychology + product research |
| Architecture | HIGH (boundaries + flow); MEDIUM (Lambda-vs-Step Functions cutpoints) | EventBridge + Agent SDK from official docs; SSE via Postgres LISTEN/NOTIFY MEDIUM (technically sound, AppSync is alternative) |
| Pitfalls | HIGH on most; MEDIUM on Swedish ASR specifics | Baileys ban from primary GitHub issues; LinkedIn ban rate from 2025/2026; Swedish CLM limitation from AWS re:Post; iOS EU PWA from official DMA docs |

**Overall:** HIGH

---

*Generated 2026-04-21. Research artifacts at `.planning/research/`. Ready for requirements + roadmap.*
