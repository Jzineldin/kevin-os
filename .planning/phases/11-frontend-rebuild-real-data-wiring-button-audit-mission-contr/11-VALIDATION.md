---
phase: 11
slug: frontend-rebuild-real-data-wiring-button-audit-mission-contr
status: draft
nyquist_compliant: true
wave_0_complete: false  # toggles to true after 11-00 completes
created: 2026-04-26
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 1.x (frontend + dashboard-api), Playwright 1.x (E2E + visual regression) |
| **Config file** | `apps/dashboard/vitest.config.ts`, `services/dashboard-api/vitest.config.ts`, `apps/dashboard/playwright.config.ts` (Wave 0 installs Playwright if missing) |
| **Quick run command** | `pnpm --filter @kos/dashboard test --run` |
| **Full suite command** | `pnpm -r test && pnpm --filter @kos/dashboard exec playwright test` |
| **Estimated runtime** | ~120 seconds (unit) + ~60 seconds (E2E + visual) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @kos/dashboard test --run --changed`
- **After every plan wave:** Run `pnpm -r test`
- **Before `/gsd-verify-work`:** Full suite (unit + E2E + visual) must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

> Filled in by gsd-planner during planning. Each plan task gets a row mapping to a REQ-ID and an automated command.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-00-T0 | 00 | 0 | REQ-1/3/12 | T-11-00-01 | Schema verified + pre-wipe CSV captured | manual+smoke | `cat .planning/phases/11-*/11-WAVE-0-SCHEMA-VERIFICATION.md` | ❌ Wave 0 | ⬜ pending |
| 11-00-T1 | 00 | 0 | REQ-3 | T-11-00-02 | Visual baselines captured pre-rebuild | smoke | `ls -la apps/dashboard/tests/visual-baseline/*.png` | ❌ Wave 0 | ⬜ pending |
| 11-00-T2 | 00 | 0 | REQ-1/3/12 | — | Test scaffolds laid for Waves 1-4 | unit | `pnpm -F @kos/dashboard test --run && pnpm -F @kos/dashboard-api test --run` | ❌ Wave 0 | ⬜ pending |
| 11-01-T1 | 01 | 1 | REQ-12 | T-11-01-01,02 | Startup guard fails-loud on seed pollution | unit | `pnpm -F @kos/dashboard-api test --run seed-pollution-guard` | ❌ Wave 0 | ⬜ pending |
| 11-01-T2 | 01 | 1 | REQ-12 | T-11-01-01 | Dashboard-api returns 503 when guard tripped | unit | `pnpm -F @kos/dashboard-api test --run seed-pollution-handler` | ❌ Wave 0 | ⬜ pending |
| 11-01-T3 | 01 | 1 | REQ-12 | T-11-01-01 | Demo names absent from prod RDS | smoke | `bash scripts/verify-phase-11-wipe.sh` | ❌ Wave 0 | ⬜ pending |
| 11-02-T1 | 02 | 1 | REQ-3 | T-11-02-02 | shadcn primitives installed + design-tokens typed | unit | `pnpm -F @kos/dashboard typecheck` | ✅ exists | ⬜ pending |
| 11-02-T2 | 02 | 1 | REQ-3 | T-11-02-01,03 | Pill+StatTile+ChannelHealth+PriorityRow render | unit | `pnpm -F @kos/dashboard test --run dashboard` | ❌ Wave 0 | ⬜ pending |
| 11-02-T3 | 02 | 1 | REQ-3 | T-11-02-04 | ChatBubble + ChatSheet shell components compile | unit | `pnpm -F @kos/dashboard typecheck` | ✅ exists | ⬜ pending |
| 11-03-T1 | 03 | 2 | REQ-12 | T-11-03-01,03 | listInboxDrafts no longer filters status; contract additive | unit | `pnpm -F @kos/dashboard-api test --run email-drafts` | ✅ exists; extend | ⬜ pending |
| 11-03-T2 | 03 | 2 | REQ-12 | T-11-03-04 | /inbox-merged UNIONs inbox_index + maps classification | unit | `pnpm -F @kos/dashboard-api test --run inbox` | ❌ Wave 0 | ⬜ pending |
| 11-03-T3 | 03 | 2 | REQ-12 | T-11-03-02 | ItemRow renders Pill; Approve/Skip hidden on terminal status | unit+e2e | `pnpm -F @kos/dashboard test --run inbox` | ❌ Wave 0 | ⬜ pending |
| 11-04-T1 | 04 | 2 | REQ-1 | T-11-04-01,02,04 | /today returns captures_today + stat_tiles + channels | unit | `pnpm -F @kos/dashboard-api test --run today` | ✅ exists; extend | ⬜ pending |
| 11-04-T2 | 04 | 2 | REQ-3 | — | StatTileStrip + CapturesList render with empty-state | unit | `pnpm -F @kos/dashboard typecheck` | ✅ exists | ⬜ pending |
| 11-04-T3 | 04 | 2 | REQ-1/3 | — | TodayView wires new sections + e2e for stat tiles | e2e | `pnpm -F @kos/dashboard exec playwright test today.spec.ts` | ❌ Wave 0 | ⬜ pending |
| 11-05-T1 | 05 | 2 | REQ-1 | T-11-05-02,04 | /calendar UNIONs Notion CC + calendar_events_cache; dedupes | unit | `pnpm -F @kos/dashboard-api test --run calendar` | ✅ exists; extend | ⬜ pending |
| 11-05-T2 | 05 | 2 | REQ-3 | — | CalendarWeekView distinguishes meeting vs deadline | unit | `pnpm -F @kos/dashboard typecheck` | ✅ exists | ⬜ pending |
| 11-06-T1 | 06 | 2 | REQ-1 | T-11-06-02,04 | /integrations/health classifies channels + schedulers | unit | `pnpm -F @kos/dashboard-api test --run integrations` | ❌ Wave 0 | ⬜ pending |
| 11-06-T2 | 06 | 2 | REQ-1/3 | — | /integrations-health page renders both lists | unit | `pnpm -F @kos/dashboard typecheck` | ✅ exists | ⬜ pending |
| 11-06-T3 | 06 | 2 | REQ-1 | — | Sidebar Health entry navigates correctly | e2e | included in button-audit.spec.ts | ❌ Wave 0 | ⬜ pending |
| 11-07-T1 | 07 | 3 | REQ-12 | T-11-07-02 | Button audit doc completed + Kevin verdict | manual | review of 11-BUTTON-AUDIT.md | ❌ Wave 0 | ⬜ pending |
| 11-07-T2 | 07 | 3 | REQ-3/12 | T-11-07-02,03 | data-testids added; ChatBubble mounted; Settings decision applied | unit | `pnpm -F @kos/dashboard typecheck` | ✅ exists | ⬜ pending |
| 11-07-T3 | 07 | 3 | — | — | BUTTON_REGISTRY populated from audit | unit | grep verification + typecheck | ❌ Wave 0 | ⬜ pending |
| 11-08-T1 | 08 | 4 | REQ-1/3/12 | — | visual + button-audit + empty-state e2e activated | e2e | `pnpm -F @kos/dashboard exec playwright test` | ❌ Wave 0 | ⬜ pending |
| 11-08-T2 | 08 | 4 | REQ-1/3/12 | T-11-08-01,02,04 | Phase gate evidence + Kevin sign-off | manual+smoke | `cat .planning/phases/11-*/11-PHASE-GATE.md \| grep PASS` | ❌ Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

> Verification-infrastructure setup tasks the planner must include before any feature plan executes.

- [ ] **Schema verification** — psql via bastion: `\d+ agent_runs` (confirm `agent_name` granularity), `\d+ capture_text` (confirm `source_kind` discriminator). Documents Open Q1 + Q2 from RESEARCH.md.
- [ ] **Bastion reachability** — `aws ec2 describe-instances --filters Name=tag:Name,Values=kos-bastion --query "Reservations[].Instances[].State.Name"` returns `running`. Documents Open Q5 from RESEARCH.md.
- [ ] **Playwright install** — `pnpm --filter @kos/dashboard add -D @playwright/test` if not already present; `pnpm exec playwright install chromium`.
- [ ] **Visual-regression baseline** — Capture pre-rebuild screenshots of every `(app)/*` route to `tests/visual-baseline/` so regression tests catch unintended drift during the rebuild waves.
- [ ] **Demo-row inventory snapshot** — Pre-wipe SELECT into a CSV at `.planning/phases/11-*/demo-rows-pre-wipe.csv` so D-03 can be reverted if Kevin disagrees with what was deleted.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Mission-control aesthetic match | REQ-3 (Calm visual UX) | Subjective — Kevin must agree it looks right | After Wave 2, Kevin opens https://kos-dashboard-navy.vercel.app and confirms the look matches mission-control screenshots. Sign-off recorded in plan acceptance. |
| Real Telegram capture surfaces in /today | REQ-1 (Dashboard view) | Cross-system smoke test — depends on bot token + EventBridge + Lambda + RDS + dashboard | Kevin sends a Swedish voice memo to the bot, then refreshes /today within 60s. Capture must appear in the activity feed. |
| Empty-state copy reads well | REQ-3 (Calm visual UX) | Copy review — automated test only checks rendering | Kevin reviews each empty state ("No captures today — KOS will surface as they arrive" etc.) for tone consistency. |
| Channel health correctness | REQ-1 (Dashboard view) | Requires watching CloudWatch + dashboard simultaneously | After /integrations-health is built, manually break one Lambda (e.g. set `KILL_SWITCH=true` env on calendar-reader) and verify the dashboard flips that channel to red within 5 minutes. Restore after. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (Open Q1, Q2, Q5)
- [ ] No watch-mode flags (vitest --run, playwright --reporter=list)
- [ ] Feedback latency < 120s for unit, < 180s for full
- [ ] `nyquist_compliant: true` set in frontmatter (after planner fills the per-task map)

**Approval:** pending
</content>
</invoke>