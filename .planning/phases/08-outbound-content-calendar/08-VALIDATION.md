# Phase 8 — VALIDATION

**Created:** 2026-04-24
**Mode:** Nyquist per-task verify matrix — every task has an `<automated>` verify command OR a `MISSING — Wave 0 must create <file>` marker.

---

## Coverage Gate

| Plan | Tasks | TDD Tasks | Automated Verifies | MISSING Markers |
|------|------:|----------:|-------------------:|----------------:|
| 08-00 scaffold | 5 | 1 | 5 | 0 |
| 08-01 calendar-reader | 3 | 2 | 3 | 0 |
| 08-02 content-writer + Step Functions | 3 | 2 | 3 | 0 |
| 08-03 publisher + Postiz + dashboard routes | 3 | 2 | 3 | 0 |
| 08-04 mutation-proposer + mutation-executor | 3 | 2 | 3 | 0 |
| 08-05 document-diff | 2 | 1 | 2 | 0 |
| 08-06 Gate verifiers | 2 | 0 | 2 | 0 |
| **TOTAL** | **21** | **10** | **21** | **0** |

All 21 tasks across 7 plans have an automated verify command. Wave 0 (08-00) provides ALL test fixtures and Zod schemas downstream plans require, so no plan has a MISSING marker.

---

## Per-Task Verify Matrix

### 08-00 — Wave 0 scaffold

| Task | Verify |
|------|--------|
| T1 Scaffold 6 service workspaces | `test -f services/content-writer/package.json && test -f services/content-writer-platform/package.json && test -f services/publisher/package.json && test -f services/mutation-proposer/package.json && test -f services/mutation-executor/package.json && test -f services/calendar-reader/package.json && test -f services/document-diff/package.json && node -e "const p = require('./services/content-writer/package.json'); if (p.name !== '@kos/service-content-writer' || p.type !== 'module') process.exit(1); console.log('OK');"` |
| T2 @kos/contracts Phase 8 schemas | `pnpm --filter @kos/contracts test -- --run 2>&1 \| tail -15` |
| T3 Migration 0015 with 5 tables | `ls packages/db/drizzle/ \| grep -E "^00(15\|16)_phase_8" && node scripts/validate-migration-syntax.mjs packages/db/drizzle/$(ls packages/db/drizzle \| grep -E "^00(15\|16)_phase_8" \| head -1)` |
| T4 Postiz Fargate skeleton + EFS | `pnpm --filter @kos/cdk typecheck 2>&1 \| tail -5` |
| T5 BRAND_VOICE.md seed + test fixtures | `test -f .planning/brand/BRAND_VOICE.md && node -e "const f = require('fs').readFileSync('.planning/brand/BRAND_VOICE.md', 'utf8'); if (!f.includes('human_verification: false')) process.exit(1); if (!f.includes('## Instagram')) process.exit(1); console.log('OK');" && test -f packages/test-fixtures/src/imperative-mutations.ts` |

### 08-01 — services/calendar-reader (CAP-09)

| Task | Verify |
|------|--------|
| T1 OAuth token refresh + events fetch | `pnpm --filter @kos/service-calendar-reader test -- --run oauth events-fetch 2>&1 \| tail -20` |
| T2 calendar_events_cache upsert + loadContext extension | `pnpm --filter @kos/service-calendar-reader test -- --run cache-upsert 2>&1 \| tail -10 && pnpm --filter @kos/context-loader test -- --run includeCalendar 2>&1 \| tail -10` |
| T3 CDK integrations-calendar.ts + schedule | `pnpm --filter @kos/cdk test -- --run integrations-calendar --reporter=basic 2>&1 \| tail -15` |

### 08-02 — services/content-writer + Step Functions (AGT-07)

| Task | Verify |
|------|--------|
| T1 content-writer orchestrator Lambda | `pnpm --filter @kos/service-content-writer test -- --run handler orchestrate 2>&1 \| tail -20` |
| T2 content-writer-platform per-platform worker | `pnpm --filter @kos/service-content-writer-platform test -- --run 2>&1 \| tail -25` |
| T3 CDK Step Functions state machine + content_drafts write | `pnpm --filter @kos/cdk test -- --run integrations-content --reporter=basic 2>&1 \| tail -20` |

### 08-03 — services/publisher + Postiz Fargate + dashboard routes (AGT-08)

