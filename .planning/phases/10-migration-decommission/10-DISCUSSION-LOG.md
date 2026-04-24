---
phase: 10-migration-decommission
type: discussion-log
created: 2026-04-24
mode: yolo (Kevin asleep — orchestrator brief recommendations all locked verbatim)
---

# Phase 10 Discussion Log — Migration & Decommission

## Context

Overnight planning run. Phase 10 decomposed into 8 plans (Wave 0 scaffold + Waves 1-4). All 7 orchestrator gray-area defaults accepted verbatim per yolo mode + Kevin-asleep brief.

Phase 10 closes the last open hardware bill: the Hetzner VPS at 98.91.6.66, Kevin's existing single point of failure. It also deletes the unauthenticated n8n on port 5678 (security risk) and archives the 5 legacy Brain DBs that were superseded by Command Center + the entity graph in earlier phases.

---

## Decisions Locked (24 D-XX)

See `10-CONTEXT.md` for full narrative. High-signal decisions:

| D-XX | Decision | Why |
|------|----------|-----|
| D-01 | Archive-never-delete invariant holds through Phase 10 | Reversibility guarantee from Locked Decision #12 in STATE.md |
| D-02 | Rollback plan rehearsed in dry-run before power-down | ROADMAP SC 5 — non-negotiable |
| D-03 | 7-day same-substance verification with hand-compared 10 pairs/script | ROADMAP SC 1; Gemini 2.5 Pro judge assists but doesn't decide alone |
| D-05 | 7 known VPS processes + n8n all stopped before power-down | Prevents silent failure after INF-11 |
| D-07 | MIG-02 + INF-11 closure expected to resolve Telegram webhook auto-clear (M1 from 02-VERIFICATION.md) | `.planning/debug/telegram-webhook-auto-clear.md` analysis: n8n polling `/getUpdates` is highest-likelihood root cause |
| D-11 | Hetzner power-off (not delete) + 30-day snapshot retention | Reversibility; $0.50/month cost for 30 days of optionality |
| D-12 | Write-ahead event_log audit BEFORE Notion archive mutation | If mutation fails, audit still proves intent; if audit fails, don't mutate |
| D-13 | Migration number 0016 (0017 fallback if earlier phase lands later) | Phase 8 reserves 0015; Phase 10 picks 0016 |
| D-14 | Operator SSH-based VPS discovery script → JSON inventory → schema-validated | Makes the unknown "what's on the VPS" concrete BEFORE any retirement command |
| D-16 | VPS stays cold-inert for 14 days post-Waves-1-3, then power-down | Runs without traffic; if something breaks, the failure is recoverable without snapshot restore |
| D-17 | Brain DB archival can proceed immediately (no wait for VPS decom) | Brain DBs have been write-frozen since Phase 1 |
| D-19 | Gemini 2.5 Pro (Vertex AI per Phase 6 INF-10) judges same-substance pairs | Long-context handles full daily-brief comparison |
| D-21 | Discord brain-dump migration = channel webhook → Lambda (not bot polling) | Simpler; matches Lambda-for-events Locked Decision #4 |
| D-22 | Post-decom mandatory Telegram webhook persistence re-test | If M1 still reproduces, escalate per debug doc |
| D-23 | Cutover is atomic (single DNS / webhook URL flip) | Prevents dual-write during overlap |
| D-24 | AWS Cost Explorer doesn't track Hetzner egress — use Hetzner billing dashboard | ROADMAP SC 4 phrasing correction; runbook documents the actual check |

---

## Gray Areas — All Defaults Locked

| # | Gray Area | Default Locked |
|---|-----------|----------------|
| G-01 | classify_and_save migration shape | Thin adapter Lambda (NOT full rewrite, NOT delete) |
| G-02 | gmail_classifier replacement | Decommission entirely; no adapter (Phase 4 email-triage already covers) |
| G-03 | brain-dump-listener migration | Lambda with Discord channel webhook (NOT bot polling) |
| G-04 | n8n workflow archive format | JSON export to S3 + human review checklist (NOT code compilation) |
| G-05 | Archive timing (MIG-03) | Immediately after Phase 2 Gate 2 (already PASS) |
| G-06 | Power-down sequencing | AFTER 14-day cold-inert verification |
| G-07 | Hetzner snapshot retention | 30 days (14-day verify + 16-day buffer) |

No deviations.

---

## Plan Structure (8 plans, 4 waves)

| Plan | Wave | Focus | Requirements |
|------|------|-------|---------------|
| 10-00 | 0 | Scaffold: 3 Lambda skeletons + 3 scripts + migration 0016 event_log + fixtures | MIG-01/02/03/04, INF-11, CAP-10 |
| 10-01 | 1 | MIG-01: classify-adapter Lambda + Gemini same-substance verifier | MIG-01 |
| 10-02 | 1 (‖) | MIG-01: morning_briefing + evening_checkin retirement + Legacy Inbox silence check | MIG-01 |
| 10-03 | 2 | MIG-03: 5 Brain DB archival (write-ahead audit + dry-run first) | MIG-03, MIG-04 |
| 10-04 | 2 (‖) | CAP-10: Discord brain-dump Lambda + 7-day same-substance verifier | CAP-10 |
| 10-05 | 3 | MIG-02: n8n workflow export → S3 → stop/disable/mask → firewall DROP → probe | MIG-02 |
| 10-06 | 3 (‖) | INF-11: retire 4 unfrozen VPS scripts (brain_server, gmail_classifier, brain-dump-listener, sync_aggregated) | INF-11, CAP-10 |
| 10-07 | 4 | INF-11: Hetzner snapshot + power-off + 14-day probe + rollback runbook + Telegram re-test + E2E gate | INF-11, MIG-01..04, CAP-10 |

