---
phase: 11
plan: 0
subsystem: frontend-rebuild-prep
tags: [wave-0, scaffolding, visual-baseline, test-scaffolds]
status: partial-blocked-on-operator
requirements: [REQ-1, REQ-3, REQ-12]
dependency_graph:
  requires: []
  provides:
    - apps/dashboard/tests/visual-baseline/{today,inbox,entities,calendar}.png
    - apps/dashboard/tests/e2e/{inbox,today,visual,button-audit,empty-states}.spec.ts
    - apps/dashboard/src/lib/button-registry.ts
    - services/dashboard-api/tests/{integrations-health,seed-pollution-guard}.test.ts
    - extended services/dashboard-api/tests/{today,calendar}.test.ts
    - scripts/verify-phase-11-wipe.sh
  affects:
    - All Wave 1-4 plans depend on these scaffolds existing
tech-stack:
  added: []  # Playwright was already in devDeps
  patterns:
    - Skipped-test placeholders behind PLAYWRIGHT_BASE_URL skip-guard
    - Parametric e2e via importable readonly registry (button-registry.ts)
    - Cookie-auth Playwright capture via one-shot helper (deleted post-run)
key-files:
  created:
    - apps/dashboard/tests/visual-baseline/today.png
    - apps/dashboard/tests/visual-baseline/inbox.png
    - apps/dashboard/tests/visual-baseline/entities.png
    - apps/dashboard/tests/visual-baseline/calendar.png
    - apps/dashboard/tests/e2e/inbox.spec.ts
    - apps/dashboard/tests/e2e/visual.spec.ts
    - apps/dashboard/tests/e2e/button-audit.spec.ts
    - apps/dashboard/tests/e2e/empty-states.spec.ts
    - apps/dashboard/src/lib/button-registry.ts
    - services/dashboard-api/tests/integrations-health.test.ts
    - services/dashboard-api/tests/seed-pollution-guard.test.ts
    - scripts/verify-phase-11-wipe.sh
  modified:
    - apps/dashboard/tests/e2e/today.spec.ts
    - services/dashboard-api/tests/today.test.ts
    - services/dashboard-api/tests/calendar.test.ts
decisions:
  - "Playwright 1.51.1 already installed; no devDep additions needed"
  - "Visual baselines captured via one-shot helper script then deleted; PNGs committed as evidence-of-state"
  - "BUTTON_REGISTRY ships as empty readonly array — Wave 3 populates"
  - "Helper script for capture-baseline.mjs deleted post-run (single-use; PNGs stay)"
metrics:
  tasks_completed: 2
  tasks_blocked: 1
  duration_minutes: ~8
  completed_date: 2026-04-26
---

# Phase 11 Plan 11-00: Wave 0 Schema Verification + Test Scaffolds Summary

Wave 0 prep partially complete (2/3 tasks) — Playwright visual baselines captured against deployed Vercel dashboard and all 11 test scaffolds laid down. **Task 0 (operator-driven schema + bastion verification) is blocked: the kos-bastion EC2 instance is not running and re-provisioning it is a production infrastructure mutation that requires explicit operator action.**

## What Got Done

### Task 1 — Visual baselines (commit 978a0e6)

Playwright + chromium were already installed at v1.51.1; no devDep additions needed. Created `apps/dashboard/tests/visual-baseline/` and captured fullPage 1440x900 PNGs of the four pre-rebuild routes via a one-shot helper script (`apps/dashboard/scripts/capture-baseline.mjs`, deleted after the run). All four PNGs are >10KB and were verified visually:

| Route       | Path                                                      | Size       |
|-------------|-----------------------------------------------------------|-----------:|
| /today      | `apps/dashboard/tests/visual-baseline/today.png`          | 83,198 B   |
| /inbox      | `apps/dashboard/tests/visual-baseline/inbox.png`          | 90,144 B   |
| /entities   | `apps/dashboard/tests/visual-baseline/entities.png`       | 35,925 B   |
| /calendar   | `apps/dashboard/tests/visual-baseline/calendar.png`       | 37,618 B   |

The today.png baseline notably contains the demo rows ("Re: Partnership proposal" + "Re: Summer meeting" in the Drafts to Review section + "Damien's email" reference) — independent confirmation that the D-03 wipe targets in CONTEXT.md accurately describe live data on prod.

Script auth used the kos-dashboard bearer token from `kos/dashboard-bearer-token` set as a kos_session cookie. Vercel returned 200 OK on each route. Networkidle waits timed out (SSE keeps connections open) but domcontentloaded fallback rendered cleanly.

### Task 2 — Test scaffolds + button registry stub (commit 6b2b6e3)

Eleven files laid down:

| File                                                                       | Type | Status                                |
|----------------------------------------------------------------------------|------|---------------------------------------|
| apps/dashboard/tests/e2e/inbox.spec.ts                                     | NEW  | 3 skipped (Wave 2)                    |
| apps/dashboard/tests/e2e/today.spec.ts                                     | EXT  | 3 new skipped + 1 active (Wave 2)     |
| apps/dashboard/tests/e2e/visual.spec.ts                                    | NEW  | 5 routes parametric, all skipped (W4) |
| apps/dashboard/tests/e2e/button-audit.spec.ts                              | NEW  | parametric over BUTTON_REGISTRY (W4)  |
| apps/dashboard/tests/e2e/empty-states.spec.ts                              | NEW  | 5 routes parametric, all skipped (W4) |
| apps/dashboard/src/lib/button-registry.ts                                  | NEW  | empty readonly array stub             |
| services/dashboard-api/tests/integrations-health.test.ts                   | NEW  | 3 skipped (Wave 2)                    |
| services/dashboard-api/tests/today.test.ts                                 | EXT  | +1 skipped placeholder                |
| services/dashboard-api/tests/calendar.test.ts                              | EXT  | +1 skipped placeholder                |
| services/dashboard-api/tests/seed-pollution-guard.test.ts                  | NEW  | 3 skipped (Wave 1)                    |
| scripts/verify-phase-11-wipe.sh                                            | NEW  | bash skeleton, executable, exits 0    |

