# Feature Research

**Domain:** Entity-centric personal AI operating system / second brain / personal CRM hybrid
**Researched:** 2026-04-21
**Confidence:** HIGH (primary claims verified across multiple current sources; specific product claims MEDIUM where based on single reviews)

---

## Competitive Landscape Summary

Products surveyed: Mem.ai (rebuilt as Mem 2.0, Oct 2025), Reflect, Saner.ai, Clay/Mesh (formerly Clay.earth), Dex, Affinity, Notion AI (3.0/3.2), mem0 (memory layer), Alfred_, Tana, NotebookLM, ADHD for Founders, Recallify.

**The gap KOS exploits:** Every existing product either (a) does memory/capture well but has no action layer, or (b) does CRM/relationship well but has no multi-channel ingest + agent automation. None of them handle Swedish-English bilingual voice-first capture + entity-centric memory + specialized agent suite + custom dashboard in a single owned system. KOS is purpose-built for one person; all competitors must serve thousands.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features that, if missing, make the system feel broken or incomplete on day one.

| Feature | Why Expected | Complexity | Daily Use Freq | Notes |
|---------|--------------|------------|----------------|-------|
| Voice capture with transcription | ADHD-mandatory; typing barrier kills capture; 1-in-4 YC companies are voice-first 2026 | M | Very High (10+ times/day) | AWS Transcribe + Swedish; Action Button iOS Shortcut already specced as CAP-02 |
| Mobile-accessible PWA | Kevin is mobile-first; capture and read-on-go is the whole point | M | High (every session) | Already specced as UI-05; PWA + Telegram covers 95% of mobile needs |
| Telegram bot as primary capture channel | Phone-native, voice-native, push works, free; Kevin already uses it | S | Very High | Already specced as CAP-01; critical for zero-friction |
| Full-text + semantic search across all memory | Can't use a second brain you can't search; 2026 consensus: hybrid BM25 + semantic beats pure keyword by 10-30% | L | High (multiple times/day) | Azure AI Search hybrid already specced as MEM-03 |
| Per-entity page (living dossier) | Entity-centric is the core value; without this it's just a dump | M | High (every entity interaction) | Clay/Mesh, Dex, Affinity all anchor on this; specced as UI-02 |
| Entity timeline | User expects to see "everything about Javier" in one scroll | M | High | Every email, meeting, doc, task in chronological order; specced as ENT-08/MEM-04 |
| Email ingest + triage | Two Gmail accounts are Kevin's primary async communication layer | L | Very High | EmailEngine IMAP IDLE already specced; AGT-05 for triage |
| Morning briefing | Alfred_, Saner.ai, every executive tool does this; absence feels broken | M | Daily (1x) | AUTO-01 already specced; key is action-oriented not passive |
| Approval queue (Inbox view) | Without this, agents act blind — or don't act at all | M | High (every drafting cycle) | Specced as UI-04; critical path for email triage value |
| Auto-context loading before LLM calls | This IS the core value: "Kevin never re-explains context" | L | Very High (every agent call) | The AGT-04 auto-context-loader; SOTA pattern is query memory → inject into system prompt pre-call |
| Cross-device sync | Data captured on phone must be searchable on desktop and vice versa | S | High | Notion as substrate handles this; PWA dashboard adds it for UI |
| Entity creation from raw mentions | If Kevin mentions "Javier" in a voice memo and nothing happens, the system fails | M | High | AGT-03 entity-resolver; new entities flagged for confirmation is the pattern |

### Differentiators (Competitive Advantage)

Features that make KOS meaningfully better than any available alternative.

