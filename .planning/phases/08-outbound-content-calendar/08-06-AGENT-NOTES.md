---
phase: 08-outbound-content-calendar
plan: 06
agent_run_at: 2026-04-25
worktree: .claude/worktrees/agent-a134ade3fb805de9d
branch: phase-02-wave-5-gaps
status: scripts-written; not committed
---

# 08-06 Agent Notes

## Goal

Deliver Phase 8's gate verifier scripts and e2e test, mirroring the Phase 4 /
Phase 5 verifier pattern (`verify-gate-3.mjs` / `verify-gate-5.mjs` /
`verify-phase-4-e2e.mjs` / `verify-phase-5-e2e.mjs`).

Plan 08-03 is `autonomous: false` (Postiz publisher + signed brand voice) and
is NOT executed; gate criteria for that plan are surfaced as `MANUAL_BLOCKED`.

## What was written

| Path | Lines | Purpose |
|------|------:|---------|
| `scripts/verify-gate-8.mjs` | 874 | 8-test gate verifier — IAM/SQL invariant, prompt-injection, mutation rollback, Step Functions, calendar, document-diff, Postiz Fargate, brand voice. Mirrors `verify-gate-5.mjs` shape. |
| `scripts/verify-phase-8-e2e.mjs` | 644 | All 7 ROADMAP SC verifier (SC1–SC7); SC5 delegates to `verify-gate-8.mjs --test=approve-gate`. Mirrors `verify-phase-5-e2e.mjs`. |
| `.planning/phases/08-outbound-content-calendar/08-06-GATE-evidence-template.md` | 186 | Operator evidence checklist mirroring Phase 4 `04-06-GATE-3-evidence-template.md` + Phase 6 `06-06-GATE-evidence-template.md`. |

The plan's `files_modified` list also names three sub-verifiers
(`verify-approve-gate-invariant.mjs`, `verify-prompt-injection-content-writer.mjs`,
`verify-mutation-rollback.mjs`) under Task 2. These are NOT created in this
agent run (the user message scoped this run to the gate verifier + e2e +
evidence template). The gate verifier is wired to **delegate** to those
scripts when they exist (`existsSync()` check) and to fall through to a
`PENDING` status when missing — so they can land in a follow-up plan run
without breaking the gate verifier.

## Design decisions

### 1. Script naming: `verify-gate-8.mjs`

Phase 4 used Gate 3, Phase 5 used Gate 5. Numbering is per-phase. For
Phase 8, "Gate 8" was the natural choice (matches the phase number; no
existing collision).

### 2. ESM Node 22, `parseArgs`

Both scripts use `node:util` `parseArgs` with `strict: false` to mirror the
existing pattern in `verify-gate-5.mjs`. `strict: false` is required because
`parseArgs` complains about unknown options otherwise — and the operator
runbook may pass extra flags (e.g., `AWS_REGION=...` env vars are unaffected,
but future flags get added).

### 3. `--mode=offline|live` semantic split

- **offline** (default): pure vitest delegation + `node --check` on optional
  sub-verifiers + structural CDK synth. CI-safe; no AWS / RDS / Notion creds.
- **live**: adds AWS Step Functions DescribeStateMachine, ECS DescribeServices,
  Secrets Manager describe, RDS SQL probes for orphan publish authorization
  rows. Operator-invoked post-deploy.

This matches the explicit two-mode contract from the user message and is
identical to `verify-gate-5.mjs`.

### 4. `--test=name|all` semantic split

- `verify-gate-8.mjs` exposes 8 tests:
  `approve-gate | prompt-injection | mutation-rollback | step-functions | calendar | document-diff | postiz | brand-voice`.
- `verify-phase-8-e2e.mjs` exposes 7 tests by SC name:
  `SC1 | SC2 | SC3 | SC4 | SC5 | SC6 | SC7`.

Operator can drill into any single SC during execute-phase iteration.

### 5. Exit codes 0 / 1 / 2

- 0: every selected test PASSED, SKIPPED, PENDING, or MANUAL_BLOCKED.
- 1: at least one FAIL; structured JSON written to stderr.
- 2: usage error (bad mode/test value, missing required env in live mode).

Verified via:
```
node scripts/verify-gate-8.mjs --mode=bogus     # exit 2
node scripts/verify-gate-8.mjs --test=bogus     # exit 2
node scripts/verify-phase-8-e2e.mjs --mode=bogus # exit 2
```

### 6. Plan 08-03 MANUAL_BLOCKED handling

Plan 08-03 ships:
- Postiz Fargate first-boot (manual admin user creation, API key gen).
- Per-platform OAuth (Instagram/LinkedIn/TikTok/Reddit/Newsletter).
- BRAND_VOICE.md filled with real (non-template) voice content.
- First real Approve+publish round-trip from `/inbox`.

For each, the gate verifier returns `MANUAL_BLOCKED` with a runbook reminder
pointing at `08-06-GATE-evidence-template.md`. Brand-voice gets a static
`human_verification: true` front-matter check + a heuristic "voice hints"
matcher (looks for `Tale Forge`, `Kevin`, `barn|child|berätt|story`); needs
≥2/3 hits to avoid the still-template MANUAL_BLOCKED warning.

Postiz live probe is a soft check: if `aws ecs describe-services` returns
1/1 ACTIVE, the runtime side is reported PASS but the OAuth + round-trip
remain MANUAL_BLOCKED.

### 7. Sub-verifier delegation pattern (PENDING)

