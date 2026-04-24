---
phase: 06-granola-semantic-memory
plan: 06
subsystem: gate-verifier
tags: [e2e, gate-verifier, phase-6-acceptance, verifier-only, mirror-phase-2-pattern]

# Dependency graph
requires:
  - phase: 06-granola-semantic-memory
    provides: "All Phase 6 plans 06-00..06-05 (granola-poller, transcript-extractor, azure-search hybrid, entity-timeline-refresher, context-loader, dossier-loader)"
  - phase: 02-minimum-viable-loop
    provides: "scripts/verify-phase-2-e2e.mjs + verify-resolver-three-stage.mjs + 02-11-GATE-2-evidence-* (mirror pattern)"
provides:
  - "scripts/verify-phase-6-e2e.mjs (641 lines) — Phase 6 quality-multiplier integration test (mock + live)"
  - "scripts/verify-phase-6-gate.mjs (452 lines) — 7-criterion gate verifier with PASS/FAIL/HUMAN reporting"
  - ".planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-template.md (128 lines) — operator-fillable acceptance evidence template"
  - "Single-command Phase 6 completion check: `node scripts/verify-phase-6-gate.mjs` exits 0 iff zero FAILs"
affects: [phase-7 lifecycle (consumes loadContext + AGT-06 outputs), gate-evidence audit trail]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Soft TS-import via tsx loader with structural source-grep fallback so scripts run from a fresh checkout without pnpm install"
    - "HUMAN-flagged success criteria reported separately from auto FAILs so operator-graded subjective measurements (8/10 actionable, p95 budgets, cost/call) don't block CI"
    - "Subprocess delegation for SC3 reuses existing verify-mem-03-latency.mjs harness (mock + live) instead of duplicating distribution logic"
    - "Per-SC check function returns {status, autoStatus, reason, evidence} so the orchestrator can render auto:PASS for HUMAN-flagged rows where code-side wiring is OK"

key-files:
  created:
    - "scripts/verify-phase-6-e2e.mjs"
    - "scripts/verify-phase-6-gate.mjs"
    - ".planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-template.md"
  modified: []

key-decisions:
  - "Soft tsx import + structural source-grep fallback — the verify scripts must run on a fresh checkout (CI / one-shot operator runs) where pnpm install hasn't been run; structural checks via readFileSync + regex over the .ts sources cover schema-shape drift even without a real Zod parse"
  - "HUMAN-flagged criteria use a 3-state status (PASS/FAIL/HUMAN) plus a 2-state autoStatus (PASS/FAIL); a HUMAN row with autoStatus=PASS means 'code wired; operator owns the subjective check'; with autoStatus=FAIL it means 'code-side broken AND operator owes a measurement'"
  - "SC6 cachedContent check downgraded from FAIL to advisory after first mock run flagged services/dossier-loader/src/vertex.ts as not yet using the cachedContent API — Plan 06-05 honors that as Phase 7 work; cost discipline is operator-graded via the GATE evidence template anyway"
  - "Subprocess delegation for SC3 (verify-mem-03-latency.mjs) instead of duplicating the synthetic-distribution + p95 math; keeps both scripts in sync if the latency budget changes"

patterns-established:
  - "Phase-N gate verifier pattern: scripts/verify-phase-N-e2e.mjs (integration) + scripts/verify-phase-N-gate.mjs (per-SC walker) + .planning/phases/.../N-06-GATE-evidence-template.md (operator-fillable)"
  - "Auto-mode default selection: --mock when AWS_REGION unset OR --mock flag passed; --live otherwise — eliminates accidental live-mode runs in CI"

requirements-completed:
  - CAP-08
  - AGT-04
  - AGT-06
  - MEM-03
  - MEM-04
  - AUTO-05
  - INF-10

# Metrics
duration: ~25min
completed: 2026-04-24
started: 2026-04-24
---

# Phase 6 Plan 6: E2E Acceptance Gate Summary

**Verification harness only — no business logic. Builds the single-command Phase 6 completion check (`node scripts/verify-phase-6-gate.mjs`) plus an operator-fillable evidence template, mirroring the Phase 2 02-11 pattern.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 (both auto, no TDD)
- **Files created:** 3
- **Files modified:** 0
- **Lines added:** 1221 (641 e2e + 452 gate + 128 evidence template)

## Accomplishments