| Feature | Value Proposition | Complexity | Daily Use Freq | Notes |
|---------|-------------------|------------|----------------|-------|
| Swedish-first bilingual capture + memory | No competitor handles Swedish-English code-switching in voice transcription + entity resolution | M | Very High | AWS Transcribe Swedish; Claude handles bilingual naturally; unique to Kevin's context |
| Multi-channel ingest (email + WhatsApp + LinkedIn DM + Granola + Discord + voice + browser) | Competitors pick 2-3 channels; KOS ingests all 8+ Kevin actually uses | L | Very High | CAP-01 through CAP-10; the completeness is the moat |
| Specialized agent suite (transcript-extractor, email-triage, investor-relations, legal-flag) | Generic AI tools use one LLM for everything; KOS routes by domain for precision | L | High | AGT-01 through AGT-08; domain-specific system prompts + context = better outputs |
| Granola transcript → entity dossier pipeline | No competitor auto-extracts meeting participants + action items + entity updates from meeting transcripts | M | High (every meeting) | AGT-06; specced as every-15-min poll; massive time save |
| Document version + recipient tracking | "What version of the pitch deck did I send Marcus vs Almi vs Speed?" — no personal tool does this | L | Medium (per doc send event) | MEM-05; SHA + diff per recipient; unique capability |
| Investor/legal context auto-loading | When "konvertibellån" or "Almi" appears in any channel, the system pre-loads the full deal context | L | Medium (several times/week) | AGT-11, AGT-12 v2; massive cognitive save for complex deals |
| Competitor-watch agent (default-to-silence) | Most monitoring tools spam; KOS uses two-stage classifier with silence default | M | Low (weekly digest) | AGT-09 v2; "calm by default" applied to competitive intel |
| Voice entity onboarding | Tap → speak "Add person: Javier Soltero, CEO at Lovable, contact via OpenClaw network" → structured dossier | M | Low (onboarding) | ENT-03/ENT-04; hybrid voice-first then confirm UI is SOTA pattern; no competitor does this for personal use |
| Brand-voice-aware content drafting | Content-writer agent uses BRAND_VOICE.md + few-shot examples; output sounds like Kevin | M | Medium (several times/week) | AGT-07; most AI writing tools ignore personal brand voice |
| Bulk import with AI-proposed dossiers | Import 50-80 contacts from Granola + Gmail signatures + Notion Kontakter → Kevin batch-approves in one session | M | One-time (onboarding) | ENT-05/ENT-06; reduces cold-start problem dramatically |
| Calm-by-default notification design | Urgent items only via Telegram + Web Push; everything else batched into scheduled digests | S | Very High (background) | 2026 UX consensus: batch non-urgent; urgency threshold is explicit classifier output |
| Custom Next.js dashboard with calendar | Competitors are either generic note apps or CRMs; KOS has a purpose-built UI for Kevin's actual workflow | L | High | UI-01 through UI-05; Notion UI is too generic; this is the daily driver |
| Dropped threads detection | System flags follow-up items that have gone cold without Kevin noticing | M | Daily (part of morning brief) | Part of AUTO-01; "dropped threads" surface in briefing and Today view |

### Anti-Features (Deliberately NOT Building)

Things that seem useful but create more problems than they solve.

| Anti-Feature | Why Requested | Why Problematic | What to Do Instead | Complexity Avoided |
|--------------|---------------|-----------------|--------------------|--------------------|
| Auto-send emails | "Saves time, removes friction" | AI models destroyed emails/files without permission in documented 2026 incidents; a single wrong send to Almi or Marcus could derail a deal; no recovery | Draft + Approve queue; SES sends only after explicit Approve tap | HIGH |
| Auto-accept calendar invites | "Frictionless scheduling" | Kevin's calendar is a priority signal; auto-accept removes agency over one of the most important inputs to his day | Surface invite in Today view with context; Kevin taps Accept | LOW |
| Auto-connect / auto-DM on LinkedIn | "Scale networking" | LinkedIn Q1 2026 ban escalation; mass outreach destroys personal brand; Kevin's value is quality relationships | Read-only Chrome extension; Kevin initiates personally | HIGH |
| WhatsApp Business API migration | "More reliable, cloud-hosted" | Kevin's personal number cannot move to Business API; attempting it risks losing number; vendor cookie risk | Baileys self-hosted on Fargate; personal number stays personal | HIGH |
| Slack integration (v1) | "Comprehensive coverage" | Kevin doesn't use Slack daily; adding it adds complexity, webhook maintenance, and cognitive overhead for zero daily value | Discord #brain-dump already covered; revisit if usage changes | MEDIUM |
| Real-time notification for every ingest event | "Stay up to date" | 2026 UX research: notification fatigue is the #1 reason users abandon productivity tools; ADHD brains are especially vulnerable to interrupt-driven patterns | Batch non-urgent into digests; urgent-only for push (threshold: classifier flags as "urgent") | LOW |
| Multi-user / team accounts | "What if I want to share with Damien or Simon?" | Single-user assumption is load-bearing for the entity model, privacy design, and agent trust chain; multi-tenancy is a 6-month rebuild | Share specific context explicitly when needed; KOS stays personal | HIGH |
| Self-hosted LLM | "Privacy, cost control" | Bedrock + Anthropic are smarter and cheaper at Kevin's volume; self-hosting adds ops burden, degrades Swedish quality, slows every inference | Bedrock primary; Vertex Gemini for long-context; revisit if compliance demands | VERY HIGH |
| Auto-categorize-on-capture (require tags) | "Better organization" | Categorization friction is the #1 reason second-brain systems fail for ADHD users; requiring a tag at capture creates an activation energy barrier that kills the habit | Capture raw, classify async by agent in background | LOW |
| Auto-publish content | "End-to-end automation" | Brand content going out without Kevin's eyes is a reputational risk; one wrong post (especially re: investors/partners) can damage relationships | Draft → Approve → Postiz schedules; Publisher agent never sends without explicit Approve | MEDIUM |
| Competitor scraping at high frequency | "Always know what's happening" | High-frequency scraping risks detection/blocking and creates noise that numbs the signal | Weekly digest with two-stage classifier defaulting to silence; only surface material changes | MEDIUM |

