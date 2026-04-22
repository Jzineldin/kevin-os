# Phase 2: Minimum Viable Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** 02-minimum-viable-loop
**Areas discussed:** Capture surface + latency, Embedding model + vector pipeline, Entity resolver + Inbox workflow, WER harness + Swedish fallback

---

## Capture surface + latency

### Q1: Capture scope for Phase 2 — which channels ship in the first daily-usable loop?

| Option | Description | Selected |
|--------|-------------|----------|
| Telegram only (Recommended) | grammY bot on Lambda webhook (CAP-01 only). iOS Shortcut deferred. | ✓ |
| Telegram + iOS Shortcut together | Both CAP-01 + CAP-02 ship. HMAC webhook + iOS setup. | |
| iOS Shortcut only | CAP-02 first, CAP-01 later. | |

**User's choice:** Telegram only
**Notes:** Smallest surface, fastest to daily-usable. Telegram bot token already placeholder in Secrets Manager — just needs @BotFather creation before deploy.

### Q2: 25-second end-to-end budget — how to handle Transcribe latency variance?

| Option | Description | Selected |
|--------|-------------|----------|
| Two-stage ack (Recommended) | Instant "⏳ Transcribing…" then final "✅ Saved to X · Y". 25s SLO not hard deadline. | ✓ |
| Single ack, hard 25s cap | Silent until final ack. If >23s, "Timed out — saved raw". | |
| Streaming Transcribe | StartStreamTranscription. WebSocket complexity without user-visible benefit. | |

**User's choice:** Two-stage ack
**Notes:** Kevin isn't staring at the phone — two-stage keeps UX calm even if Transcribe takes 30s+

---

## Embedding model + vector pipeline

### Q3: Embedding model — what generates the content_vector for Azure AI Search?

| Option | Description | Selected |
|--------|-------------|----------|
| Bedrock Cohere Embed multilingual v3 (Recommended) | 1024 dims, native Swedish+English, $0.0001/1k tokens, AWS credits. | ✓ |
| Azure OpenAI text-embedding-3-small | 1536 dims, matches current schema. Azure credits. Not Swedish-native. | |
| Bedrock Titan Text Embeddings v2 | 1024 dims, all-English-biased. Cheapest. Low Swedish quality. | |
| Defer — don't write vectors yet | Phase 2 uses only pg_trgm; vectors land in Phase 6. | |

**User's choice:** Bedrock Cohere Embed multilingual v3
**Notes:** Azure index to be recreated from 1536 → 1024 dims; zero data loss (0 docs).

### Q4: Where do entity embeddings live — Azure Search, pgvector, or both?

| Option | Description | Selected |
|--------|-------------|----------|
| pgvector first, Azure later (Recommended) | Entity resolver queries pgvector (HNSW live). Azure reserved for Phase 6. | ✓ |
| Both — dual-write from the start | Every embedding to both. Reconciliation surface 2x. | |
| Azure-only from the start | Skip pgvector for resolver. Lose sub-20ms local queries. | |

**User's choice:** pgvector first, Azure later
**Notes:** Simpler one-data-path Phase 2. Azure schema stays empty until Phase 6.

---

## Entity resolver + Inbox workflow

### Q5: ENT-09 three-stage resolver — what's the score function?

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: trigram + embedding cosine (Recommended) | pg_trgm on Name+Aliases, pgvector cosine on context. max of weighted combinations. | ✓ |
| Trigram only | pg_trgm fuzzy string only. Misses semantic matches. | |
| LLM-first | Every mention goes to Sonnet 4.6. $0.01 + 2-3s per resolution. | |

**User's choice:** Hybrid: trigram + embedding cosine
**Notes:** Formula locked as `max(0.6·trigram, 0.6·cosine, 0.3·trigram + 0.7·cosine)`

### Q6: What counts as 'secondary signal' for > 0.95 auto-merge (ENT-09)?

| Option | Description | Selected |
|--------|-------------|----------|
| Project co-occurrence (Recommended) | Auto-merge only when matched dossier's LinkedProjects overlaps with current capture's projects. | ✓ |
| Confirmed alias match | Only if fuzzy match is against explicitly-confirmed-by-Kevin alias. | |
| Any co-mention in capture | Looser. Higher false-merge risk. | |

**User's choice:** Project co-occurrence
**Notes:** Every auto-merge still writes agent_runs audit row regardless.

