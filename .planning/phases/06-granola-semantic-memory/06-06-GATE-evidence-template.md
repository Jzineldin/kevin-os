---
phase: 06-granola-semantic-memory
gate: phase-6-completion
status: PENDING
created: 2026-04-24
operator: Kevin El-zarka
completed:
---

# Phase 6 Gate Evidence

> Filled by operator after running `node scripts/verify-phase-6-gate.mjs --live`
> AND completing all HUMAN-flagged checks below. Mirrors the Phase 2
> 02-11-GATE-2-evidence-* pattern.

## Pre-flight

- [ ] Worktree merged to main; CDK stacks deployed (KosCapture / KosAgents
      / KosIntegrations / KosObservability) at the Phase 6 commit.
- [ ] Notion `Transkripten` DB id is in `scripts/.notion-db-ids.json`.
- [ ] Secrets populated: `kos/notion-token`, `kos/cohere-bedrock-region`,
      `kos/azure-search-admin`, `kos/gcp-vertex-sa` (real values, not placeholders).
- [ ] `node scripts/verify-phase-6-gate.mjs --live` exited 0.
- [ ] `node scripts/verify-phase-6-e2e.mjs --live` exited 0.

## Auto-Verified (script exit 0)

The gate verifier produces these PASS lines automatically; operator
just confirms the run was actually live (not mock).

- [ ] **SC1 CAP-08 + AUTO-05** — `granola-poller` schedule `rate(15 minutes)`
      Europe/Stockholm; `agent_runs` shows status='ok' rows for `agent_name='granola-poller'`
      within last 24h.
  - Live evidence: ___ rows in last 24h
- [ ] **SC2 AGT-06 (code)** — `transcript-extractor` Lambda deployed; Sonnet 4.6
      with Bedrock `tool_use`; CC + mention_events writes confirmed.
  - Live evidence: agent_runs.transcript-extractor status='ok' count over 24h: ___
- [ ] **SC3 MEM-03** — `verify-mem-03-latency.mjs --live`
  - p95: ___ ms (< 600 PASS)
  - p50: ___ ms
  - Index: kos-memory; semantic config: kos-semantic
- [ ] **SC4 AGT-04 (code)** — `@kos/context-loader` integrated into N
      consumer Lambdas (auto-detected; current count: ___).
- [ ] **SC5 MEM-04 (code)** — `entity_timeline` MV exists; `rate(5 minutes)`
      refresh schedule live; dashboard `/api/entities/[id]/timeline` route present.
- [ ] **SC6 INF-10 (code)** — `dossier-loader` Lambda + EventBridge rule
      on `context.full_dossier_requested` deployed.
- [ ] **SC7 Dossier cache (code)** — migration 0012 trigger
      `trg_entity_dossiers_cached_invalidate` AFTER INSERT ON mention_events
      live; `cache.ts` exports verified.

## Human-Verified (operator action required)

These are NOT failures of the auto gate — they're subjective measurements
the operator owns post-deploy. Phase 6 is "complete" when each row is
filled in here.

### SC2 AGT-06 — 8/10 actionable acceptance

- Date reviewed: ___
- Transcripts reviewed (Notion page IDs or titles): ___
  1. ___
  2. ___
  3. ___
  4. ___
  5. ___
  6. ___
  7. ___
  8. ___
  9. ___
  10. ___
- Action items rated actionable (Kevin's gut): ___ / 10
- Result: PASS (≥8) / FAIL (<8)
- Notes (which 2 weakest items + why):

### SC4 AGT-04 — loadContext budget

- Day measured: ___
- Langfuse query: traces filtered by attribute `agentName='loadContext'`
  over 24h (or query `assembled_markdown` span length).
- p95 elapsedMs: ___ ms (< 800 PASS)
- p50 elapsedMs: ___ ms
- cache_hit rate: ___ % (target > 80% per SC7; surfaces here too because
  loadContext speed is dominated by cache-hit ratio)
- Notes (which subfetches dominated p95):

### SC5 MEM-04 — timeline 50ms p95 at 100k rows

- mention_events row count at measurement: ___
- Dashboard `/api/entities/<entity_id>/timeline` p95 over 50 requests: ___ ms
  (< 50 PASS)
- p50: ___ ms
- Notes (entity_id used for measurement; whether it's a hot or cold entity):

### SC6 INF-10 — cost per Vertex call < $1.50

- First operator-trigger date: ___
- Cached prefix size (Kevin Context + entity dossier base block): ___ tokens
- Live invocation cost (Vertex billing console for that call): $___
- Result: PASS (<$1.50) / FAIL (≥$1.50)
- Notes (cachedContent reuse evidence — was the second call meaningfully cheaper?):

### SC7 Dossier cache 80% hit rate

- Day measured: ___
- cache_hit rate from Langfuse traces (`bundle.cache_hit=true` / total): ___ %
- Total loadContext calls in window: ___
- Result: PASS (>80%) / FAIL (≤80%)
- Trigger smoke test: insert one mention_event for an entity with a cached
  dossier, then SELECT FROM entity_dossiers_cached WHERE entity_id = ___ — assert empty.
  - Result: PASS / FAIL

## Gate Decision

Phase 6 status: __ COMPLETE / __ INCOMPLETE

If INCOMPLETE, list specifically which SC rows are blocking + the next plan
that addresses each:

- SC___:
- SC___:

If COMPLETE: Phase 6 deliverables (CAP-08, AGT-04, AGT-06, MEM-03, MEM-04,
AUTO-05, INF-10) are now consumable by Phase 7 (lifecycle automation —
morning brief / day close consume `loadContext` per ROADMAP).

Operator signature: ___________________
Date: ___________________