---

## Specific Pattern Analysis (10 Questions)

### 1. Entity Onboarding UX: Voice-First Hybrid is SOTA

**Verdict:** Voice-first with structured confirm step, not form-first.

The 2026 pattern for personal AI is: tap (iOS Action Button or Telegram command) → speak raw description → Whisper/Transcribe extracts structured fields → confirm screen shows proposed fields → one-tap approve. Form-first onboarding fails for ADHD users because blank forms require executive function to fill; voice removes the initiation barrier. Pure voice-only without a confirm step fails because structured data (aliases, company, role, relationship type) needs validation before storage.

**KOS implementation:** ENT-03/ENT-04 voice onboarding is correct. Add a confirm card that shows: Name (auto), Aliases (editable), Company, Role, Relationship, and a "Looks right?" binary approve. Bulk import (ENT-05/ENT-06) is the correct cold-start strategy — get 50-80 entities seeded in batch so the system is useful from day one.

**Competitors:** No competitor (Reflect, Mem.ai, Saner.ai, Dex) offers voice-first entity onboarding for personal use. Clay/Mesh does it via enrichment automation but not voice. This is a genuine KOS differentiator.

### 2. Per-Entity Context Loading: Pre-Call Hook is SOTA

**Verdict:** Query memory → ranked retrieval → inject into system prompt before every LLM call.

The SOTA pattern (confirmed via mem0 v2.0.0 architecture, Spring AI AutoMemoryTools, OpenAI Agents SDK context personalization docs): when an entity name appears in any input, the auto-context loader fires BEFORE the main LLM call. It:
1. Extracts entity names from the incoming message (entity-resolver agent output)
2. Queries Azure AI Search with entity names as filters + semantic query
3. Ranks results (hybrid BM25 + semantic, RRF fusion)
4. Truncates to fit context budget (Gemini 2.5 Pro 1M tokens for deep loads; Sonnet for standard calls)
5. Injects as a structured block in the system prompt: `<entity_context name="Javier Soltero">...</entity_context>`

The Kevin Context page (MEM-02) is always loaded (prompt-cached in Bedrock) as the base layer; entity-specific context is layered on top per-call. This is exactly what AGT-04 specifies.

**Key insight from research:** mem0's v2.0.0 single-pass extraction reduced latency ~50%. For KOS, prompt-caching the Kevin Context page (stable, changes nightly) + dynamic per-entity injection is the right split.

### 3. Document Version Awareness: SHA + Recipient Log

**Verdict:** SHA hash per version + recipient log with timestamp + diff surface on entity page.

No personal AI product implements this fully. Enterprise document management (Adobe, RecordsKeeper.AI) tracks versions but not "sent to whom" at a personal level. The KOS approach (MEM-05) is correct and differentiated: for every document (pitch deck, avtal draft, investment memo), store: SHA of the blob, version number, timestamp, recipient entity IDs, and a diff summary generated by Claude between version N and N-1.

Surface on the entity dossier page as: "Last sent: v3 of Pitch Deck (2026-04-15, 3 days ago). v4 has 2 new slides since then."

**KOS implementation note:** S3 stores the blobs; Postgres stores version metadata + recipient log; diff generation is a background Lambda job triggered on new version creation. The UI surface is on both the document entity page and the recipient entity pages.

### 4. Approval Queue UX: Batched, Contextual, Low-Friction