### Q7: Inbox workflow — where do ambiguous/new entities queue?

| Option | Description | Selected |
|--------|-------------|----------|
| New 'KOS Inbox' Notion DB (Recommended) | Dedicated DB under 🏠 Kevin. Works without dashboard. | ✓ |
| Status field on Entities DB | Reuse existing DB with Status=Pending. Risk of mixed pending/active. | |
| Legacy Inbox DB (Phase 1) | Conceptually wrong — that's for VPS-freeze redirects. | |

**User's choice:** New 'KOS Inbox' Notion DB
**Notes:** Properties locked: Proposed Name, Type, Candidate Matches, Source Capture ID, Status, Confidence, Raw Context, Created. Approve/Reject/Merge flow via Status field + indexer sync.

---

## WER harness + Swedish fallback

### Q8 (asked twice): How are WER samples collected + ground-truth labelled?

**First ask — user replied "Why do we need samples?"**

After explaining WER = Word Error Rate, what it's protecting against (Transcribe mis-handling names/code-switching/specific phonemes), and that the ROADMAP asked for *evidence* the voice pipeline works — user was given lighter alternatives.

### Q8 (reframed): How do you want to validate the voice pipeline works before calling Phase 2 done?

| Option | Description | Selected |
|--------|-------------|----------|
| Kevin's-gut test (Recommended) | 1 week of real use. Ship if transcripts are usable; iterate vocab if not. | ✓ |
| Light measurement (10 live samples) | Eyeball 10 transcripts post-week. ~20 min of Kevin's time. | |
| Full WER harness | 20 samples, formal WER < 10% gate. ~1.5h of Kevin's time. | |
| Drop voice from Phase 2 entirely | Text-only bot. Voice deferred. | |

**User's choice:** Kevin's-gut test
**Notes:** Replaces the formal WER harness described in ROADMAP with a pragmatic "does it work for me" validation. Vocab iteration is idempotent — no phase boundary needed for that.

### Q9: Whisper large-v3 Fargate fallback if WER >= 15% — real or theatre?

| Option | Description | Selected |
|--------|-------------|----------|
| Budget it as real but deferred build (Recommended) | Spec stays in plan; built only if triggered. | ✓ |
| Prebuild skeleton now | Fargate + Whisper container now. ~$30/mo idle. | |
| Drop the fallback clause | Commit to sv-SE Transcribe; iterate vocab if bad. | |

**User's choice:** Budget it as real but deferred build
**Notes:** If Kevin reports unusable transcripts AND vocab iteration can't fix, a Phase 2.5 opens.

### Q10: How does Phase 2 wait for the WER gate before shipping?

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 2a + 2b split (Recommended) | 2a builds tech; 2b is Kevin's 1-week usage + iteration. | ✓ |
| Single phase, measure before exec completion | Force waiting on real usage inside one phase. | |

**User's choice:** Phase 2a + 2b split
**Notes:** Phase 2a can verify-pass before Phase 2b closes. Matches live-capture validation flow.

---

## Claude's Discretion

Areas where user said "you decide" or deferred to Claude:
- Exact Claude Agent SDK prompt structure per agent (system prompts, tool schemas, cache_control placement)
- Lambda memory/timeout sizing per agent (starting defaults: 512 MB / 30 s)
- S3 key structure for audio + transcripts
- pg_trgm + HNSW index tuning for resolver hot path
- Internal voice-capture classify-to-Notion-row prompt structure
- Granola API endpoints + pagination (research step to confirm)
- Gmail OAuth consent flow UX (one-time setup before ENT-06 runs)

## Deferred Ideas

- iOS Shortcut capture (CAP-02) — Phase 2.5 or bundled with Phase 3
- Azure AI Search document writes — Phase 6 (Gemini dossiers)
- Whisper large-v3 Fargate fallback — spec'd only; Phase 2.5 if triggered
- Streaming Transcribe — Phase 7+
- Email / WhatsApp / Discord / Granola streaming / Chrome extension captures — CAP-03..07
- Dashboard Inbox view — Phase 3
- Manual entity merge UI — Phase 3 (ENT-07)
- Entity timeline + AI "What you need to know" block — Phase 3+ (ENT-08)
- EmailEngine + Baileys + Postiz Fargate services — Phases 4+5
- Formal WER harness — superseded by Kevin's-gut test
