# Kevin OS (KOS) — Personal Operating System

## What This Is

A personal operating system for Kevin El-zarka — founder/CEO of Tale Forge AB (AI storytelling app for children, Swedish-first) and CTO of Outbehaving (side project). KOS is an entity-centric brain that ingests every input channel Kevin uses (voice memos, email, calendar, Granola transcripts, Discord, WhatsApp, LinkedIn DMs, browser-highlighted text), routes it through specialized AI agents that share a common memory layer, and surfaces a calm visual dashboard with auto-loaded context per person/project. The system is designed for an ADHD founder running multiple companies in parallel — zero categorization friction on capture, full-context responses on output.

## Core Value

**Kevin never has to re-explain context.** When he mentions Damien, Christina, Almi, or any entity in his world, the system has already loaded the full dossier (every email, every meeting, every doc, every decision involving that entity) before responding. Every input gets routed automatically. Every output is context-aware. The system maintains itself; Kevin only writes raw input and reads curated output.

## Requirements

### Validated

(None yet — ship to validate. Existing partial automation on the VPS — classify_and_save, morning_briefing, evening_checkin — is being absorbed into KOS, not preserved.)

### Active

#### Capture (multi-channel inbound)
- [ ] **CAP-01**: Telegram bot accepts text + voice messages, voice transcribed via AWS Transcribe, routed to entity graph
- [ ] **CAP-02**: iOS Shortcut on Action Button records audio → POSTs to webhook → structured row in Notion in <5 sec
- [ ] **CAP-03**: Email-forward address (forward@kevinos…) ingests forwarded emails and routes to entity graph
- [ ] **CAP-04**: Chrome extension allows highlight → "Send to KOS" from any webpage
- [ ] **CAP-05**: Chrome extension reads LinkedIn DMs from kevin's session via Voyager API, posts new messages to KOS
- [ ] **CAP-06**: Self-hosted Baileys WhatsApp gateway ingests ALL chats (named filtering for routing/triage, not for ingestion)
- [ ] **CAP-07**: EmailEngine self-hosted, IMAP IDLE on both Gmail accounts (kevin.elzarka@gmail.com + kevin@tale-forge.app)
- [ ] **CAP-08**: Granola transcripts polled from Notion Transkripten DB, routed through transcript-extractor agent
- [ ] **CAP-09**: Google Calendar (both accounts) read for daily briefs and meeting context
- [ ] **CAP-10**: Discord #brain-dump kept as fallback capture (existing brain-dump-listener)

#### Entity Graph (the foundation)
- [ ] **ENT-01**: Notion `Entities` DB created with schema: Name, Aliases, Type (Person/Project/Company/Document), Org, Role, Relationship, Status, LinkedProjects (relation), SeedContext, LastTouch, ManualNotes
- [ ] **ENT-02**: Notion `Projects` DB created with schema: Name, Bolag, Status, Description, LinkedPeople (relation), SeedContext
- [ ] **ENT-03**: Voice-onboarding flow for Add Person: tap → voice memo → Whisper → Claude parses → confirm → entity dossier saved
- [ ] **ENT-04**: Voice-onboarding flow for Add Project: same pattern
- [ ] **ENT-05**: Bulk import from existing Kontakter DB → propose dossiers → Kevin approves in batch
- [ ] **ENT-06**: Bulk import: extract people from Granola transcripts (last 90 days) + Gmail signatures → propose dossiers
- [ ] **ENT-07**: Manual entity edit/merge UI on dashboard — Kevin can correct mistakes, merge duplicates
- [ ] **ENT-08**: Entity timeline view per person/project — every email, transcript mention, doc shared, task, decision, in chronological order

#### Agent Layer (v1 — required for daily use)
- [ ] **AGT-01**: Triage agent (Haiku 4.5 via Bedrock) — every inbound event routes through triage first; decides which subagent(s) to invoke
- [ ] **AGT-02**: Voice-capture agent — transcript → structured Notion row with auto-detected entities, project, type
- [ ] **AGT-03**: Entity-resolver agent — extracts named entities from any text, fuzzy-matches to existing dossiers, flags new ones for confirmation
- [ ] **AGT-04**: Auto-context loader — pre-call hook that injects relevant entity dossiers into Claude's context before responding
- [ ] **AGT-05**: Email-triage agent — classifies each email (urgent/important/informational/junk), drafts replies for urgent, posts drafts to chat with Approve/Edit/Skip
- [ ] **AGT-06**: Transcript-extractor agent — reads Granola transcripts, extracts Kevin-action items → Command Center, updates entity dossiers
- [ ] **AGT-07**: Content-writer agent — multi-channel content drafts (IG/LinkedIn/TikTok/Reddit/newsletter) using BRAND_VOICE.md + few-shot examples
- [ ] **AGT-08**: Publisher agent — schedules approved drafts via self-hosted Postiz