**Verdict:** Batched cadence (not real-time) + full context inline + binary actions (Approve/Edit/Skip) + auto-expiry.

2026 UX research identifies "Review Fatigue" as the primary failure mode for AI approval queues: humans rubber-stamp without reading because the cognitive cost of audit exceeds the benefit. The counter-patterns that work:

- **Batch, not real-time:** Show 2h email triage results together (e.g., 4 draft replies), not one ping per email
- **Full context inline:** Show the original email + proposed reply in the same card; no navigation required
- **Binary actions max 3:** Approve (sends) / Edit (opens editor) / Skip (archives without action). No "maybe later" — it creates unbounded queue growth
- **Confidence score visible:** Show "85% confident this reply is correct" with reasoning; high-confidence items easy to approve; low-confidence flagged visually
- **Auto-expiry:** Draft replies expire after 24h with a notification; prevents stale queue buildup
- **Group by urgency:** Urgent at top, informational at bottom; Kevin processes in priority order

**KOS implementation:** UI-04 Inbox view is the right concept. Add confidence score display + auto-expiry logic to prevent queue debt accumulation.

### 5. Calm-by-Default Notifications: Urgency Classifier + Batched Digests

**Verdict:** Classify urgency at ingest → urgent items get immediate Telegram push → everything else batches into scheduled digests.

2026 best practice (confirmed: Apple Intelligence digest model, Daywise app pattern, Android batch notifications):
- **Immediate push:** Only items the triage agent classifies as "urgent" (requires response today, involves active deal, contains deadline)
- **Scheduled batch:** Every 2h bucket surfaced in Inbox view; no push notification for each
- **Morning brief:** One push at 07:00 with the briefing; actionable before first meeting
- **Evening summary:** One push at 18:00 with day-close; silent otherwise
- **Weekly digest:** Sunday 19:00; one push

The key implementation detail: the urgency classifier (part of AGT-01 triage agent) must be calibrated conservatively. False positives (over-notifying) destroy the system faster than false negatives (missing one urgent item). Start with a high threshold; Kevin can lower it if he misses things.

**Anti-pattern to avoid:** Notifying Kevin every time an entity is mentioned, every time a transcript is processed, every time an ingest completes. These are internal system events. Kevin only needs to know about items requiring his action.

### 6. Daily/Weekly Briefing Format: Structured Prose + Action Items

**Verdict:** 3-5 sentence structured prose (not a bullet wall) + top 3 action items + calendar + one "dropped thread" flag.

Research synthesis (alfred_, lead-with-AI executive briefing guides, Saner.ai pattern): the briefing that gets read and acted on in 2026 has this anatomy:

```
[Prose paragraph: What happened since last night, key context shifts — 3-5 sentences]

TOP 3 TODAY:
1. [Action] — [entity + why urgent]
2. [Action] — [entity + why urgent]
3. [Action] — [entity + why urgent]

CALENDAR: [Meeting 1, 09:00 — Javier re Lovable — last spoke 3 days ago about X] / [...]

DRAFTS READY: [N email replies awaiting your Approve]

DROPPED: [Thread with Emma Burman (Almi) — last contact 5 days ago, no response to your question re bolagsstämma date]
```

**Key insight:** Prose wins over pure bullets for context comprehension; bullets win for scanability. The hybrid structure above delivers both. The "Dropped threads" section is the highest-value ADHD-specific element — it surfaces the items Kevin would forget to follow up on without the system.

**What doesn't work:** Pure bullet lists with no context (information without meaning), overly long prose (never read), notifications instead of a surfaced document (interrupts the day), and briefings that don't include actionable items (informational-only briefings stop being read within 2 weeks).

### 7. Cross-Source Entity Resolution: Fuzzy Match + LLM Disambiguation + Human Confirm

**Verdict:** Three-stage pipeline: (1) fuzzy string match with conservative threshold, (2) LLM disambiguation for ambiguous cases, (3) human confirm for unresolved.

Research findings: Pure fuzzy matching at 0.75 threshold catches more duplicates but has 12-16% accuracy gap (false merges). At 0.90 it misses semantic duplicates like "T. Gupta" ↔ "Tejus Gupta". The 2026 pattern (confirmed: WinPure, FutureSearch, Dynamics 365 DeDupeD) uses a hybrid:

**Stage 1 — Candidate generation:** Fuzzy match on name (Levenshtein distance) + company + email domain. Produces candidate pairs with confidence score.

