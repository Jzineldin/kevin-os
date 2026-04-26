---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
last_updated: "2026-04-26T19:50:30.254Z"
progress:
  total_phases: 12
  completed_phases: 4
  total_plans: 89
  completed_plans: 54
  percent: 61
---

# State: Kevin OS (KOS)

**Initialized:** 2026-04-21
**Last updated:** 2026-04-26 (post-deploy state sync)

---

## Project Reference

**Core value:** Kevin never has to re-explain context. Every input gets routed automatically. Every output is context-aware. The system maintains itself; Kevin only writes raw input and reads curated output.

**North-star user behavior (v1 acceptance, Gate 4):** 4 continuous weeks of daily KOS use, morning brief acted on 5 days/week, entity resolver > 90% accuracy on voice, email triage approval+edit rate > 70%, dashboard > 3 sessions/week.

---

## Current Position (2026-04-26)

```
Phase 1: [✅] Infrastructure Foundation       — DEPLOYED & VERIFIED
Phase 2: [✅] Minimum Viable Loop             — DEPLOYED & VERIFIED LIVE (Swedish voice memo round-trip)
Phase 3: [✅] Dashboard MVP                   — DEPLOYED on Vercel
Phase 4: [✅] Email Pipeline + iOS Capture   — DEPLOYED (gmail-poller replaces EmailEngine)
Phase 5: [⚠️] Messaging Channels              — Chrome ext + LinkedIn DEPLOYED & VERIFIED LIVE; WhatsApp + Discord deferred
Phase 6: [✅] Granola + Semantic Memory       — DEPLOYED & VERIFIED LIVE
Phase 7: [✅] Lifecycle Automation            — DEPLOYED (waiting on real Telegram bot token)
Phase 8: [⚠️] Outbound Content + Calendar    — Calendar / mutations / document-diff DEPLOYED; Postiz deferred
Phase 9: [🚫] V2 Specialty Agents             — BLOCKED Gate 4 (4 weeks of daily v1 use first)
Phase 10:[⚠️] Migration & Decommission       — VPS migration adapter live; final Hetzner power-off deferred
Phase 11:[🆕] AI Chat + Bidirectional Telegram — NEW SCOPE (see Phase 11 below)
```

**Progress:** [██████░░░░] 61%

---

## What's Live RIGHT NOW (verified 2026-04-26)

### Inbound capture pipelines

| Channel | Status | Verified |
|---|---|---|
| Telegram voice memo (Swedish) | Live | ✅ Capture round-trip 2026-04-25 |
| Telegram text | Live | ✅ |
| Gmail polling (5min) | Live | ✅ Lambda invoke returned ok 2026-04-26 12:39 |
| Google Calendar (30min) | Live | ✅ |
| Granola transcripts (15min) | Live | ✅ |
| Chrome highlight → KOS | Live | ✅ Send-to-KOS verified 2026-04-26 12:22 |
| LinkedIn DM auto-scrape | Live | ✅ Verified 2026-04-26 |

### Brain layer

| Component | Status |
|---|---|
| Notion entity dossiers (Notion = source of truth) | Live |
| Postgres entity_index + project_index (derived) | Live |
| Azure AI Search hybrid index v2 | Live |
| Vertex Gemini 2.5 Pro for full-dossier loads | Live |
| Per-entity timeline materialized view (5min refresh) | Live |
| `loadContext()` library used by 4 Lambdas | Live |

### Daily output

| Schedule | Lambda | Status |
|---|---|---|
| 08:00 weekdays Stockholm | morning-brief | Live (will push to Telegram once bot token seeded) |
| 18:00 weekdays Stockholm | day-close | Live (same caveat) |
| Sun 19:00 Stockholm | weekly-review | Live (same caveat) |

### Dashboard

- Inbox view (drafted emails awaiting Approve) — live
- Today view (calendar + briefs) — live
- Entity pages — live
- SSE via Postgres LISTEN/NOTIFY — live
- Bearer auth — live

---

## Phase 11 — AI Chat + Bidirectional Telegram (NEW)

Added 2026-04-26 based on Kevin's session feedback: the missing piece of his vision is "an AI chat that is truly connected to the project and has access to everything for me inside the app, and that it's all properly connected with telegram as well."

**Goal:** A conversational interface (dashboard + Telegram) where Kevin can ask KOS anything and get answers grounded in the entity graph + semantic memory.

**Plans (TBD by `/gsd-plan-phase 11`):**

- 11-00 — Scaffold + scope. New service `services/kos-chat`, new dashboard route `/chat`, new Telegram command handler.
- 11-01 — Chat backend Lambda. Sonnet 4.6 + `loadContext()`, treats every message as a query against the brain. Returns answer + citations to specific entities/docs.
- 11-02 — Dashboard chat UI. Streaming SSE response, markdown rendering, link to entity pages mentioned in answer.
- 11-03 — Telegram conversational mode. Today the bot only pushes briefs; this turns it into a two-way thread — Kevin types a question to the bot, gets the same Sonnet 4.6 + brain answer.
- 11-04 — Tool-use surface. Let chat agent call `add_entity`, `update_dossier`, `search_emails` etc. via tool definitions — same brain access, also can mutate (with Approve gate on writes).

**New requirements (added below in REQUIREMENTS.md):**

- `CHAT-01` Dashboard AI chat
- `CHAT-02` Telegram conversational thread
- `CHAT-03` Tool-use surface (search + write with Approve)

---

## Operator Gaps (single-checklist source of truth)

Things that block KOS from being fully usable. Ordered by impact.

### Critical for daily use