#### Agent Layer (v2 — added after core works)
- [ ] **AGT-09**: Competitor-watch agent — daily scan of App Store/Play Store/Reddit/Product Hunt/Meta Ad Library for 5 named competitors; two-stage classifier with default-to-silence
- [ ] **AGT-10**: Market-analyst agent — weekly sweep of Reddit/Familjeliv/RSS for parent trends → 3 post angles for Monika
- [ ] **AGT-11**: Investor-relations agent — auto-loads cap table + Almi/Speed/Marcus context when investor topic detected; drafts updates
- [ ] **AGT-12**: Legal-flag agent — auto-flags avtal/aktie/ESOP/GDPR/AI Act context; loads Marcus dossier + relevant precedents

#### Memory Layer
- [ ] **MEM-01**: Notion = source of truth (Entities, Projects, Command Center, Transkripten, Daily Brief Log, Kevin Context, Brand Voice)
- [ ] **MEM-02**: Kevin Context page (always loaded into agent system prompts, prompt-cached) — current priorities, active deals, who's-who, recent decisions
- [ ] **MEM-03**: Azure AI Search for hybrid (vector + keyword + semantic) search across Granola transcripts, Daily Brief Log, chat history, email summaries
- [ ] **MEM-04**: Per-entity timeline = automatic aggregation of all events tagged to that entity
- [ ] **MEM-05**: Per-document version tracker — SHA + diff against previous version, per recipient

#### Dashboard (Custom Next.js)
- [ ] **UI-01**: Today view — calendar (today + tomorrow), Top 3 priorities, Drafts to review, Dropped threads, Voice/text dump zone
- [ ] **UI-02**: Per-entity pages — Person/Project/Company/Document — full dossier + timeline + linked tasks
- [ ] **UI-03**: Calendar view — meetings, deadlines, follow-ups, events from Command Center Deadline field
- [ ] **UI-04**: Inbox view — drafts awaiting approval, ambiguous routings, new entities to confirm
- [ ] **UI-05**: Mobile-responsive PWA, installable to iOS/Android home screen
- [ ] **UI-06**: Push notifications via Telegram + browser Web Push for urgent items only

#### Daily Lifecycle Automation
- [ ] **AUTO-01**: 07:00 Stockholm — Morning brief written by agent: 3-5 sentence prose, Top 3, Calendar, Drafts ready, Dropped threads
- [ ] **AUTO-02**: Every 2h weekdays 08:00-18:00 — Email triage runs, drafts replies for urgent
- [ ] **AUTO-03**: 18:00 Stockholm — Day close: writes Daily Brief Log entry, updates Kevin Context, flags slipped items
- [ ] **AUTO-04**: Sunday 19:00 — Weekly review: full week recap, next-week candidates
- [ ] **AUTO-05**: Every 15 min — Transcript watcher polls Transkripten for new Granola entries, runs extractor

#### Infrastructure
- [ ] **INF-01**: AWS account as primary cloud (existing Bedrock IAM user reused)
- [ ] **INF-02**: AWS RDS Postgres (production DB for entity graph, document versions, chat history, agent logs)
- [ ] **INF-03**: AWS S3 (audio files, document blobs, PDFs, transcripts archive)
- [ ] **INF-04**: AWS Lambda (event-driven agent invocations) + AWS Fargate (long-running services like EmailEngine, Baileys, Postiz)
- [ ] **INF-05**: AWS EventBridge (event router replacing some n8n workflows)
- [ ] **INF-06**: AWS SES (sending drafted emails)
- [ ] **INF-07**: AWS Secrets Manager (API keys, OAuth tokens)
- [ ] **INF-08**: AWS Transcribe (Swedish voice transcription)
- [ ] **INF-09**: Azure AI Search (semantic memory layer)
- [ ] **INF-10**: Vertex AI Gemini 2.5 Pro (long-context entity dossier loads — 1M tokens)
- [ ] **INF-11**: Existing Hetzner VPS deprecated after migration (n8n + scripts moved to AWS)
- [ ] **INF-12**: Vercel for Next.js dashboard (or AWS Amplify if we want full AWS)