**Stage 2 — LLM disambiguation:** For candidates scoring 0.70-0.90, pass both entity profiles to Claude with prompt: "Are 'Javier' (mentioned in voice memo, no last name) and 'Javier Soltero' (LinkedIn profile, CEO Lovable) the same person? Context: [full profiles]. Answer YES/NO/UNCERTAIN with reasoning." YES above 0.85 LLM confidence → auto-merge with audit log. UNCERTAIN → human confirm queue.

**Stage 3 — Human confirm queue:** Presented in UI-04 Inbox view as "New entity proposals" — "Is this Javier (voice memo) the same as Javier Soltero (LinkedIn)? [Merge] [Keep separate] [Rename]". Kevin resolves in batch, not one-by-one.

**Critical rule:** Never auto-merge without audit log. A merge is reversible (split is hard). Always show what was merged and when.

**KOS implementation:** AGT-03 entity-resolver already specced for fuzzy-match + flag new entities. Add the LLM disambiguation pass and the confirm queue surfacing.

### 8. Search UX: Natural Language Primary + Hybrid Retrieval Behind It

**Verdict:** Natural language query box (no mode switching) backed by hybrid BM25 + semantic + entity-filter retrieval with RRF fusion.

2026 consensus is definitive: hybrid search outperforms single-strategy by 10-30% on personal knowledge bases. The UX implication: one search box that accepts "What did Javier say about the OpenClaw network?" and the system handles routing internally (semantic for meaning, BM25 for "OpenClaw" exact match, entity filter for "Javier").

**UX pattern:** Single input, natural language, auto-suggests entity names after 2+ characters typed. Results show: source type (email / transcript / voice / note), entity badge, date, confidence score, and excerpt. "Chat over your data" mode (Mem.ai, Saner.ai both have this) is the premium experience: conversational follow-ups with context retention.

**What doesn't work:** Mode-switching between "keyword search" and "AI search" — users don't want to decide. Showing raw DB results without excerpts. Not surfacing the source — Kevin needs to know if something came from an email vs a voice memo vs a meeting transcript.

### 9. ADHD-Specific Features That Actually Get Used Daily

**Verdict (based on research across Alfred_, Saner.ai, ADHD for Founders, Recallify, alfred_):**

The features that survive past the first 2 weeks for ADHD founders:

1. **Zero-categorization capture** — raw voice dump that gets structured by agent later; categorization at capture kills the habit
2. **Draft-first email triage** — editing a draft is ~60% lower cognitive load than writing from scratch; this is the highest-ROI ADHD feature
3. **Dropped threads surfaced proactively** — working memory overflow means Kevin genuinely forgets; the system surfaces it in the briefing unprompted
4. **Top 3 priorities in morning brief** — not Top 10; not "everything urgent"; exactly 3; forces the system to prioritize so Kevin doesn't have to
5. **Voice entity onboarding** — form fatigue is an ADHD dealbreaker; voice-first is the difference between "system I use" and "system I intended to use"
6. **No tagging required** — agents tag entities and types automatically; Kevin never sees a "tag this note" prompt
7. **Today view with calendar** — single pane showing today's meetings + top 3 + drafts; no navigation required for 80% of daily use
8. **Entity name autocomplete** — typing "Jav" surfaces "Javier Soltero"; reduces the mental effort of linking new input to existing context
9. **Batched approval queue** — seeing 4 draft replies together at 2h intervals is manageable; getting pinged 40 times/day is not

Features that sound ADHD-friendly but don't stick: gamification, streaks, body-doubling rooms, focus sprints (all from ADHD for Founders / Recallify). These serve the "consumer ADHD" market, not the founder-operator market. Kevin's ADHD accommodation is executive function offloading, not motivation scaffolding.

### 10. Living Dossier UX: What a Great Per-Entity Page Looks Like

**Verdict:** Three sections — Summary header, Timeline, and Linked context — with AI-synthesized "What you need to know" as the above-the-fold block.

Best-in-class pattern synthesized from Clay/Mesh, Dex, Affinity, and Notion AI entity pages:

**Section 1 — Above the fold (always visible):**
- Name + type badge (Person / Project / Company / Document)
- Current role + org + last touch date
- **"What you need to know"** — 3-4 sentence AI summary of the relationship: who they are, current status, last action, what's pending. Regenerated on every dossier load (not cached).
- Quick action buttons: [Draft email] [Log note] [Voice memo] [View timeline]