- Built `scripts/verify-phase-6-e2e.mjs` — 13 PASS assertions covering the full Phase 6 quality-multiplier chain (TranscriptAvailable → transcript-extractor → loadContext → mention_events → dossier-cache trigger → entity_timeline MV → Vertex full-dossier path).
- Built `scripts/verify-phase-6-gate.mjs` — per-SC checker walking all 7 ROADMAP §Phase 6 success criteria with PASS / FAIL / HUMAN status + a separate autoStatus so HUMAN-flagged rows still report whether the code-side is wired.
- Built `.planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-template.md` — operator-fillable template formalising the 5 subjective measurements (8/10 actionable, p95 budgets, 50ms timeline route, $1.50/call, 80% cache hit).
- Both scripts are CI-safe: they run from a fresh checkout without `pnpm install` thanks to a soft tsx loader + structural source-grep fallback.
- Both scripts auto-detect mode (mock when no AWS_REGION; live otherwise) so accidental live-mode runs are impossible in CI.
- Confirmed exit-code semantics: 0 = zero FAILs (HUMAN-flagged criteria allowed); 1 = one or more FAILs.

## Task Commits

Each task was committed atomically with `--no-verify` (worktree mode):

1. **Task 1: scripts/verify-phase-6-e2e.mjs** — `4a285ea` (feat 06-06): 641-line ESM script. Mock mode: 13 structural assertions covering contracts (TranscriptAvailable, EntityMentionDetected, ContextBundle, FullDossierRequested), test fixtures (fakeGranolaTranscript canonical entity coverage), transcript-extractor wiring (loadContext + publishMentionsDetected), context-loader barrel (7 exports), migration 0012 (cache trigger + entity_timeline MV + refresh wrapper), dossier-loader Vertex (gemini-2.5-pro + europe-west4), azure-search hybridQuery (queryType: 'semantic' + kos-semantic config). Live mode: emits transcript.available to kos.capture, polls agent_runs + mention_events with optional `PHASE6_PG_URL`.
2. **Task 2: scripts/verify-phase-6-gate.mjs + 06-06-GATE-evidence-template.md** — `28dd503` (feat 06-06): 452-line gate verifier (per-SC functions + orchestrator) + 128-line evidence template. Subprocess-delegates SC3 (MEM-03 latency) to existing `scripts/verify-mem-03-latency.mjs --mock|--live` to avoid duplication.

## Files Created

### Created (3)

- **`scripts/verify-phase-6-e2e.mjs`** (641 lines, executable). Mock mode (default when AWS_REGION unset) prints 13 PASS lines and exits 0. Live mode emits `transcript.available` and polls Postgres for `agent_runs.transcript-extractor.status='ok'` within 60s. Imports tsx loader if available for real Zod parsing; falls back to source-grep checks otherwise.
- **`scripts/verify-phase-6-gate.mjs`** (452 lines, executable). Walks all 7 ROADMAP §Phase 6 success criteria, prints per-SC `[PASS] / [FAIL] / [HUMAN]` lines + summary. Exit 0 when 0 FAILs (HUMAN-flagged criteria are NOT failures — operator handles via evidence template). Live mode adds AWS-side polls on top of structural checks.
- **`.planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-template.md`** (128 lines). Operator-fillable acceptance template mirroring Phase 2's `02-11-GATE-2-evidence-*` pattern. Pre-flight checklist + 7 auto-verified rows (script-derived) + 5 human-verified sections (SC2 8/10 actionable; SC4 loadContext budget; SC5 50ms timeline; SC6 cost/call; SC7 80% hit rate) + Gate Decision sign-off block.

## Verification

- `chmod +x scripts/verify-phase-6-e2e.mjs && node scripts/verify-phase-6-e2e.mjs --mock` → **PASS (13/13)** in ~80ms; exit 0.
- `chmod +x scripts/verify-phase-6-gate.mjs && node scripts/verify-phase-6-gate.mjs --mock` → **0 FAIL, 7 PASS-auto, 5 HUMAN-pending**; exit 0 (per spec — HUMANs are operator-owned).
- Evidence template file present + parseable as markdown.
- Both scripts have shebang `#!/usr/bin/env node` + chmod +x.

## How the 7 Phase 6 SCs are verified

