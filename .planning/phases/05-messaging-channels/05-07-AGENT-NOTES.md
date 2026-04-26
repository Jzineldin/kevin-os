# Plan 05-07 Agent Notes

**Scope of this run:** Wave 5 gap-fill. The user asked specifically for the
Phase 5 Gate 5 verifier scripts + e2e script + evidence template — i.e. the
operator-facing CLI deliverables. The Lambda + CDK pieces in Plan 05-07
Task 1 (services/verify-gate-5-baileys handler body, integrations-verify-gate-5
stack, and the 5 vitest tests for them) were intentionally NOT touched
because:

1. They depend on Plan 05-04 (Baileys Fargate CDK) which is `autonomous: false`
   and has not yet shipped — so the upstream `/ecs/baileys` log group, the
   `BaileysService` Fargate service, and the `sync_status` table for
   `channel='baileys_gate_5'` are not yet wired in CDK.
2. The user request explicitly said: "Plan 05-04 (WhatsApp Fargate) is
   autonomous=false and not yet shipped, so the verify-gate-5 7-day soak
   criterion should be documented as manual / blocked-on-04. But the script
   structure should accommodate it for future fill-in." That exactly
   describes where the Lambda body sits — blocked on 05-04.
3. Scaffolding for `services/verify-gate-5-baileys` already exists (handler
   throws "not yet implemented") and the empty CDK shell can be added in a
   follow-up plan without rework, since the verifier scripts now define the
   contract the Lambda must produce (`sync_status.queue_depth WHERE
   channel='baileys_gate_5'`).

## Files written

| Path | Lines | Purpose |
|------|-------|---------|
| `scripts/verify-gate-5.mjs` | ~430 | Gate 5 6-criterion verifier (3 auto + 3 documented). Mirrors `verify-gate-3.mjs` shape. |
| `scripts/verify-phase-5-e2e.mjs` | ~310 | Phase 5 SC1-5 e2e walker. Mirrors `verify-phase-4-e2e.mjs` shape. Delegates SC3 to `verify-gate-5.mjs`. |
| `.planning/phases/05-messaging-channels/05-07-GATE-5-evidence-template.md` | ~170 | 7-criterion evidence template with `/FILL-IN` slots for operator. |

## Files NOT written (deferred / blocked)

| Path | Reason |
|------|--------|
| `services/verify-gate-5-baileys/src/handler.ts` | Lambda body — blocked on Plan 05-04 (Baileys Fargate CDK + `/ecs/baileys` log group). Scaffold remains throwing. |
| `services/verify-gate-5-baileys/test/handler.test.ts` | 5 unit tests for handler — same blocker. |
| `packages/cdk/lib/stacks/integrations-verify-gate-5.ts` | CDK stack for Scheduler + IAM — same blocker. |
| `packages/cdk/lib/stacks/integrations-stack.ts` | Wiring change — same blocker. |
| `packages/cdk/test/integrations-verify-gate-5.test.ts` | CDK synth test — same blocker. |
| `.planning/phases/05-messaging-channels/05-07-LINKEDIN-14-DAY-evidence-template.md` | Plan 05-07 lists this in `files_modified` but the template duplicates Plan 05-03's `verify-linkedin-observation.mjs` daily aggregate. The Gate 5 evidence template references it by path; ship in 05-03 follow-up or here in a future pass. |

## Pattern fidelity vs Phase 4

The Phase 4 verifier pattern (verify-gate-3.mjs + verify-phase-4-e2e.mjs) is
mirrored exactly:

- ESM Node 22, `parseArgs` from `node:util`.
- `--mode=offline|live` (default offline) and `--test=<name>|all`.
- Exit codes: `0` PASS / `1` FAIL / `2` usage error.
- Structured JSON to stderr on FAIL (per-test + final summary).
- Vitest delegation via `pnpm --filter <pkg> test -- --run --reporter=basic`.
- Result accumulator with PASS / FAIL / SKIP sigils for human stdout.
- Manual-check reminders printed at end.

Two intentional extensions vs the Phase 4 pattern:

1. **`MANUAL_BLOCKED` and `PENDING` statuses** in `verify-gate-5.mjs` — Phase 5
   has cross-phase dependencies (Plan 05-04 not shipped, Phase 10 Plan 10-04
   pending) that don't fit the binary pass/fail/skip model. These are SOFT
   states that exit-0 and surface as informational rather than failing the
   gate. Both states are explicitly differentiated from `SKIP` in the runner
   (`runTest` checks for `manual_blocked` / `pending` keys in the returned
   detail object).

