# Requirements: Kevin OS (KOS)

**Defined:** 2026-04-21
**Core Value:** Kevin never has to re-explain context. Every input gets routed automatically. Every output is context-aware. The system maintains itself; Kevin only writes raw input and reads curated output.

---

## v1 Requirements

All v1 requirements are hypotheses until shipped and validated. Requirements map to exactly one phase.

### Infrastructure Foundation (INF)

- [ ] **INF-01**: Project deployed as AWS CDK stack; single AWS account is primary cloud
- [ ] **INF-02**: RDS PostgreSQL 16 (`db.t4g.medium`, eu-north-1) with pgvector 0.8.0 extension enabled, schema versioned via Drizzle ORM migrations
- [ ] **INF-03**: S3 bucket (eu-north-1) for audio + documents + transcripts, with VPC Gateway Endpoint configured before any Lambda writes
- [ ] **INF-04**: Five EventBridge custom buses provisioned: `kos.capture`, `kos.triage`, `kos.agent`, `kos.output`, `kos.system`
- [ ] **INF-05**: AWS Lambda functions for all event-driven agent invocations (Node.js 22.x); Step Functions reserved for >15min bulk workflows only
- [ ] **INF-06**: AWS ECS Fargate tasks (ARM64) for long-running services: EmailEngine, Baileys, Postiz — one service per task
- [ ] **INF-07**: AWS Secrets Manager holds all API keys, OAuth tokens, and the static Bearer token for dashboard auth
- [ ] **INF-08**: AWS Transcribe configured with `sv-SE` and custom vocabulary file containing all entity names, company names, Swedish financial/legal terms, English tech terms Kevin uses in Swedish speech
- [ ] **INF-09**: Azure AI Search (Basic tier, West Europe) index created with binary quantization configured at index creation time; hybrid BM25 + vector + semantic reranker
- [ ] **INF-10**: Vertex AI Gemini 2.5 Pro wired (europe-west4) for long-context dossier loads only, with context caching enabled
- [ ] **INF-11**: Hetzner VPS decommissioned after migration complete
- [ ] **INF-12**: Vercel project for Next.js dashboard with environment secrets synced from AWS Secrets Manager

### Entity Graph (ENT)

- [ ] **ENT-01**: Notion `Entities` DB created with schema: Name (title), Aliases (text), Type (select: Person/Project/Company/Document), Org (text), Role (text), Relationship (select), Status (select), LinkedProjects (relation), SeedContext (text), LastTouch (date), ManualNotes (text), Confidence (number), Source (multi-select)
- [ ] **ENT-02**: Notion `Projects` DB created with schema: Name (title), Bolag (select), Status (select), Description (text), LinkedPeople (relation), SeedContext (text)
- [ ] **ENT-03**: Voice-onboarding flow for Add Person: tap → voice memo → Transcribe → Claude parses into structured fields → confirm → entity dossier saved in Notion + Postgres index
- [ ] **ENT-04**: Voice-onboarding flow for Add Project: same pattern as ENT-03
- [ ] **ENT-05**: Bulk import from existing Kontakter DB → propose dossiers → Kevin approves in batch via Inbox
- [ ] **ENT-06**: Bulk import: extract people from last 90 days of Granola transcripts + Gmail signatures → propose dossiers for confirmation
- [ ] **ENT-07**: Manual entity edit/merge UI on dashboard — Kevin can correct mistakes, merge duplicates; all merges logged to audit table
- [ ] **ENT-08**: Per-entity timeline view — chronological aggregation of every email, transcript mention, doc shared, task, decision involving that entity
- [ ] **ENT-09**: Entity resolver uses three-stage pipeline: fuzzy string match (>0.95 auto-merge with secondary signal only) → LLM disambiguation for 0.75-0.95 → Inbox confirm queue for <0.75 — never auto-merge without audit log

### Capture (CAP)

