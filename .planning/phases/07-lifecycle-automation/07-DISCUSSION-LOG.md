# Phase 7 Discussion Log

**Run:** 2026-04-24 (orchestrator brief — Kevin asleep; all recommended defaults locked)
**Planner:** `/gsd-plan-phase 7` invoked in standard mode (no --gaps, no --reviews).

---

## Discussion Context

Phase 7 was planned without a live discussion (Kevin asleep per orchestrator instructions). The orchestrator brief in `<artifacts_to_produce>` provided 7 recommended defaults for gray areas — all accepted verbatim. This matches the pattern used for Phase 6 (same session) and Phase 4 (same session).

**Input artifacts:**
- ROADMAP.md §Phase 7 (goal + 5 SCs + 4 requirements)
- REQUIREMENTS.md (AUTO-01, AUTO-02 (schedule), AUTO-03, AUTO-04)
- STATE.md (14 Locked Decisions + Phase 6 + Phase 4 planning addenda)
- PROJECT.md (Locked Decision #3 revised 2026-04-23 — direct AnthropicBedrock SDK)
- Phase 6 CONTEXT (loadContext() helper shape)
- Phase 4 CONTEXT + Plans 04-04/04-05 (email-triage AGT-05 + scan_emails_now rule)
- Phase 1 SafetyStack (cap + quiet-hours enforcement)

---

## Decisions

All 7 orchestrator gray-area defaults accepted:

| Decision | Locked value | Source |
|---------|-------------|--------|
| D-01 Brief generation model | Sonnet 4.6 throughout (no Haiku split) | Orchestrator rec |
| D-02 Brief storage | BOTH 🏠 Today (replace-in-place) + Daily Brief Log DB (append) | Orchestrator rec |
| D-04 Cron timezone | Native `Europe/Stockholm` on every CfnSchedule | Orchestrator rec |
| D-05 Tool_use schema | Shared `packages/contracts/src/brief.ts` (MorningBriefSchema + DayCloseBriefSchema + WeeklyReviewSchema) | Orchestrator rec |
| D-06 Dropped-threads detection | SQL view `dropped_threads_v` composed with new `top3_membership` table | Orchestrator rec |
| D-07 Cap-invariant 14d verifier | CloudWatch-style weekly Lambda via Scheduler → SafetyStack alarmTopic | Orchestrator rec |
| D-08 Telegram aggregation | Single message per brief, HTML parse_mode, ≤4096 chars | Orchestrator rec |

**Derived locks** (not in orchestrator brief but required for implementation):

| Decision | Locked value | Source |
|---------|-------------|--------|
| D-14 Migration number | **0014** (Phase 6 reserves 0012; Phase 4 reserves 0013) | Collision guard mirror of Plan 04-00 pattern |
| D-17 Hot-entity window | last 48h for morning-brief; last 12h for day-close; last 7d for weekly | Derived from brief cadence |
| D-18 Morning brief schedule | **08:00 Stockholm** (NOT 07:00 — honors quiet-hours invariant 20:00-08:00) | Honors push-telegram `quiet-hours.ts` contract; drift from AUTO-01 spec documented |
| D-09 agent_runs idempotency | Brief ULID keyed; duplicate capture_id → short-circuit | Mirrors Phase 2 idempotency pattern |

---

## Open Questions (parked, not blockers)

1. **Should D-18 restore 07:00?** Requires coordinated change to quiet-hours end time in `services/push-telegram/src/quiet-hours.ts` (h < 8 → h < 7). Out of Phase 7 scope; revisit in a Phase 10+ polish pass if Kevin prefers the original 07:00.
2. **Calendar integration for morning-brief (CAP-09)** — Phase 8 owns; Phase 7 renders `(Calendar integration pending Phase 8)` placeholder. Confirmed with ROADMAP dependency graph.
3. **Top 3 "acted_on" signal** — currently only `mention_events` INSERT updates `top3_membership.acted_on_at`. Tighter signals (email sent, Command Center Status → Klar) are deferred. False-positive rate (entity mentioned ≠ actioned) is acceptable for v1 ADHD-focused user.
4. **Cohort analysis of cap violations** — v1 just reports; future could auto-tune (e.g., if urgent emails spike, loosen cap to 4 for that day). Out of scope.
5. **Brief regeneration on operator demand** — no on-demand invocation Lambda; operator can `aws lambda invoke` directly for testing. Future enhancement.

---

## Deviations from Orchestrator Brief

**None.** All 7 gray-area recommendations accepted verbatim. The only "deviation" is the 08:00 morning-brief schedule (D-18) — this is NOT a deviation from the orchestrator but a necessary reconciliation with the Phase 1 quiet-hours contract (`services/push-telegram/src/quiet-hours.ts` asserts h < 8 = quiet). The orchestrator brief explicitly flagged this as an invariant to honor; moving 07:00 → 08:00 was the cleanest resolution.

---

## Plan Set Produced

| Plan | Title | Wave | Tasks |
|------|-------|------|-------|
| 07-00 | Wave 0 scaffold — service skeletons + brief schemas + migration 0014 + CDK stub | 0 | 4 |
| 07-01 | Morning brief Lambda + shared brief-renderer + CDK schedule (08:00 weekdays) | 1 | 3 |
| 07-02 | Day-close + Weekly-review Lambdas + CDK schedules | 1 (parallel with 07-01 for Lambda code; 07-02 CDK wiring depends on 07-01's CDK foundation) | 3 |
| 07-03 | AUTO-02 scheduler-only CDK addition (cron 0 8/2) | 2 | 1 |
| 07-04 | verify-notification-cap Lambda + 3 CLI scripts + weekly compliance schedule | 3 | 3 |

**Total tasks:** 14.
**Files modified:** ~45 across 4 service workspaces + 1 migration + 1 CDK helper file + 1 contracts file + 3 scripts.

---

## Wave Structure Rationale

- **Wave 0** single plan (07-00): all scaffold in one commit; subsequent plans can grep for schemas + helpers without worrying about scaffold collision.
- **Wave 1** parallel plans (07-01 ‖ 07-02): morning-brief is the most complex single brief (has Top 3 + dropped-threads flow that others inherit); day-close + weekly-review are simpler mirrors that can run in parallel once 07-01 has completed the shared `brief-renderer.ts` implementation. Wave 1 ordering: 07-01 must finish before 07-02 can start (because 07-02 imports `services/_shared/brief-renderer.ts`). Effectively sequential despite the "parallel" label — logged for wave-execution clarity.
- **Wave 2** (07-03): AUTO-02 scheduler is a trivial CDK-only addition; independent of morning/day-close/weekly Lambdas. Can parallelize with Wave 1 from a file-ownership standpoint (only touches integrations-lifecycle.ts, but so do 07-01..07-02). **File-overlap constraint forces 07-03 into Wave 2** (or Wave 1 LAST, after 07-02 has committed CDK wiring).
- **Wave 3** (07-04): verifier Lambda + scripts + compliance schedule. Depends on agent_runs producing brief rows, which requires 07-01..07-02 to have shipped AT LEAST the Lambda code path. 07-03 independent.

**Wave file-overlap note:** All of 07-01, 07-02, 07-03, 07-04 modify `packages/cdk/lib/stacks/integrations-lifecycle.ts`. To keep parallelism safe, the CDK helper grows by APPEND-ONLY blocks — each plan adds a new section (IAM + schedule for its Lambda) without touching prior sections. If executed sequentially (07-01 → 07-02 → 07-03 → 07-04), no conflicts. If executed in parallel on separate branches, an executor must manually reconcile the appends.

---

## Commit Plan (atomic, file-granularity)

Each plan's files commit together in one atomic commit via `gsd-sdk query commit`:

1. `docs(07): create phase context + research + validation` — 07-CONTEXT.md + 07-RESEARCH.md + 07-VALIDATION.md
2. `docs(07): create phase plans 00-04 + discussion log` — 07-00-PLAN.md + 07-01-PLAN.md + 07-02-PLAN.md + 07-03-PLAN.md + 07-04-PLAN.md + 07-DISCUSSION-LOG.md

Per operator convention these can be combined into a single commit if that's cleaner for the planner workflow (the orchestrator brief allows atomic commit).

---

*Phase 7 planning complete 2026-04-24. Kevin can `/gsd-execute-phase 7` after seeding `todayPage` + `dailyBriefLog` in `scripts/.notion-db-ids.json` + confirming Daily Brief Log DB has Type (select) + Date (date) columns.*
