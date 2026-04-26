---
phase: 10-migration-decommission
plan: 10-06
agent: phase-10-wave-3-executor
date: 2026-04-25
status: implemented (not committed)
---

# Plan 10-06 Agent Notes

## Scope as actually implemented

Implemented the **4-unfrozen-VPS-script retirement tooling** for Plan
10-06. The plan as written (`10-06-PLAN.md`) listed two tasks plus a
discovery script (`scripts/discover-vps-scripts.sh`); the user-supplied
narrower brief asked me to:

1. Reuse `scripts/retire-vps-script.sh` (already on master from Plan
   10-02) — call it 4× from the runbook.
2. Add a consolidated verifier covering the 4 unfrozen scripts AND
   confirming each replacement is active.
3. Write the operator runbook for the 4-unit cutover.

I focused on (1)–(3) and did NOT touch the discovery script or the
example inventory JSON — those already exist on master
(`packages/test-fixtures/phase-10/vps-service-inventory.json` covers
the schema shape; the plan's discovery script + `vps-service-inventory.json`
artifact remain to be authored if Wave 3 needs them).

## Files added

| Path | LOC | Purpose |
|------|-----|---------|
| `scripts/verify-4-unfrozen-retired.mjs` | ~390 | Consolidated verifier — 5 check classes × 4 services (16 PASS-needed + 4 audit) |
| `.planning/phases/10-migration-decommission/10-06-RETIREMENT-RUNBOOK.md` | ~250 | Operator-sequenced T-0 + T+30m + rollback runbook |

## Files NOT added (deliberately deferred)

- `scripts/discover-vps-scripts.sh` — Plan 10-06 PLAN.md Task 1. The
  user's brief said "calls retire-vps-script.sh 4× + adds verifiers
  per script", which scopes me to verifier + runbook. Operator-side
  inventory generation is a separate scaffolding task; the existing
  fixture (`packages/test-fixtures/phase-10/vps-service-inventory.json`)
  is what the morning-evening verifier already keys off, and our
  verifier reads from environment + retire-vps-script.sh's audit
  rows directly — no inventory JSON dependency.
- `vps-service-inventory.example.json` — same reasoning; the existing
  test fixture documents the shape.

## Design decisions

### One consolidated verifier (not 4 per-service verifiers)

Plan-narrative wording was "verify-brain-server-retired.mjs (or one
consolidated verifier)" — I chose the consolidated form because:

1. The 5 check classes (systemctl-active, systemctl-enabled, ps-clean,
   event_log, replacement-liveness) are uniform across all 4 services;
   four near-identical files would duplicate ~300 lines of boilerplate.
2. Operator-side it's one `node scripts/verify-...` invocation, one
   exit code, one summary line. Matches the
   `verify-morning-evening-retired.mjs` pattern (Plan 10-02) which
   also covers two units in one verifier.
3. Each result row keys on the service name, so failures are
   individually attributable in CI / log review.

### Replacement-liveness checks

Per the user's brief, each retired service maps to a replacement
liveness check:

| Retired | Replacement | Check shape |
|---------|-------------|-------------|
| `brain_server`         | Phase 3 dashboard relay (`RelayProxy` Lambda) | Lambda exists + Active. NO recent-log requirement (relay-proxy is request-driven; idle ≠ broken) |
| `gmail_classifier`     | Phase 4 `EmailTriageAgent` Lambda             | Lambda exists + Active + ≥ 1 CW log event in past 48h (2h schedule) |
| `brain-dump-listener`  | Plan 10-04 `DiscordBrainDump` Lambda          | Lambda exists + Active + ≥ 1 CW log event in past 48h (5min schedule) |
| `sync_aggregated`      | INERT — no replacement                         | Audit-row presence only (Check D); replacement check returns "INERT" PASS |

CDK construct names → default Lambda function names (overridable via
env):
- `KosIntegrations-RelayProxy`
- `KosIntegrations-EmailTriageAgent`
- `KosMigration-DiscordBrainDump`