- [ ] **CAP-01**: Telegram bot (grammY on Lambda webhook mode) accepts text + voice messages from Kevin's user ID; voice transcribed via AWS Transcribe `sv-SE` with custom vocabulary; routes through triage
- [ ] **CAP-02**: iOS Shortcut on Action Button records audio → POSTs to HMAC-authed webhook → Lambda → Transcribe → triage; end-to-end < 25 seconds for a 10-second clip
- [ ] **CAP-03**: Email-forward address ingests forwarded emails via SES receiving rule → S3 → Lambda → triage → entity routing
- [ ] **CAP-04**: Chrome extension (Manifest V3, unpacked install) provides "Send to KOS" on any highlighted text; signed request to webhook
- [ ] **CAP-05**: Chrome extension reads LinkedIn DMs from Kevin's logged-in session via Voyager API; polls max once per 30 min, only when tab is actively focused; randomized 2-15s delays; silent failure with Dashboard alert on errors
- [ ] **CAP-06**: Self-hosted Baileys WhatsApp gateway on Fargate with session auth stored in RDS; strict read-only (no write/send/updateStatus methods invoked); 4-hour backoff on session rejection
- [ ] **CAP-07**: EmailEngine self-hosted on Fargate, IMAP IDLE on both Gmail accounts (kevin.elzarka@gmail.com + kevin@tale-forge.app); license procured before phase 4 ships
- [ ] **CAP-08**: Granola transcripts polled from Notion Transkripten DB every 15 min using `last_edited_time` filter; routed through transcript-extractor agent
- [ ] **CAP-09**: Google Calendar read integration (both accounts) surfaces today + tomorrow meetings in morning brief and per-entity context
- [ ] **CAP-10**: Discord #brain-dump kept as fallback capture (existing brain-dump-listener forwards to KOS webhook post-migration)

### Agent Layer (AGT)

- [ ] **AGT-01**: Triage agent (Haiku 4.5 via Bedrock, 60s/512MB Lambda) — every inbound event routes through triage first; decides which subagent(s) to invoke; hard-capped at 3 Telegram push messages per day
- [ ] **AGT-02**: Voice-capture agent (Haiku 4.5) — transcript → structured Notion row with auto-detected entities, project, type, urgency classification
- [ ] **AGT-03**: Entity-resolver agent (Sonnet 4.6) — extracts named entities from any text, fuzzy-matches to existing dossiers with three-stage pipeline (ENT-09), flags new ones for Inbox confirmation
- [ ] **AGT-04**: Auto-context loader — pre-call hook that extracts entity mentions, queries Postgres + Azure AI Search, injects ranked dossier blocks into downstream agent's system prompt; Kevin Context always prompt-cached
- [ ] **AGT-05**: Email-triage agent (Haiku 4.5 classify / Sonnet 4.6 draft) — classifies emails (urgent/important/informational/junk), drafts replies for urgent; idempotency key in RDS; email body wrapped in `<email_content>` delimiters to resist prompt injection
- [ ] **AGT-06**: Transcript-extractor agent (Sonnet 4.6) — reads Granola transcripts, extracts Kevin-action items to Command Center, updates entity dossiers with mention events
- [ ] **AGT-07**: Content-writer agent (Sonnet 4.6) — multi-channel content drafts (IG/LinkedIn/TikTok/Reddit/newsletter) using BRAND_VOICE.md + few-shot examples; never auto-publishes
- [ ] **AGT-08**: Publisher agent (Haiku 4.5) — schedules approved drafts via self-hosted Postiz only after explicit Approve tap

### Memory Layer (MEM)

- [ ] **MEM-01**: Notion is source of truth for all human-inspectable state; agents write Notion first, then publish `notion-write-confirmed` event that triggers Postgres upsert
- [ ] **MEM-02**: Kevin Context page (Notion) maintained continuously by agents + evening close task; prompt-cached on every agent call; contains Current priorities, Active deals/threads, Who's-who, Blocked on, Recent decisions, Open questions
- [ ] **MEM-03**: Azure AI Search indexes Granola transcripts, Daily Brief Log entries, chat history, email summaries; hybrid search surface accessible via `semantic_search` tool
- [ ] **MEM-04**: Per-entity timeline materialized view in Postgres refreshed every 5 min; union with live `mention_events` from last 10 min for freshness on hot entities
- [ ] **MEM-05**: Per-document version tracker — SHA + diff against previous version, per recipient; agent surfaces "what's changed since v3 went to Damien"

### Dashboard (UI)

- [ ] **UI-01**: Today view — calendar (today + tomorrow), Top 3 priorities, Drafts to review, Dropped threads, Voice/text dump zone
- [ ] **UI-02**: Per-entity pages (Person/Project/Company/Document) — full dossier with AI "What you need to know" block, chronological timeline, linked tasks/projects/documents with version status
- [ ] **UI-03**: Calendar view — meetings, deadlines, follow-ups, events from Command Center Deadline field
- [ ] **UI-04**: Inbox view — drafts awaiting approval, ambiguous entity routings, new entities to confirm; Approve / Edit / Skip actions
- [ ] **UI-05**: Desktop-primary responsive web app; installable to Android home screen and desktop via PWA manifest; iOS is Safari shortcut (not standalone PWA due to iOS 17.4 EU DMA removal)
- [ ] **UI-06**: Real-time updates via SSE from Next.js Edge backed by Postgres `LISTEN/NOTIFY`; Web Push for desktop-only urgent items; Telegram for mobile push

