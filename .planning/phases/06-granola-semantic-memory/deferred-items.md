# Phase 6 — Deferred Items

**Created:** 2026-04-24

Items considered during Phase 6 planning but deliberately deferred. Each carries a trigger condition for revisit.

---

## Deferred to later phases

| Item | Source | Deferred to | Trigger to revisit |
|------|--------|-------------|--------------------|
| Granola REST API integration | CONTEXT D-01 | (no specific phase) | Only if Notion Transkripten polling lag becomes intolerable for Kevin's workflow |
| ElastiCache Serverless dossier cache | CONTEXT D-17 | (no specific phase) | If Postgres cache hit rate < 50% in production OR if RDS CPU from cache reads exceeds 5% of total |
| Per-content-type Azure indexes (one index per source) | CONTEXT D-10 | (no specific phase) | If Azure write contention or schema divergence demands it |
| Real-time MV refresh via LISTEN/NOTIFY trigger | CONTEXT specifics | Phase 7+ | If dashboard freshness becomes the bottleneck despite the 5-min cron + 10-min live overlay |
| Cross-region Vertex failover | CONTEXT D-21 | Phase 9+ | If GCP region outage reaches Kevin's daily workflow |
| Auto-trigger Gemini full-dossier (when last cache > 7 days) | CONTEXT D-22 | Phase 7 (during weekly review) | When operator-trigger volume exceeds 5/day; auto-trigger amortises cost |
| Action-item urgent/not-urgent triage on Granola extracts | CONTEXT specifics | Phase 7 (lifecycle automation) | Urgency classification is Phase 7's territory; Phase 6 lands all action items as `Att göra` |
| Per-attendee resolution in transcript-extractor (use attendees as entityIds for context-loader) | Plan 06-05 Task 2 | (no specific phase) | When transcript-extractor gets >5 mentions/transcript average and pre-resolution becomes a quality multiplier |
| Custom Azure index schema fields (`transcript_title`, `recorded_at` searchable) | Plan 06-03 | If retrieval relevance suffers | Operator can extend the schema via the existing schema-fingerprint mechanism without a new plan |
| MEM-05 document version tracker | Phase 8 | Phase 8 (already mapped in REQUIREMENTS.md) | n/a — already scoped |
| Granola backfill of >90 days | Plan 06-01 | (no specific phase) | ENT-06 (Phase 2) handled the 90-day backfill into KOS Inbox; re-run ENT-06 is the backfill story |

## Deferred operator runbook items (NOT code, NOT planning gaps)

These are Kevin/operator actions that Phase 6 cannot perform from code:

| Action | When | How |
|--------|------|-----|
| Create GCP project + enable Vertex AI europe-west4 | Before Plan 06-05 deploy | Manual in GCP Console |
| Create Vertex AI service account with `roles/aiplatform.user` | Before Plan 06-05 deploy | Manual in GCP Console |
| Download SA JSON + put into Secrets Manager `kos/gcp-vertex-sa` | Before Plan 06-05 deploy | `aws secretsmanager put-secret-value --secret-id kos/gcp-vertex-sa --secret-string @sa.json` |
| Discover Notion Transkripten DB ID | Before Plan 06-01 deploy | `node scripts/discover-notion-dbs.mjs --db transkripten` |
| Update notion_indexer_cursor.db_id from PLACEHOLDER to real ID | After Plan 06-01 deploy | `psql -c "UPDATE notion_indexer_cursor SET db_id='<id>' WHERE db_kind='transkripten';"` |
| Optional: extend Azure index schema with new fields | Only if retrieval quality suffers | Edit `services/azure-search-bootstrap/src/index-schema.ts`; `cdk deploy KosIntegrations` |
| Live MEM-03 latency check | After Plan 06-03 deploy | `node scripts/verify-mem-03-latency.mjs --live` |
| First Vertex Gemini test invocation | After Plan 06-05 deploy | `node scripts/trigger-full-dossier.mjs --entity-id <real-uuid>` |
| Phase 6 gate sign-off | After all 7 plans complete | Run `node scripts/verify-phase-6-gate.mjs --live`; fill in `06-06-GATE-evidence-template.md`; commit signed evidence |
| Kevin's gut review of 10 action items (AGT-06 SC2) | After 30 transcripts processed | Kevin reads 10 randomly-selected extracted Command Center rows; rates ≥8/10 actionable |

---

## Out-of-scope discoveries during Plan 06-00 execution (logged 2026-04-24)

Pre-existing typecheck failures noticed while running verification, NOT
caused by Plan 06-00 changes (out of scope per execute-plan.md scope
boundary):

| File | Issue | Owner |
|------|-------|-------|
| `services/_shared/tracing.ts` | Imports 5 OpenTelemetry/Langfuse modules that aren't declared as deps in azure-search-indexer-* / dossier-loader / entity-timeline-refresher service package.json files; typecheck fails with TS2307 in those workspaces. Tests still pass because vitest doesn't follow the import. | Phase 6 wave-3 sweep / Plan 06-03 |
| `packages/azure-search/src/client.ts` lines 26 + 32 | TS2344 — `Type 'T' does not satisfy the constraint 'object'` and `Type 'unknown' does not satisfy the constraint 'object'`. Pre-existing on the branch. | Plan 06-03 / Plan 06-05 |
| `services/azure-search-indexer-entities/src/handler.ts:51` | `Type 'Date \| null' is not assignable to type 'string \| null'` — cursor type mismatch between common.ts (returns Date) and the writeCursor/handler signatures. | Plan 06-03 |
| `apps/dashboard/tests/unit/dashboard-api.test.ts` (4 tests) | Pre-existing failures: `KOS_DASHBOARD_BEARER_TOKEN not set on runtime`. Tests need env-var mock setup. | Phase 3 / dashboard test fixture work |

These items are tracked here so the next execution wave or a quick task
can address them in scope. Plan 06-00 deliberately did NOT touch them.

*Deferred items log: 2026-04-24*