- [ ] **Real Telegram bot token** — placeholder secret; without it, morning brief / day close / weekly review sit silently in DB. **2 min to fix:** BotFather → `/newbot` → copy token → `aws secretsmanager put-secret-value --secret-id kos/telegram-bot-token --secret-string '<token>'`. Then DM your new bot once.

### Useful but optional

- [ ] **Brand voice doc** (`.planning/brand/BRAND_VOICE.md`) — required to flip `human_verification: true` and unblock content-writer. Write 5 platform-specific paragraphs of how you want posts to sound. **Without this:** content-writer Lambda fails-closed by design, no social drafting.
- [ ] **Phase 9 Gate 4 prep** — track 4-week daily-use streak + acceptance metrics. Auto unlock at: 28 consecutive days + brief acted-on 5/wk + entity resolver > 90% + email triage approve+edit > 70% + dashboard > 3 sessions/wk.

### Deferred indefinitely (per Kevin's session direction)

- iOS Action Button — Telegram covers this
- Discord brain-dump — Telegram covers this
- WhatsApp Baileys — Kevin said "fuck whatsapp"
- Postiz publisher — gated behind brand voice + license
- SES production access — gmail-poller's `gmail.send` scope is the planned email-send path; SES sandbox is OK for now

---

## Recent Session Activity

### 2026-04-26 (post-overnight session)

1. **Discovered + fixed chain-clobber regression** (PR #32 merged) — 6 Phase 8 plans had been silently reverted to stub handlers by stale-base merges. 101/101 service tests + 32/32 CDK tests now green.
2. **Added monorepo CI** (PR #33 merged) — typecheck + tests + stub-detector run on every PR. Future chain-clobbers fail before they land.
3. **Replaced EmailEngine with gmail-poller** (PR #34 merged) — saves $995/yr license + ~$54/mo Fargate+Redis. Direct Gmail API polling every 5min. Reuses calendar-reader OAuth secrets.
4. **Fixed gmail-poller `newer_than:6m` bug** (PR #35 merged) — was fetching 6 MONTHS not 6 minutes. Switched to Unix-epoch `after:` query. Verified live: 0 false-positive emits.
5. **Applied 16 missing DB migrations** — 0003-0021 except role-creation ones for kos_email_sender/kos_email_triage which are deferred.
6. **Set up Google OAuth** — bootstrap script run for both kevin-elzarka + kevin-taleforge with calendar.readonly + gmail.modify + gmail.send scopes.
7. **Chrome extension installed + verified** — bearer + HMAC + webhook URL configured; right-click capture confirmed live.
8. **Bastion deployed for migrations** — needs teardown (run `cdk deploy KosData --require-approval never` without `--context bastion=true`).
9. **EBS volume resized 48GB → 200GB** — disk pressure was blocking test runs.
10. **Phase 11 Plan 11-04 complete** — `/today` extended with 5-source UNION (email_drafts + mention_events + event_log + inbox_index + telegram_inbox_queue, absorbing Wave 0 deviation that capture_text/capture_voice tables do not exist), 4 stat tiles, channel-health strip; TodayView mission-control layout wired; 10 today tests + 4 e2e tests passing; SSE refresh preserved (D-14).

### Branches cleaned

- 33 stale local branches deleted
- 7 stale remote branches still on origin (cleanup pending Kevin's run)

---

## Locked Decisions (carry across all phases)

1. **EventBridge-only event routing** — n8n decommissioned in Phase 10; captures publish, never call agents directly.
2. **Notion = source of truth, Postgres = derived index** — agents write Notion first, `notion-indexer` upserts Postgres async.
3. **Claude Agent SDK on Lambda** — subagents as `.agents/*.md` files; Bedrock-native via `CLAUDE_CODE_USE_BEDROCK=1`.
4. **Lambda for events, Fargate for persistent connections** — but EmailEngine replaced by gmail-poller (Lambda) per cost.
5. **RDS PostgreSQL 16 (db.t4g.medium, eu-north-1)** — pgvector enabled.
6. **Azure AI Search Basic-tier with binary quantization at index creation** — 92.5% cost reduction.
7. **SSE via Postgres LISTEN/NOTIFY from Next.js Edge** — not AppSync, not Pusher.
8. **Static Bearer token in Secrets Manager for dashboard auth** — single-user.
9. **AWS Transcribe `sv-SE` with custom vocabulary** — verified working.
10. **Telegram = mobile push, dashboard = desktop primary**.
11. **Hard cap of 3 Telegram messages/day** — Phase 1 invariant.
12. **Archive-never-delete policy** — implemented in `notion-indexer`.
13. **`owner_id` on every RDS table** — single-user today, multi-tenant ready.
14. **V2 specialty agents BLOCKED behind Gate 4**.
15. **(NEW 2026-04-26) gmail-poller replaces EmailEngine** — Gmail API polling every 5min via Lambda, free tier covers usage; reuses OAuth refresh tokens shared with calendar-reader.
16. **(NEW 2026-04-26) chain-clobber detection in CI** — `not yet implemented` grep + monorepo unit tests on every PR via `.github/workflows/monorepo-ci.yml`.

---

## Active Todos (top of mind)

- [ ] Tear down bastion (1 cdk command)
- [ ] Seed real Telegram bot token (2 min)
- [ ] `/gsd-plan-phase 11` (AI chat + bidirectional Telegram)
- [ ] Then `/gsd-execute-phase 11`
- [ ] Operator: clean up 7 stale remote branches on GitHub

---

## Open Questions

None at planning state — the questions from initial roadmap (Bedrock region, Notion EU residency, Vercel SSE limits) all resolved during execution.

---

*State synced 2026-04-26 to reflect actual deployed state.*

**Planned Phase:** 11 (Frontend rebuild + real-data wiring + button audit (mission-control aesthetic)) — 9 plans — 2026-04-26T16:38:28.171Z
