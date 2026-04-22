---
phase: 3
slug: dashboard-mvp
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-23
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `03-RESEARCH.md` §15 "Validation Architecture (Nyquist D-8)".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.x (unit/integration) + Playwright 1.49+ (E2E) + Lighthouse CI 0.14+ (perf budgets) |
| **Config file** | `apps/dashboard/vitest.config.ts`, `apps/dashboard/playwright.config.ts`, `apps/dashboard/lighthouserc.json` (all Wave 0 installs — none exist yet) |
| **Quick run command** | `pnpm --filter @kos/dashboard test --run` |
| **Full suite command** | `pnpm --filter @kos/dashboard test --run && pnpm --filter @kos/dashboard e2e && pnpm --filter @kos/dashboard lhci autorun` |
| **Estimated runtime** | ~180 seconds (unit + integration ~30s, Playwright E2E ~90s, Lighthouse CI ~60s) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @kos/dashboard test --run`
- **After every plan wave:** Run full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

Populated by the planner. Every task MUST be mapped here with either an automated command OR a Wave 0 dependency for the test infra it requires. Requirement IDs come from ROADMAP.md Phase 3 mapping: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, ENT-07, ENT-08, INF-12.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| *(populated by planner)* | | | | | | | | | |

---

## Wave 0 Requirements

From RESEARCH.md §15.1 "Nyquist-compliant test strategy — Wave 0 gaps". These must all be addressed in Wave 0 before any view/SSE/merge plan runs:

- [ ] `apps/dashboard/package.json` — new workspace with Next 15.5.x + React 19.2.5 + Tailwind 4.2.4
- [ ] `apps/dashboard/vitest.config.ts` — Vitest 2.x config with jsdom env + path aliases matching `tsconfig.base.json`
- [ ] `apps/dashboard/playwright.config.ts` — Playwright with Chromium + mobile-android project + deployed-preview target + baseURL env var
- [ ] `apps/dashboard/lighthouserc.json` — Lighthouse CI config with performance budgets (TTI < 1.5s Today, TBT < 300ms, CLS < 0.1)
- [ ] `apps/dashboard/tests/unit/` — directory + shared test setup file (`apps/dashboard/tests/unit/setup.ts`)
- [ ] `apps/dashboard/tests/e2e/` — directory + `apps/dashboard/tests/e2e/fixtures.ts` (auth cookie fixture, seed data fixture)
- [ ] `apps/dashboard/tests/integration/api-layer.test.ts` — stub file for SigV4 signing + dashboard-api round-trip tests
- [ ] CI job in `.github/workflows/dashboard-ci.yml` (or equivalent) — runs quick suite on PR, full suite on main
- [ ] `packages/test-fixtures/src/dashboard/` — shared fixtures for entity rows, inbox items, Today-view shape (reuse pattern from Phase 2)
- [ ] `apps/dashboard/tests/e2e/pwa-install.spec.ts` — stub for manifest + service-worker registration + Android install criteria
- [ ] `apps/dashboard/tests/e2e/sse-reconnect.spec.ts` — stub for SSE open → kill stream → auto-reconnect ≤ 1s
- [ ] `apps/dashboard/tests/e2e/merge-audit.spec.ts` — stub asserting `entity_merge_audit` row written per merge + Resume card on partial failure
- [ ] `apps/dashboard/tests/e2e/inbox-keyboard.spec.ts` — stub for J/K/Enter/E/S keyboard flow
- [ ] `apps/dashboard/tests/e2e/auth-middleware.spec.ts` — stub for unauth redirect + cookie set + logout
- [ ] `services/dashboard-listen-relay/tests/listen-reconnect.test.ts` — stub for pg-listen auto-reconnect on Postgres restart
- [ ] `services/dashboard-api/tests/merge-transactional.test.ts` — stub for transactional merge + rollback on partial failure
- [ ] `services/dashboard-notify/tests/notify-payload.test.ts` — stub for pointer-only NOTIFY payload (< 8KB)
- [ ] `packages/contracts/src/dashboard.ts` — zod schemas for all dashboard-api routes (shared between client + server)

Per §15.2 of RESEARCH.md, these 18 gaps are the Wave 0 scope. They block all Wave 1+ work.

---

## Manual-Only Verifications

Three Phase 3 behaviours have physical/UX manifestations that require manual confirmation:

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Android home-screen PWA install | UI-05 | Install criteria depend on Chrome's `beforeinstallprompt` UX + device state; cannot be fully automated | On a real Android device: navigate to deployed URL → Chrome menu → "Install app" appears → install → icon on home screen → launch opens in standalone mode without Chrome chrome |
| iOS Safari Add-to-Home-Screen shortcut | UI-05 | iOS DMA removed standalone PWA behaviour — install works but is a Safari shortcut, not a PWA. Test validates the UX deliberately stops here | On iOS 17+: Safari → deployed URL → Share → Add to Home Screen → shortcut appears → tap launches in Safari with URL bar (not standalone) |
| Desktop PWA install (Chrome/Edge) | UI-05 | Same UX-dependent install chrome as Android | On macOS/Windows Chrome or Edge: navigate to deployed URL → address bar install icon appears → click → app installs → launches in standalone window |

All other behaviors (auth flow, SSE push + reconnect, merge audit, view rendering, keyboard shortcuts, timeline virtualization, offline cache) are covered by the automated suite above.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies (populated by planner)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (18 items above)
- [ ] No watch-mode flags in CI commands
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