These match the construct IDs in `packages/cdk/lib/stacks/integrations-dashboard.ts`,
`integrations-email-agents.ts`, and `integrations-migration.ts`. CDK
auto-suffixes function names if `functionName` isn't set explicitly,
so the env-var override is the operator's escape hatch when the
synthesized name doesn't match the construct id literal.

### event_log query tolerance

The retire-vps-script.sh writes `detail.unit` (e.g. `'brain-server.service'`).
Operator-run discovery may instead populate `detail.service_name` (e.g.
`'brain_server'`). The verifier query accepts BOTH, plus tolerates
underscored ↔ hyphenated naming (`gmail_classifier` vs `gmail-classifier`)
and stripped `.service` suffix. This avoids hard-coupling the verifier
to a particular discovery convention — it just looks for an audit row.

### --skip-ssh CI mode

Same convention as `verify-morning-evening-retired.mjs`: `--skip-ssh`
makes the SSH-side checks pass-through (PASS with a note), so the
verifier can run in CI as a structural sanity check without
operator-side SSH access. The AWS-side checks (event_log, replacement
liveness) still run when env is set.

## Verification ran

```
$ node --check scripts/verify-4-unfrozen-retired.mjs
node --check OK

$ bash -n scripts/retire-vps-script.sh
retire-vps-script.sh bash -n OK

$ node scripts/verify-4-unfrozen-retired.mjs --help
(prints usage)

$ node scripts/verify-4-unfrozen-retired.mjs --skip-ssh --json
(runs cleanly; SSH-side PASS; AWS-side correctly FAILs since the
 stacks aren't deployed in this dev env. event_log FAIL because
 RDS_URL not set. All expected.)
```

## Validation-matrix grep targets

The PLAN file's `<verify>` block in Task 2 calls for:
- `node --check scripts/verify-unfrozen-scripts-retired.mjs` ✓
  (file is named `verify-4-unfrozen-retired.mjs` per user brief)
- `grep -q "systemctl is-active"` ✓ (5 occurrences)
- `grep -q "event_log"` ✓ (12+ occurrences)
- runbook `grep -q "gmail_classifier.*email-triage|gmail-classifier"` ✓
- runbook `grep -q "brain_server.*inert|brain-server.*inert"` ✓

## What the operator must do next

1. Set the env vars listed in the runbook header (RDS_URL,
   VPS_SSH_TARGET, optionally Lambda function name overrides).
2. Run the runbook end-to-end: pre-checks → dry-runs → 4× retire-vps
   invocations → verifier.
3. Watch for 14 days; if all green, sign off in `MIG-01-SIGNOFF.md`.

## Open questions / risks

- **Lambda function-name discovery**: defaults assume CDK
  `<StackName>-<ConstructId>` produces the function name. If the CDK
  uses an explicit `functionName: 'kos-email-triage'` style override
  somewhere I missed, the verifier will FAIL on the replacement check
  with "ResourceNotFoundException" — operator overrides the env var
  and re-runs.
- **`@aws-sdk/client-scheduler` not at root**: the morning-evening
  verifier uses scheduler; my new verifier doesn't (no schedule
  health checks needed for these 4 — the replacements are
  EventBridge-rule or Function-URL driven, already covered by
  Phase 3/4/10-04 tests). Avoided adding an unused dep.
- **brain_server replacement = "ecosystem"**: the Phase 3 dashboard is
  Next.js on Vercel + dashboard-listen-relay Fargate + RelayProxy
  Lambda. I keyed the verifier on the RelayProxy Lambda only (the
  AWS-side surface that's queryable). The Vercel deployment URL is a
  manual operator spot-check (Step 7 in runbook).
- **Plan 10-06 PLAN file lists `vps-service-inventory.example.json` +
  `discover-vps-scripts.sh`** as artifacts — those are NOT shipped by
  this commit. If the Wave 3 gate requires them, a follow-up plan
  iteration should add them; the existing
  `packages/test-fixtures/phase-10/vps-service-inventory.json` covers
  the schema-evidence requirement for now.

## No commit

Per user brief — files are written but not committed. `git status`
shows the two new files plus the prior worktree dirty state
(`.planning/config.json`, `apps/dashboard/next-env.d.ts`).