### Lifecycle Automation (AUTO)

- [ ] **AUTO-01**: 07:00 Stockholm — Morning brief agent writes 3-5 sentence prose brief + Top 3 + Calendar + Drafts ready + Dropped threads to 🏠 Today and Telegram
- [ ] **AUTO-02**: Every 2h weekdays 08:00-18:00 — Email triage runs on both accounts, drafts replies for urgent
- [ ] **AUTO-03**: 18:00 Stockholm — Day close: writes Daily Brief Log entry, updates Kevin Context, flags slipped items, posts evening summary to Telegram
- [ ] **AUTO-04**: Sunday 19:00 — Weekly review: full week recap + next-week candidates → Kevin Context + Telegram
- [ ] **AUTO-05**: Every 15 min — Transcript watcher polls Transkripten DB for new entries, runs extractor

### Migration (MIG)

- [ ] **MIG-01**: Migrate existing classify_and_save / morning_briefing / evening_checkin from Hetzner VPS to AWS Lambda, refactored to call new agent layer
- [ ] **MIG-02**: Decommission n8n on VPS once all flows migrated (port 5678 is unauthenticated security risk)
- [ ] **MIG-03**: Archive (don't delete) the 5 Brain DBs once entity graph is source of truth; migration-marker prepend to preserve audit trail
- [ ] **MIG-04**: Existing 167-row migration to Command Center stays; new system reads it as the task substrate

---

## v2 Requirements

Deferred to v2. Specifications may be written during v1 phases; code cannot ship until Gate 4 acceptance criteria are all simultaneously met (4 weeks daily use + morning brief acted on 5 days/week + entity resolver accuracy > 90% + email triage approval+edit rate > 70% + dashboard opened > 3 sessions/week).

### Specialty Agents (AGT v2)

- **AGT-09**: Competitor-watch agent — daily scan of App Store/Play Store/Reddit/Product Hunt/Meta Ad Library for 5 named competitors; two-stage classifier (Haiku score → Sonnet digest) with default-to-silence (no post if signal < 6); auto-creates "Consider X" task only for feature_launch + pricing_change at score ≥ 8
- **AGT-10**: Market-analyst agent — weekly Sunday sweep of Reddit parent subs + Familjeliv + RSS feeds + search trends → 3 post angles for Monika's Monday review
- **AGT-11**: Investor-relations agent — auto-loads cap table + Almi/Speed/Marcus context when investor topic detected; drafts updates; **requires DPIA before deployment per EU AI Act**
- **AGT-12**: Legal-flag agent — auto-flags avtal/aktie/ESOP/GDPR/AI Act context; loads Marcus dossier + relevant precedents; classifies severity for Kevin

---

## Out of Scope

Explicit exclusions. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| n8n in any form | EventBridge + Lambda handle routing in 20 lines; n8n visual workflow is 300+ lines overhead; current VPS n8n (port 5678, no auth) is live security risk |
| LangGraph / CrewAI / AutoGen | Claude Agent SDK subagents as markdown files is simpler at this scale; Python frameworks balloon to 5GB RAM |
| Auto-send emails | SES sends only after explicit Approve — safety gate |
| Auto-publish social content | Postiz schedules only after explicit Approve — safety gate |
| Auto-accept calendar invites | System reads, never books/accepts without explicit confirmation |
| iOS standalone PWA push notifications | iOS 17.4 removed in EU under DMA; Telegram is mobile push channel |
| Auto-categorization on capture | Categorization friction is #1 reason second-brain systems fail for ADHD users; classify async via triage |
| WhatsApp Business Cloud API | Cannot register pre-existing personal number; stays Baileys self-hosted |
| LinkedIn outbound automation | Read-only via Chrome extension; no auto-connect, no auto-DM; 23% ban rate on outbound automation |
| Unipile / hosted LinkedIn or WhatsApp wrappers | €49/mo + cookie on their servers + LinkedIn Q1 2026 ban escalation; build our own Chrome extension and Baileys |
| Multi-tenant / team accounts | KOS is single-user (Kevin); no shared accounts, no permission system — can revisit later |
| Self-hosted LLM | Bedrock + Anthropic API cheaper and smarter at our volume; revisit only if compliance demands |
| Custom voice cloning | Tale Forge product concern, not OS concern |
| Mobile-native iOS/Android apps | PWA + Telegram cover capture; native apps deferred unless PWA falls short |
| Slack integration | Kevin doesn't use Slack daily |
| GitHub integration v1 | Deferred to v2; not load-bearing for daily flow |
| Postiz analytics dashboard | Content goes out via Postiz; analytics are read by market-analyst agent only |
| Aurora Serverless v2 | HNSW pgvector degradation + 17% cost premium over RDS db.t4g.medium for predictable workload |
| AppSync / Pusher / Supabase Realtime | SSE via Postgres LISTEN/NOTIFY is sufficient for single-user; Notify is native to Postgres |
| Cognito / Clerk | Bearer token in Secrets Manager is sufficient for single-user; no auth infrastructure needed |
| Prisma | Drizzle ORM is lighter, typed, and integrates pgvector via extension; Prisma adds nothing at this scale |
| python-telegram-bot | KOS is TypeScript monorepo; grammY removes Python runtime |
| Always-on local Whisper | AWS Transcribe `sv-SE` with custom vocabulary is primary; self-hosted Whisper large-v3 on Fargate is fallback only if WER > 15% on real Kevin voice |

---

## Traceability

Populated during roadmap creation. Each v1 requirement maps to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INF-01 | Phase 1 | Pending |
| INF-02 | Phase 1 | Pending |
| INF-03 | Phase 1 | Pending |
| INF-04 | Phase 1 | Pending |
| INF-05 | Phase 1 | Pending |
| INF-06 | Phase 1 | Pending |
| INF-07 | Phase 1 | Pending |
| INF-08 | Phase 1 (custom vocab); Phase 2 (WER gate) | Pending |
| INF-09 | Phase 1 | Pending |
| INF-10 | Phase 6 | Pending |
| INF-11 | Phase 10 | Pending |
| INF-12 | Phase 3 | Pending |
| ENT-01 | Phase 1 | Pending |
| ENT-02 | Phase 1 | Pending |
| ENT-03 | Phase 2 | Pending |
| ENT-04 | Phase 2 | Pending |
| ENT-05 | Phase 2 | Pending |
| ENT-06 | Phase 2 | Pending |
| ENT-07 | Phase 3 | Pending |
| ENT-08 | Phase 3 | Pending |
| ENT-09 | Phase 2 | Pending |
| CAP-01 | Phase 2 | Pending |
| CAP-02 | Phase 4 | Pending |
| CAP-03 | Phase 4 | Pending |
| CAP-04 | Phase 5 | Pending |
| CAP-05 | Phase 5 | Pending |
| CAP-06 | Phase 5 | Pending |
| CAP-07 | Phase 4 | Pending |
| CAP-08 | Phase 6 | Pending |
| CAP-09 | Phase 8 | Pending |
| CAP-10 | Phase 10 | Pending |
| AGT-01 | Phase 2 | Pending |
| AGT-02 | Phase 2 | Pending |
| AGT-03 | Phase 2 | Pending |
| AGT-04 | Phase 6 | Pending |
| AGT-05 | Phase 4 | Pending |
| AGT-06 | Phase 6 | Pending |
| AGT-07 | Phase 8 | Pending |
| AGT-08 | Phase 8 | Pending |
| MEM-01 | Phase 1 | Pending |
| MEM-02 | Phase 1 | Pending |
| MEM-03 | Phase 6 | Pending |
| MEM-04 | Phase 6 | Pending |
| MEM-05 | Phase 8 | Pending |
| UI-01 | Phase 3 | Pending |
| UI-02 | Phase 3 | Pending |
| UI-03 | Phase 3 | Pending |
| UI-04 | Phase 3 | Pending |
| UI-05 | Phase 3 | Pending |
| UI-06 | Phase 3 | Pending |
| AUTO-01 | Phase 7 | Pending |
| AUTO-02 | Phase 7 | Pending |
| AUTO-03 | Phase 7 | Pending |
| AUTO-04 | Phase 7 | Pending |
| AUTO-05 | Phase 6 | Pending |
| MIG-01 | Phase 10 | Pending |
| MIG-02 | Phase 10 | Pending |
| MIG-03 | Phase 10 | Pending |
| MIG-04 | Phase 1 (freeze) / Phase 10 (archive) | Pending |

**Coverage:**
- v1 requirements: 54 total
- Mapped to phases: 54
- Unmapped: 0 ✓

---

*Requirements defined: 2026-04-21*
*Last updated: 2026-04-21 after initialization*