| SC  | Requirement | Auto-check (mock) | Auto-check (live) | HUMAN gate |
|-----|-------------|-------------------|-------------------|------------|
| SC1 | CAP-08 + AUTO-05: granola-poller every 15 min, idempotent | granola-poller handler exports + integrations-granola.ts has `rate(15 minutes)` Europe/Stockholm + agent_runs idempotency | Operator confirms `aws scheduler get-schedule` State=ENABLED + last 24h activity in agent_runs | None |
| SC2 | AGT-06: 30 transcripts → action items + mention_events; ≥8/10 actionable | agent.ts has `eu.anthropic.claude-sonnet-4-6` + tool_use; handler.ts writes CC + mention_events | agent_runs.transcript-extractor status='ok' count over 24h | **8/10 actionable** rating per Kevin's gut |
| SC3 | MEM-03: hybrid query <600ms p95 | `verify-mem-03-latency.mjs --mock` subprocess exit 0 (synthetic distribution) | `verify-mem-03-latency.mjs --live` subprocess exit 0 against live kos-memory index | None |
| SC4 | AGT-04: loadContext returns ContextBundle; <800ms p95 | loadContext + 7 helpers exported; ≥1 consumer Lambda wires loadContext + assembled_markdown | Langfuse traces show loadContext invocations | **p95 < 800ms after 1 day production traffic** |
| SC5 | MEM-04: entity_timeline_mv refreshed every 5 min; <50ms p95 at 100k | refresher handler runs REFRESH MATERIALIZED VIEW; integrations-mv-refresher.ts has `rate(5 minutes)`; migration 0012 has MV + uniq index; dashboard route present | pg_relation_size > 0 | **50ms p95 at 100k mention_events** |
| SC6 | INF-10: dossier-loader subscribes to context.full_dossier_requested; <$1.50/call | dossier-loader/vertex.ts has `gemini-2.5-pro` + `europe-west4`; handler subscribes to FullDossierRequested; integrations-vertex.ts wires the EventBridge rule | EventBridge rule present + dossier-loader Lambda deployed | **cost/call < $1.50** in Vertex billing console |
| SC7 | Dossier cache: Postgres-backed; >80% hit rate; trigger invalidation works | migration 0012 has table + trigger AFTER INSERT ON mention_events; cache.ts exports computeLastTouchHash + readDossierCache + writeDossierCache | Trigger smoke test: insert mention_event for cached entity, assert row deleted | **80% hit rate** over representative day |

## Operator handoff

After Phase 6 deployment, Kevin (or the next planner) runs:

```bash
# 1. Sanity check both scripts run mock-mode green:
node scripts/verify-phase-6-e2e.mjs --mock
node scripts/verify-phase-6-gate.mjs --mock

# 2. Live-mode verification (requires AWS creds + KEVIN_OWNER_ID + secrets populated):
AWS_REGION=eu-north-1 KEVIN_OWNER_ID=<your-uuid> \
  node scripts/verify-phase-6-gate.mjs --live

AWS_REGION=eu-north-1 KEVIN_OWNER_ID=<your-uuid> \
  PHASE6_PG_URL=<rds-proxy-url> \
  node scripts/verify-phase-6-e2e.mjs --live

# 3. Fill 06-06-GATE-evidence-template.md with the 5 HUMAN-flagged measurements:
#    - SC2: 30 transcripts × 10 action items, rate ≥ 8/10 actionable
#    - SC4: loadContext p95 from Langfuse over 24h
#    - SC5: dashboard /api/entities/[id]/timeline p95 over 50 requests
#    - SC6: $/call from Vertex billing after first invocation
#    - SC7: cache_hit % over a representative day

# 4. Commit the filled-in evidence file with the date suffix:
#    .planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-<YYYY-MM-DD>.md
```

## Bridge to Phase 7

Phase 7 (lifecycle automation — morning brief / day close per ROADMAP) **directly depends on AGT-04 + MEM-03 from Phase 6**:

- **Morning brief Lambda** (AUTO-01): calls `loadContext({ entityIds: <today's-priorities>, agentName: 'morning-brief', ... })` to inject Kevin Context + entity dossiers + Azure semantic chunks before the brief-writer Sonnet 4.6 call. ContextBundle's `assembled_markdown` becomes the third system-prompt segment with `cache_control: ephemeral`.
- **Day close Lambda** (AUTO-03): same pattern; loads context for entities mentioned today + open action items.
- **Email-triage** (Phase 4 AGT-02): once Phase 4 ships, will import `@kos/context-loader` directly to enrich email triage decisions with full entity context.

When Phase 7 plans are written, they should reference `06-CONTEXT.md` D-12..D-16 (loadContext contract) + `06-05-SUMMARY.md` (consumer wiring pattern) so the brief writers consume the helper exactly as triage / voice-capture / entity-resolver / transcript-extractor do today.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Initial `cachedContent` check on dossier-loader/vertex.ts was over-strict**
- **Found during:** First mock-run of `verify-phase-6-gate.mjs` after Task 2 was authored.
- **Issue:** Plan 06-06 spec for `verifyINF10` says: "Mock mode: assert services/dossier-loader/src/vertex.ts contains `gemini-2.5-pro` + `europe-west4`; assert handler subscribes to context.full_dossier_requested via integrations-vertex.ts." It does NOT require `cachedContent` API adoption. The first draft of the gate verifier added `cachedContent` as a hard FAIL, which broke against the actually-shipped vertex.ts (which references cached-content in the cost comment but does not yet call the API — D-21 calls for it but Plan 06-05 SUMMARY notes Vertex caching is post-first-call adoption).
- **Fix:** Downgraded the `cachedContent` check from a hard FAIL to an advisory. The presence/absence of `cachedContent` is now reported in the SC6 evidence string as `cachedContent` (when present) or `(cachedContent not yet adopted — operator may add post-first-call for cost discipline)` (when absent). Cost-per-call < $1.50 remains a HUMAN-flagged criterion that the operator owns post-deploy.
- **Files modified:** `scripts/verify-phase-6-gate.mjs` (lines around verifyINF10 — relaxed regex check, updated evidence string).
- **Commit:** included in `28dd503` (the relaxed version is what landed).