#### Migration & Cleanup
- [ ] **MIG-01**: Migrate existing classify_and_save / morning_briefing / evening_checkin from Hetzner VPS to AWS Lambda, refactored to call new agent layer
- [ ] **MIG-02**: Decommission n8n on VPS once all flows migrated
- [ ] **MIG-03**: Archive (don't delete) the 5 Brain DBs once entity graph is the source of truth
- [ ] **MIG-04**: Existing 167-row migration to Command Center stays; new system reads it as the task substrate

### Out of Scope (v1)

- **Self-hosted LLM** — Bedrock + Anthropic API are cheaper and smarter at our volume; revisit if compliance demands it
- **Custom voice cloning** — Tale Forge product concern, not OS concern
- **Multi-tenant** — KOS is single-user (Kevin only); no team accounts, no permissions
- **Mobile-native apps (iOS/Android)** — PWA + Telegram cover capture; native apps deferred unless PWA falls short
- **Calendar booking on Kevin's behalf** — agent reads, doesn't book or accept invites without explicit confirmation
- **Auto-send emails** — every drafted reply needs explicit Approve before SES sends
- **WhatsApp business automation** — personal number can't be moved to Cloud API; stays Baileys self-hosted
- **LinkedIn outbound automation** — read-only via Chrome extension; no auto-connect, no auto-DM
- **Slack integration** — Kevin doesn't use Slack daily
- **GitHub integration v1** — defer; phase 2 if needed for tech updates
- **Postiz analytics dashboard** — content goes out via Postiz; analytics are read by market-analyst agent only
- **Self-hosted KB-Whisper as primary** — AWS Transcribe is primary; KB-Whisper kept as fallback option for Swedish accuracy edge cases

## Context

### About Kevin
- Founder/CEO Tale Forge AB (Swedish EdTech, AI storytelling for kids age 4-9, expanding Nordics → EU → US)
- CTO Outbehaving (side project, partners Damien Hateley + Simon Long)
- ADHD — needs zero-friction capture and proactive context surfacing
- Native Swedish speaker; thinks/talks in Swedish-English code-switch
- Email: kevin@tale-forge.app

### Active Threads (as of 2026-04-21)
- **Almi Invest** signing (Emma Burman is the contact, Marcus drafting avtal, bolagsstämma needed for konvertibellån)
- **Speed Capital** signing (Fredrik)
- **Christina Loh** — recently offered 6 months volunteer as finance advisor
- **Lovable partnership** — Javier Soltero, Isaak Sundeman, Anton Osika, Sophia Nabil; OpenClaw network
- **Skolpilot Q2 2026** — Sara Hvit, Monika Björklund leading
- **Outbehaving website redesign** — Damien + Simon, Simon's design directive applied
- **Bolagsstämma + konvertibellån** — Marcus on legal

### Existing Stack (state as of 2026-04-21)
- **Notion workspace** — primary brain. Has Command Center (167 task rows after migration today), 5 Brain DBs (now legacy), Kontakter, Transkripten, Daily Brief Log, System Map, System Log, 🏠 Today, Session Briefing
- **Hetzner VPS at 98.91.6.66** (ubuntu) — runs brain_server, classify_and_save (just patched), morning_briefing, evening_checkin, gmail_classifier, brain-dump-listener, sync_aggregated, n8n on port 5678 (no auth)
- **AWS Bedrock us-east-1** — Sonnet 4.6 + Haiku 4.5 already wired
- **Discord** — #brain-dump channel + DM for briefings
- **Granola** — meeting transcripts auto-land in Notion Transkripten DB
- **Postiz** — installed but barely used
- **Two Gmail accounts** — kevin.elzarka@gmail.com + kevin@tale-forge.app
- **Cloud credits available**: AWS $20k, Azure $5k, Google $2k

### Why Now
Earlier today we completed a migration of 167 task rows from 5 Brain DBs into Command Center, patched 3 VPS scripts to point at Command Center, and ran a cleanup pass to deduplicate and tag rows. Kevin then asked the bigger question: this fragmented, multi-script setup isn't what he actually wants — he wants ONE system, entity-centric, with specialized agents and a beautiful dashboard. KOS is the rebuild from that conversation.

## Constraints

- **Cloud**: AWS-primary (using $20k credits), Azure for AI Search ($5k credits), Google for Gemini long-context ($2k credits). Hetzner deprecated after migration.
- **Privacy**: Pragmatic — AWS for data, trusted vendors (Anthropic, Notion, Telegram) acceptable, no third-party cookie-holders for LinkedIn/WhatsApp (build those ourselves).
- **Language**: Swedish-first capture (voice, text). Bilingual SE/EN throughout. AWS Transcribe + Claude both handle Swedish well.
- **Timeline**: 8+ weekends to v1 (full quality, not rushed). Can ship sub-pieces sooner for early use.
- **Single-user**: Kevin only. No teams, no shared accounts, no permission system.
- **ADHD compatibility**: Zero categorization friction on input. Calm-by-default on output (no notification fatigue). Voice-first capture wherever possible.
- **Reversibility**: Everything reversible. No destructive operations without explicit Approve. Migration markers (e.g., `[MIGRERAD]`, `[SKIPPAT-DUP]`) prepended for audit trail.
- **Compliance**: GDPR (EU operations + Swedish entity data + working with EU child data via Tale Forge). Voice/email data stays in EU regions where possible (S3 eu-north-1, Bedrock us-east-1 acceptable since LLM doesn't store).
- **Cost**: Aim for ~$200-400/mo all-in steady state. Cloud credits cover ~12-18 months of inference + infra at production volume.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| AWS as primary cloud | $20k credits + existing Bedrock integration + deepest service catalog (RDS, S3, Lambda, EventBridge, SES, Transcribe, Secrets Manager) all in one account | — Pending |
| Custom Next.js dashboard, not Notion-as-UI | Kevin explicitly wants "beautiful dashboard with calendar"; Notion's UI is capped; PWA gives mobile + push | — Pending |
| ~~Claude Agent SDK for orchestration, not LangGraph/CrewAI~~ **REVISED 2026-04-23 (Wave 5):** Direct `@anthropic-ai/bedrock-sdk` calls (`AnthropicBedrock` client) from Lambda. Agent SDK's `query()` spawns `claude` CLI subprocess that esbuild strips in `--omit=optional` bundling; Lambda cannot exec it. Subagents-as-markdown-files pattern not used — each "agent" is now a dedicated Lambda handler calling Bedrock directly with structured-output prompts. Trade-off accepted: lose agent loops + MCP-native tool calls, gain deterministic latency + pure structured output. Downstream: Phase 6 AGT-04 (auto-context loader) must be redesigned as an explicit `loadContext(entityIds)` pre-invoke helper called from each agent's handler, NOT as an SDK pre-call hook. | Direct Bedrock SDK path proven in wave-5 live run (triage, voice-capture, entity-resolver). AGT-04 shape pending Phase 6 planning. | Revised |
| Notion as memory substrate (entities, projects, dossiers) | Already structured, human-inspectable, Notion runs 2,800 internal agents on this pattern; skip vector DB sprawl | — Pending |
| Azure AI Search for semantic memory | Hybrid search (keyword + vector + semantic ranking) is best-in-class; uses Azure credits | — Pending |
| Bedrock primary LLM, Vertex Gemini 2.5 Pro for long-context | Bedrock for daily Sonnet/Haiku calls (existing); Gemini 2.5 Pro 1M context for "load full entity dossier" calls | — Pending |
| AWS Transcribe (not Groq Whisper) | Native AWS integration, uses credits, decent Swedish; fallback to KB-Whisper self-hosted if accuracy fails on real Kevin voice | — Pending |
| Custom Chrome extension for LinkedIn (not Unipile) | Ban-safe (runs in Kevin's session); Unipile is €49/mo + cookie-on-vendor + LinkedIn Q1 2026 ban escalation | — Pending |
| Baileys for WhatsApp (all chats) | Active fork, lower RAM, voice notes pipe to AWS Transcribe; full-chat ingestion since Kevin has high tolerance | — Pending |
| EmailEngine self-hosted on Fargate | IMAP IDLE = push not poll, no Gmail rate concerns, two accounts in one container | — Pending |
| Postiz self-hosted (already in stack) | MCP-native, removes 30 req/hr cloud limit, social CLI for AI agents | — Pending |
| Bulk import existing Notion data | Faster onboarding than manual; Kontakter + Granola + Gmail signatures = ~50-80 entity seed; manual cleanup batch after | — Pending |
| Telegram bot as primary capture (not Discord) | Phone-native, voice-native, free, push notifications work, mobile + desktop sync | — Pending |
| 8+ weekends timeline | Production-grade build; Kevin will use this for years; no shortcuts | — Pending |
| Specialty agents (competitor/market/investor/legal) deferred to v2 | Core (capture + entities + dashboard + email) must work first; specialty agents add complexity that obscures core failures | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-21 after initialization*
