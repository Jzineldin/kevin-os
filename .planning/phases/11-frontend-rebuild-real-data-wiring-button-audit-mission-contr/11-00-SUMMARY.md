---
phase: 11
plan: 0
subsystem: frontend-rebuild-prep
tags: [wave-0, scaffolding, visual-baseline, test-scaffolds]
status: complete
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
  tasks_completed: 3
  tasks_blocked: 0
  duration_minutes: ~25
  completed_date: 2026-04-26
open_questions_resolved:
  Q1_agent_name_granularity: "RESOLVED — agent_runs.agent_name is fine-grained: triage(1641), voice-capture(27), granola-poller(20), transcript-extractor(19), entity-resolver:<name>, weekly-review, day-close, transcript-indexed. Channel-health derivation via agent_name COUNT/MAX is viable without falling back to outputJson->>channel."
  Q2_capture_table_shape: "RESOLVED with deviation — capture_text and capture_voice tables DO NOT EXIST in prod RDS. Captures live across event_log (kind+detail jsonb), mention_events (3 sources: granola-transcript, telegram-voice, dashboard-text), inbox_index (4 kinds: new_entity, draft_reply, entity_routing, merge_resume), telegram_inbox_queue, and email_drafts. Plan 11-04 today aggregation must UNION across these tables instead of capture_text/capture_voice."
  Q5_bastion_reachable: "RESOLVED — kos-bastion provisioned via cdk deploy KosData --context bastion=true (i-0c1ee4fefaf1448ce, t4g.nano), SSM agent online, port-forward 55432->5432 verified, dashboard_api role connects with password from kos/db/dashboard_api secret."
demo_inventory_pre_wipe:
  inbox_index: 7  # demo-01,02,04,05,06,08,10
  email_drafts: 0  # the 'Re: Partnership proposal'/'Re: Summer meeting' rows visible in dashboard are inbox_index draft_reply rows, not actual email_drafts
  agent_dead_letter: 0
  total: 7
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

## Task 0 — Schema Verification + Pre-Wipe Inventory (RESOLVED 2026-04-26)

Operator authorized "yes A" path: orchestrator drove CDK deploy + SSM port-forward + psql verification autonomously. Bastion provisioned, schema captured, demo-row CSV captured.

### Bastion provisioning

```bash
GCP_PROJECT_ID=kevin-os-494418 KEVIN_OWNER_ID=7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c \
  npx cdk deploy KosData --context bastion=true     # ~4 min, exit 0
```

The env vars matter — without them the synth wants to drop the unrelated `GcpVertexSa` export (cross-stack collision with KosIntegrations), which would fail the deploy. With them set, the diff is purely additive (new bastion EC2 + IAM role + SG ingress to RDS).

Bastion: `i-0c1ee4fefaf1448ce` (t4g.nano, KosData stack, tag Name=BastionHost).

### SSM port-forward + psql connection

```bash
aws ssm start-session --target i-0c1ee4fefaf1448ce \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["kosdata-rdsinstance5075e838-9prpmgxajujc.cts46s6u6r3l.eu-north-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["55432"]}'
```

Connected as `dashboard_api` role using password from `kos/db/dashboard_api` secret. Schema queries written to [`11-WAVE-0-SCHEMA-VERIFICATION.md`](11-WAVE-0-SCHEMA-VERIFICATION.md) (381 lines).

### Open Questions resolution

**Q1 — `agent_runs.agent_name` granularity (channel-health derivation):** RESOLVED, granular enough.

| agent_name (top entries) | runs |
|---|---:|
| `triage` | 1641 |
| `voice-capture` | 27 |
| `granola-poller` | 20 |
| `transcript-extractor` | 19 |
| `entity-resolver:<name>` | 5–16 each |
| `weekly-review` | 4 |
| `day-close` | 3 |
| `transcript-indexed` | 15 |

Plan 11-06 channel-health endpoint can derive Telegram health from `triage` + `voice-capture`, Granola health from `granola-poller`, etc. without parsing `outputJson->>channel`.

**Q2 — `capture_text` / `capture_voice` column shape:** RESOLVED with deviation. Tables DO NOT EXIST. Captures span:

| Table | Shape (key cols) | Purpose |
|---|---|---|
| `event_log` | `kind text`, `detail jsonb`, `occurred_at`, `actor` | Phase 10 cross-system audit log per packages/contracts/src/migration.ts EventLogKindSchema |
| `mention_events` | `source text` (3 distinct: granola-transcript, telegram-voice, dashboard-text) | Per-mention router input |
| `inbox_index` | `kind text` (4 distinct: new_entity, draft_reply, entity_routing, merge_resume), `title`, `status`, `created_at` | Phase 3 inbox surface |
| `telegram_inbox_queue` | (telegram-specific) | Telegram capture queue |
| `email_drafts` | `subject`, `draft_subject`, `classification`, `status`, `received_at` | Phase 4 email drafts |

**Plan 11-04 deviation required:** the `/today` "captures today" aggregation must UNION across these tables, not query `capture_text` / `capture_voice`. This will be flagged as a Wave 2 deviation in Plan 11-04's executor prompt.

**Q5 — Bastion reachability:** RESOLVED. Bastion provisioned, SSM agent online, port-forward verified.

### Pre-wipe demo-row inventory

Captured to [`demo-rows-pre-wipe.csv`](demo-rows-pre-wipe.csv) for D-03 reversibility:

| tbl | rows | ids | source |
|---|---:|---|---|
| `inbox_index` | 7 | demo-01..10 (skipping 03,07,09) | inserted 2026-04-23 22:33:29 — likely the early dev seed |
| `email_drafts` | 0 | — | demo names visible in dashboard's Today/Inbox are inbox_index draft_reply rows, not actual email_drafts |
| `agent_dead_letter` | 0 | — | no dead-letters reference demo names |

**Total demo rows: 7**, all in `inbox_index` with id pattern `demo-NN`. Plan 11-01's wipe SQL targets these specifically (D-03).

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

Task 0 artifacts now present:

```text
[ -f .planning/phases/11-.../11-WAVE-0-SCHEMA-VERIFICATION.md ]  → FOUND (381 lines)
[ -f .planning/phases/11-.../demo-rows-pre-wipe.csv ]            → FOUND (8 lines incl. header)
```

Committed in `56d4c2c chore(11-00): finalize Wave 0 schema verification + pre-wipe CSV`.
