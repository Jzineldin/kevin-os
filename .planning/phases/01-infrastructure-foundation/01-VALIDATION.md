---
phase: 01
slug: infrastructure-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-22
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> See `01-RESEARCH.md` §"Validation Architecture" for the authoritative Gate-1 verification matrix.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 1.x (unit) + AWS CLI / Node CLI assertions (integration) |
| **Config file** | `packages/*/vitest.config.ts` — Wave 0 installs per-package |
| **Quick run command** | `pnpm -w test -- --run` |
| **Full suite command** | `pnpm -w test -- --run && pnpm -w verify:gate-1` |
| **Estimated runtime** | ~90 seconds quick / ~8 minutes full (includes `cdk synth` + live AWS assertions) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -w test -- --run` (affected packages only when possible)
- **After every plan wave:** Run `pnpm -w test -- --run && cdk synth --quiet`
- **Before `/gsd-verify-work`:** Full suite + `pnpm -w verify:gate-1` must be green
- **Max feedback latency:** 120 seconds (unit) / 8 minutes (integration + Gate 1)

---

## Per-Task Verification Map

This table is provisional and will be finalized as the planner assigns task IDs. The planner MUST update this file with one row per task and keep `acceptance_criteria` grep-verifiable.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-00-01 | 00 | 0 | INF-01 | — | Repo scaffold present | unit | `test -f package.json && test -d packages/cdk` | ❌ W0 | ⬜ pending |
| 01-00-02 | 00 | 0 | INF-08 | — | Transcribe sv-SE region confirmed | integration | `aws transcribe list-vocabularies --region eu-north-1` | ❌ W0 | ⬜ pending |
| 01-01-XX | 01 | 1 | INF-01, INF-03 | T-01-01 | NetworkStack synth clean, S3 GW endpoint only, no NAT | integration | `cdk synth NetworkStack --quiet && grep -q aws-cdk-lib.aws_ec2.GatewayVpcEndpoint cdk.out/NetworkStack.template.json` | ❌ W0 | ⬜ pending |
| 01-02-XX | 02 | 1 | INF-02, INF-07 | T-01-02 | DataStack: RDS 16.5 + pgvector + S3 RETAIN + Secrets placeholders | integration | `aws rds describe-db-instances --query "DBInstances[?DBName=='kos'].EngineVersion" && psql $DB_URL -c "SELECT extversion FROM pg_extension WHERE extname='vector'"` | ❌ W0 | ⬜ pending |
| 01-03-XX | 03 | 1 | INF-04 | T-01-03 | EventsStack: 5 kos.* buses + DLQs + Scheduler (Stockholm tz) | integration | `aws events list-event-buses --query "EventBuses[?starts_with(Name,'kos.')].Name" ` | ❌ W0 | ⬜ pending |
| 01-04-XX | 04 | 2 | ENT-01, ENT-02, MEM-01 | T-01-04 | notion-indexer Lambda idempotent, 2-min overlap, rejects hard-deletes | integration | `node scripts/verify-indexer-roundtrip.mjs` | ❌ W0 | ⬜ pending |
| 01-05-XX | 05 | 2 | MEM-02 | T-01-05 | Azure AI Search index created WITH binary quantization | integration | `node scripts/verify-azure-index.mjs` (asserts `vectorSearch.compressions[0].kind == 'binaryQuantization'`) | ❌ W0 | ⬜ pending |
| 01-06-XX | 06 | 2 | INF-08 | — | Transcribe sv-SE custom vocab deployed (state=READY) | integration | `aws transcribe get-vocabulary --vocabulary-name kos-sv-se-v1 --query VocabularyState` | ❌ W0 | ⬜ pending |
| 01-07-XX | 07 | 2 | INF-05, INF-09, MIG-04 | T-01-06, T-01-07 | SafetyStack: DynamoDB cap + quiet hours + Budgets + VPS freeze redirect | integration | `node scripts/verify-cap.mjs` + `node scripts/verify-vps-freeze.mjs` | ❌ W0 | ⬜ pending |
| 01-08-XX | 08 | 3 | INF-06 | — | Gate 1 verification script: all 9 criteria pass | integration | `pnpm -w verify:gate-1` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/cdk/package.json` — CDK TypeScript app with vitest configured
- [ ] `packages/db/package.json` — Drizzle schema + migrations + vitest
- [ ] `packages/lambdas/notion-indexer/package.json` — with vitest + @notionhq/client mock fixtures
- [ ] `packages/lambdas/push-telegram/package.json` — with vitest + fake-timers for Stockholm tz
- [ ] `scripts/verify-gate-1.mjs` — orchestrates all 9 Gate 1 CLI assertions
- [ ] `scripts/verify-indexer-roundtrip.mjs` — writes a test page to Notion, asserts round-trip into `entity_index`
- [ ] `scripts/verify-azure-index.mjs` — fetches Azure AI Search index definition, asserts binary quantization configured
- [ ] `scripts/verify-cap.mjs` — simulates 4 sends, asserts 4th rejects with cap-exceeded error
- [ ] `scripts/verify-vps-freeze.mjs` — SSH to VPS, verifies patched scripts write to Legacy Inbox DB only
- [ ] `tests/fixtures/notion-entity-page.json` — shared fixture for indexer tests
- [ ] Pre-flight: `aws transcribe list-vocabularies --region eu-north-1` (resolves A9 region assumption)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SNS email subscription confirmed | INF-05 (cost alarms) | AWS sends confirmation email; user must click link — cannot auto-confirm from CDK | 1. Run `cdk deploy SafetyStack`. 2. Check `kevin@tale-forge.app` inbox. 3. Click "Confirm subscription" link. 4. Run `aws sns list-subscriptions-by-topic --topic-arn <arn>` — status must be `Confirmed`. |
| Cost alarm fires at threshold | INF-05 | Requires real billing activity / cannot simulate without waiting for next billing cycle | Defer verification to first organic spend event; plan produces the alarm CDK resource + manual runbook entry. |
| Kevin Context page prompt-cache-ready | MEM-01 | Manual visual check that page is seeded with the right sections for future prompt-cache use | Open Notion Kevin Context page; confirm seeded sections match the template documented in RESEARCH.md. |
| VPS freeze dry-run | MIG-04 | Dry-run requires Kevin to witness that no duplicate writes land in Command Center / Kontakter / Daily Brief Log | 1. SSH to 98.91.6.66. 2. Trigger each of the 3 scripts manually. 3. Confirm writes land in `Legacy Inbox` DB with `[MIGRERAD]` marker. 4. Confirm Command Center / Kontakter untouched. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags in CI
- [ ] Feedback latency < 120s (unit) / < 8min (integration)
- [ ] `nyquist_compliant: true` set in frontmatter after planner finalizes task IDs

**Approval:** pending