Verification (run during commit prep):

```text
pnpm -F @kos/dashboard test          → 109 passed | 4 skipped | 0 failed (21 files)
pnpm -F @kos/dashboard-api test      →  79 passed | 8 skipped | 0 failed (15 files)
pnpm -F @kos/dashboard typecheck     → clean (button-registry compiles)
pnpm -F @kos/dashboard-api typecheck → clean
bash scripts/verify-phase-11-wipe.sh → exit 0
```

## What Remains — Task 0 (BLOCKED on operator)

Per the plan's `<task type="checkpoint:human-action" gate="blocking">` directive, Task 0 (operator-driven schema + bastion verification) requires:

1. **Bastion provisioning** — `aws ec2 describe-instances --filters Name=tag:Name,Values=kos-bastion` returned NO instances under any tag convention (`kos-bastion`, `KosBastion`, `KosData` stack). The active todo in STATE.md is "Tear down bastion (1 cdk command)", consistent with the bastion having never been re-provisioned after Phase 4. Re-provisioning requires operator action because it mutates production infrastructure.
2. **psql execution against prod RDS** — describe + COUNT + COPY against `kosdata-rdsinstance5075e838-9prpmgxajujc.cts46s6u6r3l.eu-north-1.rds.amazonaws.com` via the bastion SSM port-forward.
3. **Schema verification doc** — `.planning/phases/11-.../11-WAVE-0-SCHEMA-VERIFICATION.md` documenting the answers to RESEARCH Open Q1 (`agent_runs.agent_name` granularity), Q2 (`capture_text` / `capture_voice` / `mention_events` columns), and Q5 (bastion reachability).
4. **Pre-wipe demo-row inventory CSV** — `.planning/phases/11-.../demo-rows-pre-wipe.csv` so D-03's wipe is reversible per the plan's threat model T-11-00-03.

Auto mode rule 5 explicitly forbids non-confirmed mutations of shared / production systems, so this work is being handed back to the operator. Tasks 1 and 2 do not depend on Task 0's output — they could complete independently.

### Operator instructions

See the **CHECKPOINT REACHED** section returned to the orchestrator (or the `## OPERATOR INSTRUCTIONS` block in this summary's checkpoint output). Once the operator runs the SQL session and produces the verification doc + CSV, a continuation agent fills in this summary's gaps:

- frontmatter `status: partial-blocked-on-operator` → `complete`
- frontmatter `tasks_blocked: 1` → `0`
- This section is replaced with: agent_runs granularity decision, capture_text/voice/mention column names, bastion connection method used, pre-wipe demo-row inventory counts.

## Deviations from Plan

### None for Tasks 1 & 2

Both executed exactly as written. The only minor adaptations:

1. **Task 1 step 3:** plan said `await page.goto(..., { waitUntil: 'networkidle' })`. Networkidle never settles on the live dashboard because of the persistent SSE connection — the helper script wraps the goto in a try/catch and falls back to `domcontentloaded` + 1500ms wait. The captured PNGs render correctly (verified visually). This adjustment was caught and resolved in-flight; no re-run needed.
2. **Task 0 gate:** plan referenced infra path `infra/cdk` for the cdk deploy command. Actual location is `packages/cdk`. Operator instructions reflect the correct path.

### None for Task 2

All 11 files match the plan's spec verbatim.

## Self-Check: PASSED

Verified post-write:

```text
[ -f apps/dashboard/tests/visual-baseline/today.png ]      → FOUND
[ -f apps/dashboard/tests/visual-baseline/inbox.png ]      → FOUND
[ -f apps/dashboard/tests/visual-baseline/entities.png ]   → FOUND
[ -f apps/dashboard/tests/visual-baseline/calendar.png ]   → FOUND
[ -f apps/dashboard/tests/e2e/inbox.spec.ts ]              → FOUND
[ -f apps/dashboard/tests/e2e/today.spec.ts ]              → FOUND (extended)
[ -f apps/dashboard/tests/e2e/visual.spec.ts ]             → FOUND
[ -f apps/dashboard/tests/e2e/button-audit.spec.ts ]       → FOUND
[ -f apps/dashboard/tests/e2e/empty-states.spec.ts ]       → FOUND
[ -f apps/dashboard/src/lib/button-registry.ts ]           → FOUND
[ -f services/dashboard-api/tests/integrations-health.test.ts ] → FOUND
[ -f services/dashboard-api/tests/today.test.ts ]               → FOUND (extended)
[ -f services/dashboard-api/tests/calendar.test.ts ]            → FOUND (extended)
[ -f services/dashboard-api/tests/seed-pollution-guard.test.ts ]→ FOUND
[ -f scripts/verify-phase-11-wipe.sh ]                          → FOUND (executable)
[ -x scripts/verify-phase-11-wipe.sh ]                          → TRUE

git log --oneline -5 | grep 978a0e6   → FOUND (Task 1 baseline commit)
git log --oneline -5 | grep 6b2b6e3   → FOUND (Task 2 scaffolds commit)
```

Task 0 artifacts (`11-WAVE-0-SCHEMA-VERIFICATION.md`, `demo-rows-pre-wipe.csv`) are intentionally absent until the operator returns with verified bastion + psql output.