For each of the three Plan 08-06 Task 2 deliverables not yet shipped
(`verify-approve-gate-invariant.mjs`, `verify-prompt-injection-content-writer.mjs`,
`verify-mutation-rollback.mjs`), the gate verifier:
1. Checks `existsSync(scripts/...)`.
2. If present: runs in subprocess with `--live` / `--static` / `--verify` as
   appropriate; treats non-zero exit as FAIL.
3. If absent in offline mode: still PASS (or PENDING, depending on whether
   the structural part is wired) with a "Plan 08-06 Task 2 not landed" note.
4. If absent in live mode: PENDING with same note.

This means the gate verifier is shippable today (Plan 08-06 Task 1) and
becomes stronger when Task 2 lands.

### 8. Workspace presence checks

For each phase 8 service workspace (`@kos/service-content-writer`,
`@kos/service-content-writer-platform`, `@kos/service-publisher`,
`@kos/service-calendar-reader`, `@kos/service-document-diff`,
`@kos/service-mutation-proposer`, `@kos/service-mutation-executor`):
- gate-8 + phase-8-e2e probe `existsSync(services/<name>/package.json)`.
- If absent → PENDING with a "Plan 08-NN not landed" note.
- If present → run `pnpm --filter <pkg> test --run`.

This matches the Phase 5 cherry-pick pattern (verify-gate-5 tolerates
chrome-extension being absent).

## Verification performed

```
$ node --check scripts/verify-gate-8.mjs
GATE-OK
$ node --check scripts/verify-phase-8-e2e.mjs
E2E-OK
$ node scripts/verify-gate-8.mjs --help
<prints usage; exit 0>
$ node scripts/verify-phase-8-e2e.mjs --help
<prints usage; exit 0>
$ node scripts/verify-gate-8.mjs --mode=bogus
[verify-gate-8] unknown --mode=bogus (expected offline | live)
exit=2
$ node scripts/verify-gate-8.mjs --test=bogus
[verify-gate-8] unknown --test=bogus ...
exit=2
$ node scripts/verify-phase-8-e2e.mjs --mode=bogus
[verify-phase-8-e2e] unknown --mode=bogus
exit=2
```

Live execution (offline runs of vitest sub-suites) is deferred to
`/gsd-execute-phase 8` operator flow — Plan 08-00 / 08-01 / 08-02 / 08-04 /
08-05 must be executed first to have anything to verify.

## Operator runbook (sequence during execute-phase Gate review)

1. **Static / offline checks first** (CI-safe; no AWS):
   ```
   node scripts/verify-gate-8.mjs --mode=offline
   node scripts/verify-phase-8-e2e.mjs --mode=offline
   ```
   Both should exit 0 with a mix of PASS and PENDING (PENDING is fine pre-deploy).

2. **Deploy**: `pnpm --filter @kos/cdk deploy KosIntegrations` (Plan 08-03
   manual: deploy Postiz stack first, complete first-boot OAuth flows).

3. **Live checks**:
   ```
   AWS_REGION=eu-north-1 DATABASE_URL=postgres://... \
     node scripts/verify-gate-8.mjs --mode=live
   AWS_REGION=eu-north-1 DATABASE_URL=postgres://... \
     node scripts/verify-phase-8-e2e.mjs --mode=live
   ```

4. **Manual UI checks** (operator owns these, MANUAL_BLOCKED rows):
   - BRAND_VOICE.md filled with real Kevin voice + `human_verification: true`.
   - Postiz per-platform OAuth (5 platforms).
   - First real topic submitted via `/inbox` → Approve → published.
   - Voice mutation flow ("ta bort mötet imorgon kl 11") → Approve → archived.
   - Document version flow (avtal.pdf v3 → v4 → entity timeline).

5. **Sign-off**: fill in
   `.planning/phases/08-outbound-content-calendar/08-06-GATE-evidence-template.md`
   with command outputs + manual checks + cost observations + signature.

## Known caveats

- **Live e2e requires AWS creds** + Postiz up-and-running + Google OAuth
  bootstrapped + `BRAND_VOICE.md` filled. None of these are pre-conditions
  for the OFFLINE script run.
- **DRY_RUN mode** is the default offline mode — script logic validates without
  live cloud calls. The plan's literal sketch shows `DRY_RUN = process.argv.includes('--dry-run')`;
  this verifier uses `--mode=offline` instead, which is the established
  pattern from Phase 4 / Phase 5.
- **Plan 08-06 Task 2** (the 3 sub-verifiers) is NOT delivered in this run.
  Gate verifier degrades gracefully: missing sub-verifiers → PENDING, structural
  parts still PASS.
- **Plan 08-03** (autonomous: false) means Postiz first-boot, per-platform
  OAuth, BRAND_VOICE.md sign-off, and first round-trip will appear as
  MANUAL_BLOCKED until the operator runs them — this is by design.
- **Workspace presence**: every Phase 8 service workspace lookup is wrapped
  in `existsSync(services/<name>/package.json)` — running this script before
  any Phase 8 plan ships will produce a wall of PENDING with no FAILs.

## Files NOT delivered (deferred)

These are listed in the plan's `files_modified` but were explicitly out of
scope for this agent run per the user message:

- `scripts/verify-approve-gate-invariant.mjs` (Plan 08-06 Task 2)
- `scripts/verify-prompt-injection-content-writer.mjs` (Plan 08-06 Task 2)
- `scripts/verify-mutation-rollback.mjs` (Plan 08-06 Task 2)

The gate verifier already imports their expected shapes and degrades
gracefully if missing — landing them later requires no changes to the
existing gate / e2e scripts.

## Commit status

Per user message: "Don't commit." Files staged in worktree only.
