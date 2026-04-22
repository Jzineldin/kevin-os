---
phase: 01
slug: infrastructure-foundation
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-22
updated: 2026-04-22
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> See `01-RESEARCH.md` §"Validation Architecture" for the authoritative Gate-1 verification matrix.
> Updated 2026-04-22 with final task IDs after `/gsd-plan-phase` completed.
> **Revision 2026-04-22b:** Re-waved per checker BLOCKER #1 (Plan 02 → W2, Plans 04/05/06 → W3, Plan 07 → W4, Plan 08 → W5) so `wave = max(deps.wave) + 1` holds. Task IDs unchanged; only the Wave column moved.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (unit) + AWS CLI / Node CLI assertions (integration) |
| **Config file** | `packages/*/vitest.config.ts`, `services/*/vitest.config.ts` — installed in Wave 0 (Plan 00) and per-package as plans land |
| **Quick run command** | `pnpm -w test -- --run` |
| **Full suite command** | `pnpm -w test -- --run && pnpm run verify:gate-1` |
| **Estimated runtime** | ~60-90 s quick / ~8-12 min full (includes `cdk synth` + live AWS/Azure/Notion assertions) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -w test -- --run` (affected packages only when possible via `pnpm --filter`)
- **After every plan wave:** Run `pnpm -w test -- --run && (cd packages/cdk && npx cdk diff)`
- **Before `/gsd-verify-work`:** `pnpm run verify:gate-1` must be green
- **Max feedback latency:** ≤120 s (unit) / ≤12 min (integration + Gate 1)

---

## Per-Task Verification Map

Task IDs finalized per plan. Every task has an `<automated>` verify OR a direct dependency on a Wave 0 task that installs the missing framework.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-00-01 | 00 | 0 | INF-01 | — | Monorepo scaffold | unit | `node --version && pnpm install --frozen-lockfile=false && test -f tsconfig.base.json` | ✅ W0 | ⬜ pending |
| 01-00-02 | 00 | 0 | INF-01 | T-01-SUPPLY-01 | CDK skeleton synth clean (empty app) | unit | `cd packages/cdk && npx cdk synth --quiet && pnpm --filter @kos/cdk test -- --run` | ✅ W0 | ⬜ pending |
| 01-00-03 | 00 | 0 | INF-01 | — | Drizzle + contracts packages typecheck | unit | `pnpm --filter @kos/db typecheck && pnpm --filter @kos/contracts typecheck` | ✅ W0 | ⬜ pending |
| 01-00-04 | 00 | 0 | INF-08 | — | Transcribe sv-SE region resolved (A9) + CDK bootstrap complete | integration | `bash scripts/preflight.sh` | ✅ W0 | ⬜ pending |
| 01-01-01 | 01 | 1 | INF-01 | T-01-01 | KosLambda Node 22 ARM64 + externalized @aws-sdk/* defaults | unit | `pnpm --filter @kos/cdk test -- --run kos-lambda` | ✅ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | INF-01, INF-03 | T-01-01 | NetworkStack synth clean, zero NAT, one S3 Gateway Endpoint, 2 AZs | unit+integration | `cd packages/cdk && npx cdk synth KosNetwork --quiet && pnpm --filter @kos/cdk test -- --run network-stack` | ✅ W0 | ⬜ pending |
| 01-02-01 | 02 | 2 | INF-02, ENT-01, ENT-02 | — | Drizzle schema 7 tables, every table has owner_id, pgvector migrations | unit | `pnpm --filter @kos/db test -- --run && grep -c "ownerId()," packages/db/src/schema.ts` (>=7) | ✅ W0 | ⬜ pending |
| 01-02-02 | 02 | 2 | INF-02, INF-07 | T-01-02, T-01-S3-01 | DataStack RDS 16.5 + blobs bucket VPCe-scoped + 4 Secrets Manager placeholders | unit+integration | `cd packages/cdk && npx cdk synth KosData --quiet && pnpm --filter @kos/cdk test -- --run data-stack` | ✅ W0 | ⬜ pending |
| 01-02-03 | 02 | 2 | INF-02 | T-01-PGVEC-01, T-01-BASTION-01 | **[BLOCKING]** BastionHost + SSM tunnel; drizzle push applies 0001 + 0002; pgvector 0.8.0 loaded; **8 tables** (7 original + kevin_context) + HNSW index live | integration | `KOS_DB_TUNNEL_PORT=15432 bash scripts/db-push.sh` | ✅ W0 | ⬜ pending |
| 01-03-01 | 03 | 1 | INF-04 | T-01-03 | KosBus: bus + 14-day DLQ + same-account PutEvents policy | unit | `pnpm --filter @kos/cdk typecheck` | ✅ W0 | ⬜ pending |
| 01-03-02 | 03 | 1 | INF-04, INF-05 | T-01-03 | EventsStack: 5 kos.* buses + 5 DLQs + kos-schedules Scheduler group | unit+integration | `cd packages/cdk && npx cdk synth KosEvents --quiet && pnpm --filter @kos/cdk test -- --run events-stack && aws events list-event-buses --region eu-north-1 --query "EventBuses[?starts_with(Name,'kos.')] | length(@)"` | ✅ W0 | ⬜ pending |
| 01-04-01 | 04 | 3 | ENT-01, ENT-02, MEM-02 | T-01-04 | 4 Notion DBs created + Kevin Context page seeded; idempotent re-run | integration | `node scripts/bootstrap-notion-dbs.mjs && node scripts/bootstrap-notion-dbs.mjs` (second run no-op) | ✅ W0 | ⬜ pending |
| 01-04-02 | 04 | 3 | MEM-01, MEM-02 | T-01-04, T-01-04b, T-01-INDEX-01, T-01-INDEX-02 | notion-indexer + backfill unit-tested: overlap + idempotency + archive-not-delete helper + cursor rules + kevin_context population for MEM-02 prompt-cache readiness | unit | `pnpm --filter @kos/service-notion-indexer test -- --run` | ✅ W0 | ⬜ pending |
| 01-04-03 | 04 | 3 | MEM-01, ENT-01, ENT-02 | T-01-PROXY-01, T-01-INDEX-02 | IntegrationsStack + RDS Proxy (IAM auth via @aws-sdk/rds-signer) + **4 Scheduler entries (D-11: Entities/Projects/KevinContext/CommandCenter)** + weekly notion-reconcile (Sun 04:00 Stockholm) deployed; round-trip + backfill idempotency green | integration | `cd packages/cdk && npx cdk synth KosIntegrations --quiet && node scripts/verify-indexer-roundtrip.mjs && bash scripts/backfill-notion.sh` | ✅ W0 | ⬜ pending |
| 01-05-01 | 05 | 3 | INF-09 | T-01-05 | Azure AI Search service provisioned + index schema test asserts binaryQuantization | unit | `bash scripts/provision-azure-search.sh && pnpm --filter @kos/service-azure-search-bootstrap test -- --run` | ✅ W0 | ⬜ pending |
| 01-05-02 | 05 | 3 | INF-09, MEM-02 | T-01-AZ-01, T-01-AZ-02 | CustomResource PUTs index; live index has binary quantization + preserveOriginals + semantic config | integration | `cd packages/cdk && npx cdk synth KosIntegrations --quiet && pnpm --filter @kos/cdk test -- --run integrations-stack-azure && node scripts/verify-azure-index.mjs` | ✅ W0 | ⬜ pending |
| 01-06-01 | 06 | 3 | INF-08 | T-01-VOCAB-01 | Seed vocab file phrase-only + deploy Lambda unit-tested for sv-SE and archive-not-delete | unit | `pnpm --filter @kos/service-transcribe-vocab-deploy test -- --run && grep -q "Tale-Forge" vocab/sv-se-v1.txt` | ✅ W0 | ⬜ pending |
| 01-06-02 | 06 | 3 | INF-08 | T-01-VOCAB-03 | CustomResource creates vocabulary; state READY within 5 min | integration | `cd packages/cdk && npx cdk synth KosIntegrations --quiet && pnpm --filter @kos/cdk test -- --run integrations-stack-vocab && bash scripts/verify-transcribe-vocab.sh` | ✅ W0 | ⬜ pending |
| 01-07-01 | 07 | 4 | INF-05 | T-01-06, T-01-CAP-01 | push-telegram cap+quiet-hours unit tests including DST coverage | unit | `pnpm --filter @kos/service-push-telegram test -- --run` | ✅ W0 | ⬜ pending |
| 01-07-02 | 07 | 4 | INF-05, INF-09 | T-01-BUDGET-01 | SafetyStack: DynamoDB cap + push-telegram + Budgets $50/$100 + SNS | unit+integration | `cd packages/cdk && npx cdk synth KosSafety --quiet && pnpm --filter @kos/cdk test -- --run safety-stack && node scripts/verify-cap.mjs` (active hours only) | ✅ W0 | ⬜ pending |
| 01-07-03 | 07 | 4 | MIG-04 | T-01-07, T-01-VPS-01 | VPS scripts patched; deploy-vps-freeze.sh applies; Legacy Inbox receives initial writes, Command Center quiet on initial check AND 48h observation | integration | `bash scripts/deploy-vps-freeze.sh && node scripts/verify-vps-freeze.mjs && (sleep 172800 && node scripts/verify-vps-freeze-48h.mjs)` [48h gate run separately at Gate 1 crossover] | ✅ W0 | ⬜ pending |
| 01-08-01 | 08 | 5 | INF-06 | — | Fargate ARM64 cluster `kos-cluster` deployed; owner-id sweep enforces forward-compat | unit+integration | `pnpm --filter @kos/cdk test -- --run cluster && pnpm --filter @kos/db test -- --run owner-sweep && aws ecs describe-clusters --clusters kos-cluster --region eu-north-1 --query "clusters[0].status"` | ✅ W0 | ⬜ pending |
| 01-08-02 | 08 | 5 | INF-05, INF-06 | T-01-GATE-01, T-01-GATE-02, T-01-FWDCOMPAT-01 | Master Gate 1 verifier: DB live check mandatory (auto-fetch DATABASE_URL from Secrets Manager); NOTION_TOKEN auto-fetch; 48h VPS freeze verifier chained; weekly notion-reconcile schedule assertion | integration | `pnpm run verify:gate-1` | ✅ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements (all delivered in Plan 00 or per-plan Wave 2 tasks)

- [x] `packages/cdk/package.json` + `vitest.config.ts` — Plan 00 Task 1
- [x] `packages/db/package.json` + `vitest.config.ts` — Plan 00 Task 2
- [x] `packages/contracts/package.json` — Plan 00 Task 2
- [x] `services/notion-indexer/package.json` + `vitest.config.ts` — Plan 04 Task 2 (services package scaffold self-contained)
- [x] `services/push-telegram/package.json` + `vitest.config.ts` — Plan 07 Task 1
- [x] `services/azure-search-bootstrap/package.json` — Plan 05 Task 1
- [x] `services/transcribe-vocab-deploy/package.json` — Plan 06 Task 1
- [x] `scripts/verify-gate-1.mjs` — Plan 08 Task 2
- [x] `scripts/verify-indexer-roundtrip.mjs` — Plan 04 Task 3
- [x] `scripts/verify-azure-index.mjs` — Plan 05 Task 2
- [x] `scripts/verify-cap.mjs` — Plan 07 Task 2
- [x] `scripts/verify-vps-freeze.mjs` — Plan 07 Task 3
- [x] `scripts/verify-transcribe-vocab.sh` — Plan 06 Task 1
- [x] `scripts/verify-stacks-exist.sh` — Plan 08 Task 2
- [x] `scripts/preflight.sh` — Plan 00 Task 3 (resolves A9)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SNS email subscription confirmed | INF-05 (cost alarms) | AWS sends confirmation email; user must click link — cannot auto-confirm from CDK | 1. Run `cdk deploy KosSafety`. 2. Check `kevin@tale-forge.app` inbox. 3. Click "Confirm subscription" link. 4. `aws sns list-subscriptions-by-topic --topic-arn <arn>` — status must be `Confirmed`. `verify-gate-1` step 6/9 asserts no PendingConfirmation remains. |
| Cost alarm fires at threshold | INF-09 | Requires real billing activity; cannot simulate without incurring cost | Defer to first organic spend event; plan produces the Budgets resource + runbook entry. |
| Kevin Context page seeded correctly | MEM-02 | Visual check that section template matches | Open Notion Kevin Context page; confirm 6 `heading_2` blocks exist with expected text. |
| VPS freeze 48h observation | MIG-04 | Dual-writes from patched scripts must be absent from Command Center / Kontakter / Daily Brief Log for 48 h | After deploy: monitor Command Center Notion DB for 48 h via `curl /v1/databases/$CC/query`; expect zero new rows from classify_and_save/morning_briefing/evening_checkin. |
| Cap enforcement during active hours | INF-05 | `verify-cap.mjs` only meaningful 08:00-20:00 Stockholm (quiet hours pre-empt) | Schedule the Gate 1 run during Stockholm business hours; `verify-gate-1.mjs` auto-skips with `[SKIP]` outside window. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (verified above)
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags in CI
- [x] Feedback latency < 120 s (unit) / < 12 min (integration)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned (ready for `/gsd-execute-phase 1`).
