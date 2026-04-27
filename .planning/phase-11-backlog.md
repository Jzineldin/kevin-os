# Phase 11 backlog — Kevin's outstanding asks

**Purpose:** persist asks across sessions so nothing gets lost when context rolls. Owner: the AI working next. Update status inline. Add new asks at the bottom with a date tag.

**Current phase:** Phase 11 — AI Chat + Proposal Gate + Entity-First Dashboard

---

## Working rules (GSD-style)

1. **Every new ask Kevin surfaces in chat → immediately gets appended to this file** before I execute anything else. Reactive-only mode is banned.
2. **In-flight session todos** live in the `TodoWrite` tool (ephemeral). This file is the persistent source of truth.
3. **No "done" is real** until it's deployed AND Kevin has verified it in his browser (not my Playwright snapshot — actual Kevin).
4. **Priority ordering**: user-visible impact first, backend-only last. Within a priority, pick the one with smallest surface that unblocks the most other things.
5. **If I can't finish something, park it as `⏸ parked`** with a note on why, rather than leaving it `in_progress`. Honest about ships.

---

## ✅ Done (Phase 11 so far)

- Chat backend Lambda (POST /chat, Sonnet 4.6 + context) — Plan 11-01
- Next.js /api/chat proxy — Plan 11-02 enabler
- Telegram /ask + /chat commands — Plan 11-03
- Voice-to-chat routing — Plan 11-03 extension
- Bedrock tool-use surface (5 tools: list_open_tasks, update_priority, update_status, add_task, search_entities) — Plan 11-04
- search_emails tool added to chat — Plan 11-04 extension
- Dossier synthesis via Sonnet 4.6 on /entities/:id — Plan 11-04 C
- 43 personas backfilled from entity-resolver audit trail — Plan 11-04 groundwork
- 24 entities enriched (relationship/role/org inferred) — Plan 11-04 groundwork
- 334 granola-transcript mentions linked to entities — Plan 11-04 groundwork
- proposals table + endpoints + morning-brief dual-write — Plan 11-05
- PendingProposalsCard on /today + /api/proposals proxies — Plan 11-05 UI
- Cleaned 11 duplicate Command Center pages — hygiene
- Filtered cap-exceeded from /today captures_today (deployed) — hygiene
- LenientDateTime in brief schema (unblocked brief generation) — bugfix
- Vercel alias forced to latest prod — infra
- Phase 11 backlog file (this document) — process

---

## 🔴 Open — high priority (user-blocking or architecture)

### Inbox interaction (the full Gate-3 loop)
- [ ] Render email body in `/inbox` detail pane (use `/api/email-drafts/:id` which exists)
- [ ] "Draft reply" button for any email (even skipped ones) → on-demand draft via draft-agent
- [ ] "Send" button wired to real Gmail send API (NEW Lambda needed, `gmail-sender`)
- [ ] "Delete draft" button → archives email_drafts row
- [ ] Legacy-email body backfill — 11 pre-migration rows have `body_plain = NULL`; re-fetch from Gmail

### Calendar
- [ ] `/calendar` page renders events and meetings end-to-end (backend returns them; UI rendering needs verification)
- [ ] Multi-calendar: today the reader only polls `primary`; enumerate each account's `calendarList` so shared/secondary calendars surface

### People / Entities UI
- [ ] Editable name, aliases, org, role, relationship, status, seed_context, manual_notes
  (backend already supports via `POST /entities/:id`; only UI missing)
- [ ] Pagination: ≥20 rows per page on `/entities` list (currently renders all 43+; will explode at scale)
- [ ] Same pagination on `/inbox`

### Voice-memo intelligence
- [ ] Semantic dedup before Command Center write: query existing CC tasks in last 24h with similar title OR overlapping entity_ids; if hit → UPDATE existing task instead of CREATE
  (evidence: 6 "Ping Damien" pages from 6 voice memos; agent should have merged)

### Proposal-gate coverage extension
- [ ] Extend dual-write to `transcript-extractor` (action items as proposals)
- [ ] Extend dual-write to `voice-capture` (voice memo → Command Center as a proposal)
- [ ] Extend dual-write to `email-triage` (classification + draft as a proposal)
- [ ] Flip `morning-brief` from dual-write to proposal-first (accept commits to Command Center; reject skips)

---

## 🟡 Open — medium priority (polish + correctness)

- [ ] Bump service-worker version so Kevin's browser stops serving stale HTML. Today's alias swap only helped because he hit Cmd+Shift+R. Permanent fix: invalidate SW on every deploy.
- [ ] Gmail yellow / Granola red / Calendar red → verify thresholds match Kevin's real usage cadence. Granola: 60min max_age is fine if you meet daily; Calendar: 90min is wrong since calendar-reader runs every 15min but next event may be days away.
- [ ] Top 3 dup: `/today` shows "Priorities" panel (from Command Center) AND "AI Morning Brief Top 3". When accepted proposals land in Command Center, both show the same 3 items. Design question: should Priorities panel render only non-brief-derived tasks?
- [ ] Proposal accept side-effect: today accept marks the row, but DOESN'T push the Top 3 item into Command Center. Wire the commit-on-accept.

---

## 🟢 Open — low priority (nice-to-have)

- [ ] Chat UI: streaming (SSE) response instead of buffered. Plan 11-02.
- [ ] Chat UI: citation pills clickable → navigate to /entities/:id
- [ ] Telegram reply formatting: render citations footer cleaner than `_Linked: Name_`
- [ ] OpenClaw scaffolded `.claude/agents/openclaw.md` per Phase 9 pattern (blocked until Gate 4)
- [ ] Content-writer unblocked by BRAND_VOICE.md (Kevin writes it)

---

## ⏸ Parked (explicitly deferred)

- WhatsApp / Baileys (Phase 5 — Kevin said "fuck whatsapp")
- Discord capture (Phase 5 — no demand signal)
- Postiz / Publisher (Phase 8 — needs brand voice doc)
- Hetzner final power-off (Phase 10 — runs fine, no rush)
- Phase 9 specialty agents (Gate 4 blocked — 4 weeks daily use first)

---

## 📝 Add-ons (stuff Kevin surfaced mid-session that must not be forgotten)

*(Append to this section with date + context as Kevin raises things. Do not pre-judge priority; add to triage later.)*

- **2026-04-27** — Command Center is a mess of dups and non-tasks. Kevin wants an audit + cleanup pass. Did a first pass (archived 11 dup pages). Needs a second pass for "non-task rows" classification.
- **2026-04-27** — "I feel like we are losing SO much." Process change: this backlog file is the answer. Every session opens by reading this.