### Plan-vs-actual deviations (deliberate)

- **Soft tsx loader instead of hard requirement.** The plan-spec text doesn't explicitly mandate one or the other. We chose the soft-loader path so the scripts run on a fresh checkout (CI, one-off operator boxes) without requiring `pnpm install`. Structural source-grep fallback exercises the same shape assertions; live-Zod path runs only when tsx is hoisted. This is a Phase 2 02-11-pattern carry-forward (`scripts/verify-extractor-events.mjs` does the same).
- **Subprocess delegation for SC3.** Plan-spec says "run `verify-mem-03-latency.mjs --mock` as subprocess; assert exit code 0". Implemented via `spawnSync`. The mock-mode synthetic distribution is constructed by the existing harness to always pass; live mode reuses the same subprocess invocation with `--live`.
- **Result line format**. Plan-spec example: `"SC1 CAP-08 + AUTO-05      [PASS] granola-poller wired..."`. Implementation matches modulo spacing — used `padEnd(4)` + `padEnd(32)` for stable column alignment across 7 SCs.

## Out-of-scope discoveries

None. The verifiers explicitly avoid making any business-logic claims; they only assert the shape of what Plans 06-00 through 06-05 already shipped. Pre-existing typecheck issues from 06-00 deferred-items.md (e.g., `services/_shared/tracing.ts` missing OTel deps in some workspace package.json files) remain out of scope and were not touched.

## Threat Flags

None. Plan 06-06 is verifier-only:

- No new EventBridge buses, rules, or detail-types.
- No new database tables, columns, or queries (live-mode polls existing `agent_runs` + `mention_events` only).
- No new IAM grants, secrets, or network surfaces.
- Live-mode `PutEvents transcript.available` uses the existing `kos.capture` bus + existing `transcript.available` detail-type — same surface granola-poller emits in production.

The threat register from `<threat_model>` (T-06-E2E-01 / T-06-E2E-02 / T-06-E2E-03) retains all planned mitigations:
- T-06-E2E-01 (live triggers wrong Lambda) — mitigated: live mode requires explicit `--live` flag + `KEVIN_OWNER_ID` env; default is `--mock`; printout shows mode at top.
- T-06-E2E-02 (gate result not preserved) — mitigated: evidence template captured in repo, operator git-commits the filled version with date suffix.
- T-06-E2E-03 (test fixtures drift) — mitigated: scripts read from `@kos/contracts` + `@kos/test-fixtures` source files; if those drift, scripts break first (gate FAILs in CI).

## Self-Check: PASSED

**Files claimed created (3):**
- `scripts/verify-phase-6-e2e.mjs` — FOUND (641 lines, mode 0755, mock-mode passes 13/13)
- `scripts/verify-phase-6-gate.mjs` — FOUND (452 lines, mode 0755, mock-mode 0 FAIL / 7 PASS-auto / 5 HUMAN, exit 0)
- `.planning/phases/06-granola-semantic-memory/06-06-GATE-evidence-template.md` — FOUND (128 lines, parseable markdown)

**Commits claimed:**
- `4a285ea` (feat 06-06 e2e verifier) — FOUND in `git log --oneline -5`
- `28dd503` (feat 06-06 gate verifier + evidence template) — FOUND in `git log --oneline -5`

**must_haves.artifacts min_lines checks:**
- `scripts/verify-phase-6-e2e.mjs` 641 ≥ 150 ✓
- `scripts/verify-phase-6-gate.mjs` 452 ≥ 200 ✓
- `06-06-GATE-evidence-template.md` 128 ≥ 60 ✓

**must_haves.key_links pattern checks (verifier semantics):**
- e2e harness → all Phase 6 services via synthetic transcript.available emit + downstream-effect assertions: ✓ (live mode emits transcript.available; assertions cover transcript-extractor / mention_events / cache trigger / entity_timeline MV)
- gate verifier → 7 SCs from ROADMAP via per-SC check function: ✓ (verifyCAP08AUTO05 / verifyAGT06 / verifyMEM03 / verifyAGT04 / verifyMEM04 / verifyINF10 / verifyDossierCache)

All claims verified. SUMMARY ready for orchestrator merge.