**Section 2 — Timeline (chronological, newest first):**
- Email (subject, 1-line summary, link to full)
- Meeting transcript (meeting title, Kevin's action items extracted, date)
- Voice memo (auto-transcribed excerpt)
- Document sent/received (version, diff indicator if updated since last send)
- LinkedIn/WhatsApp/Discord message (source badge)
- Decision logged (manually or agent-extracted)
- Filter by: All / Email / Meetings / Docs / Voice / Notes

**Section 3 — Linked context:**
- Related projects (linked entities)
- Related companies
- Related documents (with version status)
- Todos / action items tagged to this entity (from Command Center)

**KOS implementation:** UI-02 per-entity pages already specced. The differentiator is the AI-synthesized "What you need to know" block — Clay/Mesh does relationship strength scoring; KOS does full narrative synthesis from the entire dossier. This is only possible with Gemini 2.5 Pro's 1M context window (INF-10) for deeply established entities.

---

## Feature Dependencies

```
Entity Graph (ENT-01/ENT-02)
    └──required by──> Auto-context Loader (AGT-04)
    └──required by──> Entity Timeline (ENT-08/MEM-04)
    └──required by──> Per-entity Page (UI-02)
    └──required by──> Entity Resolver (AGT-03)

Entity Resolver (AGT-03)
    └──required by──> All ingest pipelines (CAP-01 through CAP-10)
    └──enhances──> Entity Timeline (richer attribution)

Multi-channel Ingest (CAP-01 to CAP-10)
    └──required by──> Entity Timeline (content to display)
    └──required by──> Morning Brief (content to synthesize)
    └──required by──> Approval Queue (drafts to review)

Azure AI Search / Memory Layer (MEM-03)
    └──required by──> Auto-context Loader (AGT-04)
    └──required by──> Search UX (UI search box)
    └──required by──> Morning Brief synthesis (AGT running brief)

Triage Agent (AGT-01)
    └──required by──> Email Triage Agent (AGT-05)
    └──required by──> Calm Notifications (urgency signal)
    └──required by──> Approval Queue population (UI-04)

Approval Queue (UI-04)
    └──required by──> Email send (AWS SES blocked until approved)
    └──required by──> Content publish (Postiz blocked until approved)
    └──required by──> Entity merge (blocked until human confirms)

Document Version Tracker (MEM-05)
    └──enhances──> Per-entity Page (version status display)
    └──enhances──> Morning Brief ("version drift" alerts)

Morning Brief (AUTO-01)
    └──requires──> Entity Graph (entity mentions)
    └──requires──> Ingest pipelines (overnight activity)
    └──requires──> Command Center (task status)
    └──requires──> Google Calendar (today's meetings)

Content Writer (AGT-07) ──requires──> BRAND_VOICE.md + few-shot examples
Publisher (AGT-08) ──requires──> Approval Queue (content approved first)
Publisher (AGT-08) ──requires──> Postiz self-hosted (scheduling layer)

v2 Agents (AGT-09 through AGT-12)
    └──require──> Entity Graph stable (need deal/company context)
    └──require──> Morning Brief working (digest channel exists)
    └──should not be built until──> Core v1 validated
```

### Key Dependency Notes

- **Entity Graph is the critical path.** Nothing else works without ENT-01/ENT-02 complete and seeded with real data. This is Phase 1.
- **Capture precedes memory.** Ingest pipelines must work before the timeline has content and before the briefing is valuable.
- **Approval Queue is a safety gate.** Email send and content publish are hard-blocked behind explicit Approve. This is not optional — it is the contract with Kevin that the system won't act in his name.
- **Morning Brief must wait for ingest.** A briefing that runs before emails and transcripts are ingested is meaningless. The 07:00 brief must follow overnight email ingestion (EMAIL continuous via IMAP IDLE) and transcript poll (every 15 min).
- **v2 agents (competitor/market/investor/legal) must NOT be built until core is daily-use stable.** Adding complexity to a system Kevin isn't yet trusting daily is the fastest path to abandonment.

---

## MVP Definition

### Launch With (v1 — 8 weekends)

The minimum set that makes KOS genuinely useful for Kevin's daily operation, not just functional.

- [ ] **Entity Graph** (ENT-01, ENT-02) — schema complete, seeded with 50-80 entities from bulk import
- [ ] **Bulk import** (ENT-05, ENT-06) — Kontakter + Granola + Gmail signatures → batch approve
- [ ] **Voice entity onboarding** (ENT-03, ENT-04) — new person/project via Action Button
- [ ] **Telegram bot capture** (CAP-01) — text + voice → transcribe → entity-route → Notion
- [ ] **iOS Action Button** (CAP-02) — voice memo → structured row < 5 sec
- [ ] **Email ingest + triage** (CAP-07, AGT-05) — IMAP IDLE, draft replies, 2h cadence
- [ ] **WhatsApp ingest** (CAP-06) — Baileys, all chats
- [ ] **Granola transcript pipeline** (CAP-08, AGT-06) — 15-min poll, action extraction
- [ ] **Auto-context loader** (AGT-04) — entity dossier injected before every LLM call
- [ ] **Entity resolver** (AGT-03) — fuzzy match → LLM disambiguate → human confirm queue
- [ ] **Azure AI Search** (MEM-03) — hybrid search across all ingested content
- [ ] **Morning brief** (AUTO-01) — structured prose + top 3 + calendar + drafts + dropped threads
- [ ] **Evening close** (AUTO-03) — daily brief log, Kevin Context update, slipped items flag
- [ ] **Today view** (UI-01) — calendar + top 3 + drafts + voice dump zone
- [ ] **Per-entity pages** (UI-02) — full dossier + timeline + linked tasks + "what you need to know"
- [ ] **Inbox / Approval Queue** (UI-04) — drafts + new entities + ambiguous routings
- [ ] **PWA** (UI-05) — installable iOS/Android home screen

### Add After Validation (v1.x)

- [ ] **LinkedIn DM ingest** (CAP-05) — Chrome extension; add once core is stable
- [ ] **Chrome highlight → KOS** (CAP-04) — add once core is stable
- [ ] **Content writer + publisher** (AGT-07, AGT-08) — add once email triage is trusted
- [ ] **Weekly review** (AUTO-04) — add once daily brief rhythm is established
- [ ] **Calendar view** (UI-03) — add as dashboard enhancement after Today view is daily-used
- [ ] **Document version tracker** (MEM-05) — add when Kevin starts sending versioned docs through KOS

### Future Consideration (v2+)

- [ ] **Competitor-watch agent** (AGT-09) — after core is daily-use
- [ ] **Market-analyst agent** (AGT-10) — after core is daily-use
- [ ] **Investor-relations agent** (AGT-11) — after Almi/Speed deals close (less urgent then)
- [ ] **Legal-flag agent** (AGT-12) — after core is daily-use
- [ ] **Discord ingest active** (CAP-10) — currently fallback; may not need if Telegram primary works
- [ ] **GitHub integration** — explicitly deferred per PROJECT.md

---

## Feature Prioritization Matrix

| Feature | User Value | Impl Cost | Priority |
|---------|------------|-----------|----------|
| Entity Graph schema + seed | HIGH | MEDIUM | P1 |
| Voice capture (Telegram + Action Button) | HIGH | LOW | P1 |
| Email ingest + triage + drafts | HIGH | HIGH | P1 |
| Auto-context loader | HIGH | HIGH | P1 |
| Morning brief | HIGH | MEDIUM | P1 |
| Per-entity page (living dossier) | HIGH | MEDIUM | P1 |
| Approval queue (Inbox view) | HIGH | MEDIUM | P1 |
| Azure AI Search hybrid | HIGH | MEDIUM | P1 |
| Entity resolver (fuzzy + LLM) | HIGH | MEDIUM | P1 |
| WhatsApp ingest | MEDIUM | MEDIUM | P1 |
| Granola transcript pipeline | HIGH | MEDIUM | P1 |
| PWA / mobile dashboard | HIGH | MEDIUM | P1 |
| Bulk import with AI dossiers | HIGH | MEDIUM | P1 |
| Voice entity onboarding | MEDIUM | MEDIUM | P1 |
| Calm notification design | HIGH | LOW | P1 |
| Today view | HIGH | LOW | P1 |
| LinkedIn DM ingest | MEDIUM | HIGH | P2 |
| Chrome highlight ingest | MEDIUM | LOW | P2 |
| Content writer + publisher | MEDIUM | MEDIUM | P2 |
| Document version tracker | MEDIUM | HIGH | P2 |
| Calendar view (full) | MEDIUM | LOW | P2 |
| Weekly review automation | MEDIUM | LOW | P2 |
| Competitor-watch agent | LOW | MEDIUM | P3 |
| Market-analyst agent | LOW | MEDIUM | P3 |
| Investor-relations agent | LOW | HIGH | P3 |
| Legal-flag agent | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for v1 — system is not useful without it
- P2: Should have — adds significant value, add after v1 is daily-used
- P3: Nice to have — future consideration after v2 threshold

---

## Competitor Feature Analysis

| Feature | Reflect | Mem.ai (2.0) | Saner.ai | Clay/Mesh | Dex | KOS |
|---------|---------|--------------|----------|-----------|-----|-----|
| Voice capture | Basic (transcribe only) | Yes (voice mode, Oct 2025) | Yes | No | No | Yes — Swedish-first, Action Button |
| Entity/contact pages | Backlink-based (not entity-typed) | Memory graph | No | Yes — enriched | Yes — relationship timeline | Yes — full dossier with AI synthesis |
| Multi-channel ingest | Notes + calendar | Notes only | Notes + email + calendar | Email + calendar + LinkedIn | LinkedIn + email + calendar | 8+ channels including WhatsApp, Granola, Discord |
| Email triage + draft | No | No | Yes (basic) | No | No | Yes — AGT-05 with Approve queue |
| Hybrid search | No (keyword only) | Yes (mem0 BM25 + semantic + entity) | Semantic only | No | No | Yes — Azure AI Search hybrid |
| Auto-context loading | No | Partial (memory injection) | Partial | No | Pre-meeting brief only | Yes — full entity dossier pre-call |
| ADHD-specific design | No | No | Yes (primary focus) | No | No | Yes — zero-friction capture, draft-first, batched notifications |
| Daily briefing | No | No | Yes (day planning) | No | Pre-meeting briefs | Yes — prose + Top 3 + dropped threads |
| Agent suite | No | No | No | No | No | Yes — 8 v1 + 4 v2 specialized agents |
| Document version tracking | No | No | No | No | No | Yes — SHA + recipient log + diff |
| Bulk entity import | No | No | No | Yes (enrichment) | LinkedIn import | Yes — Kontakter + Granola + Gmail sigs |
| Custom dashboard | No (uses app UI) | No | Mobile app | No | App only | Yes — Next.js PWA, purpose-built |
| Swedish language support | Partial | Partial | No | No | No | Yes — AWS Transcribe Swedish + Claude bilingual |
| Calm-by-default notifications | No | No | No | No | No | Yes — urgency classifier + batch digest |
| Brand-voice content drafting | No | No | No | No | No | Yes — BRAND_VOICE.md + few-shot |

---

## Sources

- Mem.ai product updates: rebuild as Mem 2.0 (Oct 2025), agentic layer
- mem0.ai v2.0.0 architecture: hybrid retrieval (BM25 + semantic + entity), graph memory production status 2026
- Clay/Mesh (formerly clay.earth): entity pages, enrichment automation, rebranded 2026
- Dex personal CRM 2026: relationship timeline, AI pre-meeting briefs, LinkedIn sync
- Saner.ai 2026: ADHD-first design, chat over notes, 50K+ users, email + calendar integration
- Alfred_ AI: ADHD executive function offloading, draft-first email, daily brief
- Reflect 2026: backlinks, calendar integration, end-to-end encryption, minimalist approach
- Affinity CRM: relationship intelligence for investors, email/calendar analysis
- ADHD for Founders: brain dump + AI task extraction pattern
- Recallify: zero-friction voice capture, auto-task extraction
- State of UX 2026 (NN Group): calm interfaces, review fatigue, AI audit UX
- Hybrid Search RAG 2026 (Calmops, Meilisearch): BM25 + semantic + RRF fusion, 10-30% improvement
- Voice AI 2026 (Speechmatics, AssemblyAI): 1-in-4 YC companies voice-first, 70% YoY growth
- Agentic AI risks 2026 (Anthropic research, OWASP Top 10): auto-send anti-pattern, human-in-loop requirements
- CRM deduplication (FutureSearch, WinPure): fuzzy matching accuracy gaps, LLM disambiguation pattern
- Daily briefing patterns (Lead With AI, alfred_, MindStudio): action-oriented > passive, prose + bullets hybrid
- Notification design 2026 (Android Police, Appbot, Daywise): calm technology, batch non-urgent, one toggle insufficient

---

*Feature research for: Kevin OS (KOS) — entity-centric personal AI operating system*
*Researched: 2026-04-21*