2. **Capture-path enumeration in the e2e header** — the user request asked
   for "all 4 Phase 5 capture paths (Chrome, LinkedIn, WhatsApp/Baileys-stub,
   Discord) end-to-end". The header docblock explicitly lists each capture
   path → vitest workspace mapping so the operator can grep for "I'm only
   running the Chrome cherry-pick — which SCs apply to me?".

## Verification

```
$ node --check scripts/verify-gate-5.mjs && node --check scripts/verify-phase-5-e2e.mjs && echo OK
OK

$ node scripts/verify-gate-5.mjs --help | head -5
Usage: node scripts/verify-gate-5.mjs [--mode=offline|live] [--test=<name>|all]
...

$ node scripts/verify-phase-5-e2e.mjs --help | head -5
Usage: node scripts/verify-phase-5-e2e.mjs [--mode=offline|live]
...
```

Plan 05-07 Task 2 verification gate (`node --check ... && echo OK`) passes.

Note: end-to-end runs of the scripts (offline mode) were NOT executed in this
agent because:
- They invoke `pnpm --filter @kos/service-baileys-fargate test` etc., and the
  Wave 5 worktree may not have `pnpm install` run for Phase 5 packages yet.
- The user said "Verify: scripts node --check pass" — that's done.
- Each delegated vitest sub-run is the contract the package author already
  validates in their plan's `<verify>` block; this verifier is a meta-runner.

## Cherry-pick coverage (mirrors 05-VALIDATION.md §Cherry-pick)

| Subset | SCs exercised | Operator command |
|--------|---------------|------------------|
| Chrome-only | SC1 + SC3 (chrome subset of Gate 5) | `node scripts/verify-phase-5-e2e.mjs` |
| Chrome + LinkedIn | SC1 + SC2 + SC3 (linkedin subset) | same; ignore Baileys-stub failures (will SKIP) |
| Full (incl. WhatsApp) | SC1-5; Gate 5 #6 soak gates production label | `--mode=live` post-deploy of Plan 05-04 + 05-05 |
| + Discord fallback | + SC4 live ARN check | requires Phase 10 Plan 10-04 SSM seed |

## Decisions

- **`sync_status.queue_depth` re-purposed as `zero_write_days` counter for
  `channel='baileys_gate_5'`.** Chosen over a new column to keep
  Plan 05-00's migration 0017 minimal. The verifier reads it under that
  column name.
- **Discord SC4 gracefully soft-skips** if the SSM ARN is missing rather than
  failing — Phase 5 ships the Scheduler wiring; the runtime ARN is Phase 10's
  responsibility. Producing a hard fail here would block Phase 5 production
  label on a downstream phase.
- **Vitest delegation over hand-rolled probes.** Each Phase 5 plan's
  `<verify>` block already specifies the canonical test command; the verifier
  re-executes those exact commands so no logic drifts between the plans and
  the gate runner.
- **No `pnpm install` / `pnpm build` invoked in the verifier** — both would
  surprise an operator who runs the script in CI. The scripts assume a
  hydrated workspace, like verify-gate-3.mjs does.

## Open follow-ups (when Plan 05-04 lands)

1. Implement `services/verify-gate-5-baileys/src/handler.ts` per Plan 05-07
   Task 1 spec. The script `verify-gate-5.mjs --mode=live --test=soak`
   already reads the schema this Lambda is contracted to write.
2. Add CDK `integrations-verify-gate-5.ts` + Scheduler + IAM grants
   (cron `0 1 * * ? *` UTC).
3. Write the 5 handler unit tests + the CDK synth test.
4. Add `.planning/phases/05-messaging-channels/05-07-LINKEDIN-14-DAY-evidence-template.md`
   (or fold into Plan 05-03 follow-up).

These are all gated on Plan 05-04 (Baileys Fargate, autonomous=false) — Kevin
must approve and run that plan before this Wave 5 deliverable can complete.

## Safety

- No git commits made (per user instruction).
- No destructive operations.
- No secrets touched.
- Only `Write` operations (3 new files); zero edits to existing files.