| Task | Verify |
|------|--------|
| T1 publisher Lambda + postizMcpCall helper | `pnpm --filter @kos/service-publisher test -- --run 2>&1 \| tail -20` |
| T2 dashboard /api/content-drafts/:id/{approve,edit,skip} + cancel | `pnpm --filter @kos/service-dashboard-api test -- --run content-drafts 2>&1 \| tail -15 && pnpm --filter @kos/dashboard test -- --run content-drafts-route 2>&1 \| tail -10` |
| T3 Postiz Fargate service + CDK IAM safety tests | `pnpm --filter @kos/cdk test -- --run integrations-postiz --reporter=basic 2>&1 \| tail -25` |

### 08-04 — services/mutation-proposer + mutation-executor (SC 6)

| Task | Verify |
|------|--------|
| T1 mutation-proposer — regex + Haiku + Sonnet 3-stage | `pnpm --filter @kos/service-mutation-proposer test -- --run regex haiku sonnet-decide 2>&1 \| tail -25` |
| T2 mutation-executor — Approve-gated execution (archive-not-delete) | `pnpm --filter @kos/service-mutation-executor test -- --run 2>&1 \| tail -20` |
| T3 Dashboard /api/pending-mutations/:id/{approve,skip} + CDK | `pnpm --filter @kos/service-dashboard-api test -- --run pending-mutations 2>&1 \| tail -10 && pnpm --filter @kos/cdk test -- --run integrations-mutations --reporter=basic 2>&1 \| tail -15` |

### 08-05 — services/document-diff (MEM-05)

| Task | Verify |
|------|--------|
| T1 document-diff Lambda — SHA + extract + Haiku diff | `pnpm --filter @kos/service-document-diff test -- --run 2>&1 \| tail -25` |
| T2 CDK hook on email.sent + entity-timeline view surface | `pnpm --filter @kos/cdk test -- --run integrations-document-diff --reporter=basic 2>&1 \| tail -15` |

### 08-06 — Gate verifier

| Task | Verify |
|------|--------|
| T1 scripts/verify-phase-8-e2e.mjs (all 7 SCs) | `node --check scripts/verify-phase-8-e2e.mjs && echo "e2e-script-OK"` |
| T2 scripts/verify-approve-gate-invariant.mjs + prompt-injection test + rollback test | `node --check scripts/verify-approve-gate-invariant.mjs && node --check scripts/verify-prompt-injection-content-writer.mjs && node --check scripts/verify-mutation-rollback.mjs && echo "gate-scripts-OK"` |

---

## Manual Operator Verifies (execute-phase only — NOT blocking plan-phase sign-off)

| Item | When |
|------|------|
| Google Calendar OAuth consent screen for both accounts | Before Plan 08-01 executes |
| Postiz container first-boot → generate API key → seed Secrets Manager | After Plan 08-03 Fargate deploy |
| Postiz per-platform OAuth (IG/LinkedIn/TikTok/Reddit/newsletter) via Postiz UI | After Plan 08-03 deploys |
| BRAND_VOICE.md `human_verification: true` flip by Kevin | Before first real content-writer draft |
| 7-day Postiz idle restart test (EFS persistence verification) | Post-deploy operational check |
| document-diff e2e with real Damien avtal v3 → v4 | Manual test; not in automated Gate |

---

## Nyquist Notes

- Every `<verify>` tag in every PLAN has an `<automated>` child.
- No `<verify>` tag relies on human observation for pass/fail.
- CDK tests run against `cdk synth` output; no live cloud calls.
- Agent Lambda tests mock AnthropicBedrock client.
- Postiz MCP tests mock `fetch` to return canned JSON-RPC responses.
- Google Calendar API tests mock fetch to return canned events.list JSON.
- pdf-parse / mammoth tested against small fixture files committed to `packages/test-fixtures/fixtures/`.

---

## Phase 8 Success Criteria Traceability

| ROADMAP SC | Verified by |
|------------|-------------|
| SC 1 (5-platform drafts + Step Functions) | 08-02 Tasks 1+2+3 + 08-06 T1 |
| SC 2 (publisher + Postiz MCP + cancel-before-publish + IAM split) | 08-03 all tasks + 08-06 T2 (Approve-gate invariant) |
| SC 3 (Google Calendar both accounts in morning brief + entity context) | 08-01 all tasks + 08-06 T1 |
| SC 4 (document version tracker with SHA + diff_summary) | 08-05 both tasks + 08-06 T1 |
| SC 5 (Approve gate non-bypassable) | 08-03 T3 IAM safety + 08-04 T3 IAM safety + 08-06 T2 |
| SC 6 (imperative-verb mutation pathway) | 08-04 all tasks + 08-06 T2 (rollback test) |
| SC 7 (Postiz Fargate deployment) | 08-03 T3 + CDK safety tests + 08-06 T1 |

All 7 ROADMAP SCs covered by at least one automated verify.

---

*Validation matrix finalised 2026-04-24.*
