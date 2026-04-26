# 04-06 Agent Notes — Gate 3 verifiers + Phase 4 e2e script

**Plan**: `.planning/phases/04-email-pipeline-ios-capture/04-06-PLAN.md`
**Status**: scripts created, syntax-clean, fixture import smoke-tested.
**No deploy / no commit performed.** Branch: `phase-02-wave-5-gaps`.

## Artifacts shipped

| Path | Lines | Min | Notes |
|---|---|---|---|
| `scripts/verify-gate-3.mjs` | 548 | 200 | 3 automated criteria + SKIP path for #4 |
| `scripts/verify-phase-4-e2e.mjs` | 347 | 150 | 6 subprocess SCs + manual reminder block |
| `.planning/phases/04-email-pipeline-ios-capture/04-06-GATE-3-evidence-template.md` | 105 | 60 | 4-criterion evidence template, Phase 2 shape |

## verify-gate-3.mjs — design

Three Gate 3 criteria the verifier proves automatically:

1. **Idempotency** — direct SQL against the same `INSERT ... ON CONFLICT (account_id, message_id) DO NOTHING` path that `services/email-triage/src/persist.ts` uses. Inserts both `DUPLICATE_EMAIL_FIXTURES` entries; asserts `COUNT(*) = 1`; cleans up after itself. Skips with a printed reason if `PG_URL`/`DATABASE_URL` is unset (laptop-friendly).
2. **Prompt injection** — delegates to `pnpm --filter @kos/service-email-triage test`. The vitest suite already imports `ADVERSARIAL_INJECTION_EMAIL` and asserts classification + `mustNotContain` substrings. Re-implementing the Bedrock mocking in raw Node would duplicate the canonical test.
3. **Approve / Edit / Skip** — runs `pnpm --filter @kos/service-email-sender test` and `pnpm --filter @kos/dashboard-api test -- email-drafts` (both vitest filtered runs).

Fourth criterion (EmailEngine 7-day IMAP auth-failure soak) is intentionally NOT automated; the verifier prints a runbook reminder pointing at `04-EMAILENGINE-OPERATOR-RUNBOOK.md` step 11.

CLI:
- `--mode=offline | live` (default offline)
- `--test=idempotency | injection | approve-flow | all` (default all)
- `--help`

Exit codes: 0 = all selected PASS or SKIP; 1 = any FAIL; 2 = usage error.

Live mode is wired but stub-friendly:
- idempotency live: invokes `EMAIL_TRIAGE_FUNCTION` Lambda twice via `@aws-sdk/client-lambda`, then queries `DATABASE_URL` for the row count.
- injection live: PutEvents the adversarial fixture to `KOS_EVENT_BUS`, polls drafts table for 30 s, asserts `classification != urgent` and absence of forbidden substrings in `draft_body`.
- approve-flow live: throws an instructive error pointing to the evidence template (criterion 4 is operator narration, not automatable).

Structured JSON failure output is written to stderr (one JSON line per FAIL + a final summary line) for log-pipeline ingestion; the human summary stays on stdout.

## verify-phase-4-e2e.mjs — design

Five ROADMAP §Phase 4 success criteria mapped to six subprocesses:

| SC | Subprocess |
|---|---|
| SC1-ios-webhook | `pnpm --filter @kos/service-ios-webhook test` |
| SC2a-ses-inbound | `pnpm --filter @kos/service-ses-inbound test` |
| SC2b-emailengine-webhook | `pnpm --filter @kos/service-emailengine-webhook test` |
| SC3-gate-3 | `node scripts/verify-gate-3.mjs --mode=<mode>` |
| SC4-email-triage | `pnpm --filter @kos/service-email-triage test` |
| SC5-with-timeout-retry | `npx vitest run services/_shared/with-timeout-retry.test.ts` |

`services/_shared` has no `package.json` of its own, so SC5 runs the test file directly via root-level vitest rather than via a workspace filter.

Manual operator reminders printed at the end (latency clip <25 s, EmailEngine soak, real Approve flow).

## Key decisions

1. **Used `@kos/dashboard-api`, not `@kos/service-dashboard-api`.** The plan example used the wrong name; verified by reading `services/dashboard-api/package.json`.
2. **Loaded fixtures from `dist/src/index.js`, not the workspace alias.** Verifier scripts run as plain Node ESM with no TypeScript transformer; the compiled `dist` is the only loadable target. The script throws with a build-hint if `dist` is missing.
3. **Idempotency test SKIPs when no DB URL is set** rather than failing. Lets a fresh-clone laptop run `--mode=offline` end-to-end against the vitest-only criteria and still exit 0.
4. **Live mode is fully wired for criteria 1 and 2** (Lambda invoke + EventBridge fire + Postgres poll). Criterion 3 live raises a deliberate error pointing the operator at the evidence template — that one is human narration plus a SES MessageId, not a pure automation target.
5. **CleanUp around the idempotency test.** Pre-DELETE before the inserts (idempotent re-runs) and post-DELETE after the assertion. Avoids leaving fixture rows in any shared dev DB.

## Verification performed

- `node --check` on both scripts: pass.
- `node scripts/verify-gate-3.mjs --help`: prints usage; exits 0.
- `node scripts/verify-phase-4-e2e.mjs --help`: prints usage; exits 0.
- `node scripts/verify-gate-3.mjs --mode=offline --test=idempotency` with no DB env: SKIPs cleanly, exits 0.
- Fixture import smoke: `import('./packages/test-fixtures/dist/src/index.js')` resolves both `DUPLICATE_EMAIL_FIXTURES` (length 2) and `ADVERSARIAL_INJECTION_EMAIL.expected.classification === 'junk'`.
- Did NOT execute the full vitest suites in this session — operator runs them via the verifier.

## Post-Phase-4 operator TODO

1. Build/refresh `pnpm --filter @kos/test-fixtures build` (so `dist/` is current).
2. Run `node scripts/verify-phase-4-e2e.mjs --mode=offline` from a clean tree; expect all 6 SCs PASS.
3. After deploy, run `node scripts/verify-phase-4-e2e.mjs --mode=live` with `EMAIL_TRIAGE_FUNCTION`, `KOS_EVENT_BUS`, `DATABASE_URL`, `AWS_REGION` set.
4. Approve a real urgent draft in `/inbox`; capture the SES MessageId from CloudWatch.
5. Run the 7-day EmailEngine `EmailEngineAuthFailures` Sum-per-day query.
6. Copy `04-06-GATE-3-evidence-template.md` to `04-06-GATE-3-evidence-YYYYMMDD.md`, fill in every `<...>` placeholder, flip `status:` from `TEMPLATE` to `PASS`, commit.

## Out of scope (intentionally left for the operator runbook)

- Cross-region SES rule-set drift detection (operator-owned outside CDK; documented in `04-SES-OPERATOR-RUNBOOK.md`).
- EmailEngine Fargate task-restart accounting during the 7-day soak (note any restart events in the evidence file alongside the daily Sum values).
- SES production-access status (criterion 4 only fully retires once sandbox is lifted; until then, use verified test recipients).
