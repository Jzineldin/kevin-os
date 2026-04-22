# Phase 2 Gate 2 Evidence — {YYYY-MM-DD}

**Status:** {PASS|WARN|FAIL}
**Phase 2a (build) closed:** {YYYY-MM-DD}
**Phase 2b (Kevin's real-use week, D-18) opens:** {YYYY-MM-DD}

---

## 1. End-to-end latency (D-02 SLO)

- `scripts/verify-phase-2-e2e.mjs` run: `{YYYY-MM-DDTHH:MM:SSZ}`
- capture_id: `{ulid}`
- fixture: `scripts/fixtures/sample-sv-voice-memo.oga` ({N} bytes)
- elapsed_ms: **{N}**
- within 25s SLO: **{yes|no}**
- within 45s hard limit: **{yes|no}**
- transcribe_status: `{COMPLETED|FAILED}`
- transcript: `"{…}"`
- Notion Command Center row: `{page_id}` / {not-found}
- Langfuse session URL: `https://cloud.langfuse.com/sessions/{capture_id}`
- raw evidence JSON: `.planning/phases/02-minimum-viable-loop/02-11-e2e-result-{ts}.json`

### Milestones observed

| Milestone | Observed? |
|-----------|-----------|
| capture.received published to kos.capture | {yes/no} |
| Transcribe job kos-{capture_id} COMPLETED | {yes/no} |
| Triage Lambda invoked (CloudWatch Logs hit) | {yes/no} |
| Voice-capture Lambda invoked (CloudWatch Logs hit) | {yes/no} |
| Push-telegram Lambda invoked (CloudWatch Logs hit) | {yes/no} |
| Notion Command Center row present with Capture ID | {yes/no} |

---

## 2. Resolver three-stage scoreboard (20 curated mentions)

Run: `scripts/verify-resolver-three-stage.mjs`
Fixture: `scripts/fixtures/resolver-three-stage-mentions.json`
Scoreboard file: `.planning/phases/02-minimum-viable-loop/02-11-e2e-results-{YYYY-MM-DD}.md`

| Stage | Expected count | Auto-passed | Operator-confirmed | Notes |
|-------|---------------:|------------:|-------------------:|-------|
| auto-merge | 6 | {n} | {n} | |
| llm-disambig | 9 | {n} | {n} | |
| inbox | 5 | {n} | {n} | |

Operator review notes: {one-line per row that was surprising; otherwise "all as expected"}

---

## 3. KOS Inbox population (ROADMAP SC4)

Run: `node scripts/verify-inbox-count.mjs --min 50`

- Total Pending rows: {N}
- Result: **{PASS|FAIL}**
- If shortfall: action = re-run bulk imports (ENT-05 Kontakter + ENT-06 Granola/Gmail) OR downgrade the minimum for this gate with Kevin's explicit note.

---

## 4. Observability (Plan 02-10)

Run: `CAPTURE_ID=<from-section-1> node scripts/verify-observability.mjs --capture-id "$CAPTURE_ID"`

- Langfuse traces for sessionId=capture_id: {N}
- Result: **{PASS|FAIL}**
- Sentry test event captured (--check-sentry optional): {yes/no/skipped}

**Note:** If the `kos/langfuse-*` secrets are still random placeholders rather than real Langfuse keys, this check will fail with `401` — that is a known expected state until the Langfuse account is wired. Record the failure here and mark this sub-gate "deferred to post-Phase-2b" rather than blocking.

---

## 5. Kevin's-gut Swedish ASR check (D-16 replacement for WER)

> D-16 replaces the formal 20-sample WER gate with Kevin's subjective judgement
> after ≥ 1 week of real use. Phase 2a closes when the checklist below is
> filled; Phase 2b then opens for the real-use week.

Filled by operator (Kevin) after sending 5 real Swedish voice memos via Telegram:

- Transcripts are usable for Notion writes: **{yes|partial|no}**
- Transcripts captured code-switched SV/EN correctly: **{yes|partial|no}**
- Named entities (Damien, Christina, Almi…) transcribed correctly: **{yes|partial|no}**
- Known mis-transcribed terms to add to `vocab/sv-se-v1.txt`: {list | none}
- Overall ADHD-friendly for daily capture: **{yes|no}** — {one-line why}

If "partial" or "no" on any of the above:
- Iterate `vocab/sv-se-v1.txt` per D-16
- Redeploy CaptureStack (Transcribe CustomResource updates the vocab idempotently)
- Re-run `scripts/verify-phase-2-e2e.mjs`
- Re-file this section

---

## 6. DLQs + notification cap (ROADMAP Gate 2)

- `bash scripts/verify-stacks-exist.sh`: {PASS|FAIL}
  - Confirms every EventBridge → Lambda rule has a DLQ wired
  - Phase 2 introduced: kos-transcribe-dlq, kos-triage-dlq, kos-voice-capture-dlq, kos-entity-resolver-dlq, kos-push-telegram-dlq
- `node scripts/verify-cap.mjs`: {PASS|FAIL}
  - Confirms 4th non-reply push in a single Stockholm day is suppressed
  - Confirms `is_reply=true` bypasses cap (Plan 02-06 §13 contract)

---

## 7. Phase 2b gate (Kevin's real-use week — D-18)

- Phase 2b opened: {YYYY-MM-DD}
- Target close: Phase 2b opened + 7 days
- Kevin's-gut status check-in dates: {list}
- Kevin's-gut final status: {PASS|ITERATE}
- If ITERATE: action plan = {vocab update path / agent prompt tweak / …}
- Phase 3 unblock date: {YYYY-MM-DD or "blocked-on Kevin\'s-gut"}

---

## 8. Sign-off

- [ ] All six sub-gates above are PASS or WARN
- [ ] Raw evidence JSON committed alongside this file
- [ ] Resolver scoreboard committed
- [ ] Known stubs from Plans 01-10 summaries reviewed: none block Gate 2

**Kevin (operator) sign-off:** {initials} {date}

_This file is created by `scripts/verify-phase-2-e2e.mjs` + operator fills after `scripts/verify-resolver-three-stage.mjs` + `scripts/verify-inbox-count.mjs` + `scripts/verify-observability.mjs` runs._