Total waves: 4. Waves 1 + 2 each have 2 parallel plans (no files_modified overlap). Wave 3 has 2 parallel plans. Wave 4 is single plan (depends on all previous).

---

## Side-Effect Resolution (Telegram Webhook Auto-Clear, M1)

Per `.planning/debug/telegram-webhook-auto-clear.md`, the highest-likelihood root cause for the webhook auto-clear is an n8n workflow on the VPS running a Telegram Trigger in long-polling mode. Any `getUpdates` call from ANY client using the same bot token invalidates the webhook.

Phase 10 does two things that should close this:
1. **MIG-02** kills n8n — if the rogue workflow is in n8n, shutting n8n down stops the auto-clear immediately.
2. **INF-11** powers off the VPS entirely — if the rogue caller is some other VPS-side process not yet identified (brain_server? a cron job?), powering off kills it too.

Plan 10-07 Task 1 Subtask 3 (`scripts/verify-telegram-webhook-persistence.mjs`) runs a 60-second observation: set webhook → wait 60s → check webhook URL is still set. Two outcomes:

- **PASS (exit 0):** webhook URL persisted → M1 RESOLVED. Cross-link in Gate evidence + close M1 in 02-VERIFICATION.md.
- **ESCALATE (exit 2):** webhook cleared within 60s → rogue caller is NOT on the Hetzner VPS. Remediation = bot token rotation per debug doc. Operator handles in runbook.

Either way, Phase 10 Wave 4 completes. M1 status is now deterministic.

---

## Migration Number Collision Guard

Phase 8 reserves 0015. Phase 10 targets 0016. If any phase lands between now and Phase 10 execution and grabs 0016, Plan 10-00's Task 3 checks `packages/db/drizzle/` for the next-available number and bumps accordingly (0017).

This pattern was established by Phase 4 (originally 0012, bumped to 0013 if Phase 6 landed first). No planner-time conflict.

---

## Out of Scope (Explicit)

- Un-archival of Brain DBs (one-direction archive by design).
- Auto-compiling any n8n workflow into EventBridge rules. If operator finds an essential workflow during archive review, they open a new plan.
- Hetzner account closure (Kevin may have other projects there).
- New RDS point-in-time restore setup (Phase 1 data-stack defaults are assumed present).

---

## Risks Tracked in 10-CONTEXT.md

See 10-CONTEXT.md § Known Risks. Primary residual risks:
- Hetzner snapshot restore can take 30-60 min under load — runbook budget is "< 30 min best-case, < 60 min worst-case with support escalation".
- Sample size 10 cases/script may miss long-tail defects — accepted as residual risk absorption; 7-day window is the compensating mechanism.
- IP reassignment — if Hetzner reassigns 98.91.6.66 to another customer after power-off, external probe may see a different service. `verify-hetzner-dead.mjs` documents this.

---

## Post-Completion Actions

After Plan 10-07 Wave 4 gate PASS:

1. Apply ROADMAP promotion patch — flip MIG-01..04, INF-11, CAP-10 → `Verified`.
2. Update REQUIREMENTS.md traceability.
3. Close M1 in 02-VERIFICATION.md (if PASS) or note escalation in place (if ESCALATE).
4. Update STATE.md — Phase 10 addendum marking it complete.
5. At T+30 (hard snapshot deletion): event_log `hetzner-snapshot-deleted` + final commit.
6. Monthly cost delta: -$50/mo Hetzner, +$0/mo Discord Lambda = net -$50/mo baseline reduction.

---

## Session Metadata

- **Planning session:** 2026-04-24 (same overnight run as Phase 6/4/7/8)
- **Planner:** `/gsd-plan-phase 10`
- **Mode:** yolo (Kevin asleep)
- **Files produced:** 8 PLAN files + 3 runbooks + CONTEXT + RESEARCH + VALIDATION + GATE template + DISCUSSION-LOG = 15 planning artifacts
- **Deferred items:** none — all 7 gray areas locked; no `deferred-items.md` needed for Phase 10
- **Cross-phase callouts:** Phase 4 Gate 3 is a hard prereq for Wave 3 (gmail_classifier retirement); Phase 7 AUTO-01/AUTO-03 are hard prereqs for Wave 1 (morning/evening retirement); Phase 6 loadContext is a classify-adapter dependency; Phase 1 VPS freeze is the substrate these plans build on.

---

*Discussion log closed; decisions locked; plans ready for execution.*
