---
phase: 11
slug: frontend-rebuild-real-data-wiring-button-audit-mission-contr
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| _TBD by planner_ | | | | | | | | | ⬜ pending |

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
