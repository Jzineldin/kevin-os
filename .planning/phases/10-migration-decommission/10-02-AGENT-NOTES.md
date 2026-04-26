# Phase 10 Plan 10-02 — Agent Execution Notes

Wave 1 (parallel with Plan 10-01) — retire `morning_briefing.py` +
`evening_checkin.py` Hetzner VPS scripts in favor of Phase 7 AUTO-01
(morning-brief) + AUTO-03 (day-close) Lambdas. **No new Lambda was
written by this plan** — Phase 7 already covers the substance. Plan
10-02 ships only the retirement tooling + verifier scripts + the
operator runbook. The actual VPS retirement is operator-deferred.

## Files created (3 + 1 = 4)

```
scripts/retire-vps-script.sh                                                    279 lines
scripts/verify-morning-evening-retired.mjs                                      484 lines
scripts/verify-legacy-inbox-silent.mjs                                          232 lines
.planning/phases/10-migration-decommission/10-02-RETIREMENT-RUNBOOK.md          320 lines
```

All four files exceed the plan's `min_lines` floors (80 / 120 / unset
/ unset).

## Plan-mandated automated verification

```
=== Task 1 verify ===
bash -n scripts/retire-vps-script.sh                                            OK
grep -q 'systemctl stop' scripts/retire-vps-script.sh                           OK
grep -q 'systemctl disable' scripts/retire-vps-script.sh                        OK
grep -q 'systemctl mask' scripts/retire-vps-script.sh                           OK
grep -q 'event_log' scripts/retire-vps-script.sh                                OK
grep -q -- '--dry-run' scripts/retire-vps-script.sh                             OK
grep -q -- '--undo' scripts/retire-vps-script.sh                                OK

=== Task 2 verify ===
node --check scripts/verify-morning-evening-retired.mjs                         OK
grep -q 'EventBridge' scripts/verify-morning-evening-retired.mjs                OK
grep -q 'systemctl is-active' scripts/verify-morning-evening-retired.mjs        OK
grep -q 'event_log' scripts/verify-morning-evening-retired.mjs                  OK
grep -q 'kos-morning-brief' scripts/verify-morning-evening-retired.mjs          OK

=== Task 3 verify ===
node --check scripts/verify-legacy-inbox-silent.mjs                             OK
test -f .planning/.../10-02-RETIREMENT-RUNBOOK.md                               OK
grep -q 'AUTO-01' .../10-02-RETIREMENT-RUNBOOK.md                               OK
grep -q 'retire-vps-script.sh' .../10-02-RETIREMENT-RUNBOOK.md                  OK
grep -q 'DRY_RUN_EVIDENCE' .../10-02-RETIREMENT-RUNBOOK.md                      OK
```

## Spot-tests run inline

- `bash scripts/retire-vps-script.sh --help` prints usage and exits 0.
- `bash scripts/retire-vps-script.sh --dry-run` (no required args)
  fails with `[FAIL] --unit is required` exit 3 — argument validation
  works.
- `bash scripts/retire-vps-script.sh --unit morning_briefing.service
  --replaced-by kos-morning-brief --dry-run` prints the full SSH +
  psql sequence (2 audit rows + stop + disable + mask + journalctl
  capture) without touching the VPS.
- `bash scripts/retire-vps-script.sh --undo --unit morning_briefing.service
  --dry-run` prints the unmask/enable/start sequence with one
  `vps-service-disabled` audit row carrying `detail.action='restored'`.
- `node scripts/verify-morning-evening-retired.mjs --help` exits 0
  with usage text.
- `node scripts/verify-legacy-inbox-silent.mjs --help` exits 0 with
  usage text.

## Key implementation decisions

1. **Audit-first invariant (D-12) hard-enforced.** `retire-vps-script.sh`
   exits 1 BEFORE any SSH/systemctl mutation if `RDS_URL` is unset or
   `psql` is missing. Two separate `event_log` rows are written
   (`vps-service-stopped` + `vps-service-disabled`) per retirement so
   each kind enum is observable independently.

2. **Schema columns `detail` (singular) + `occurred_at`.** The plan's
   draft uses `details` and `at`, but the on-disk migration 0001
   schema uses `detail` and `occurred_at` (preserved by Phase 10
   migration 0021 — see 10-00-AGENT-NOTES.md note 2). All three
   scripts query the actual columns.

3. **`vps-service-restored` is not in the contract enum.** The plan
   prose mentioned `event_log kind='vps-service-restored'` for the
   `--undo` audit row, but `EventLogKindSchema` only contains
   `vps-service-stopped` + `vps-service-disabled`. Rather than extend
   the contract enum mid-wave (would invalidate Plan 10-00's
   `packages/contracts/test/migration.test.ts` test fixture), the
   undo path writes a `vps-service-disabled` row with
   `detail.action='restored'`. Captures the same audit information
   without changing the contract surface. Documented inline in the
   script header comment + in the runbook.

4. **Schedule names + log groups are env-overridable.** Phase 7's CDK
   `KosLambda` construct does NOT set `functionName` (so the
   CloudFormation-generated name includes the stack id). The
   verifier's defaults assume the schedule names from
   `integrations-lifecycle.ts`
   (`morning-brief-weekdays-08`, `day-close-weekdays-18`,
   group `kos-schedules`) and a log-group prefix
   `/aws/lambda/KosIntegrations-MorningBrief|DayClose`. The operator
   can override via env (`MORNING_BRIEF_SCHEDULE_NAME`,
   `MORNING_BRIEF_LOG_GROUP`, etc.) if the deployed names differ —
   this matters because the actual log group includes a CDK suffix.

5. **Inventory fallback to fixture.** `verify-morning-evening-retired.mjs`
   reads
   `.planning/phases/10-migration-decommission/vps-service-inventory.json`
   if present, otherwise falls back to the Plan 10-00 fixture at
   `packages/test-fixtures/phase-10/vps-service-inventory.json`. The
   fixture's units (`morning_briefing.py` etc.) are matched by a
   case-insensitive prefix, so either freeze unit naming convention
   (with or without `.service`) is accepted.

6. **`--skip-ssh` flag for CI.** The verifier supports a `--skip-ssh`
   mode that uses the inventory's recorded `state` field instead of
   running `ssh systemctl is-active` live. Lets the verifier compile
   and self-test in environments that don't have SSH access to
   `kevin@98.91.6.66`.

7. **No chalk dep.** `verify-morning-evening-retired.mjs` writes ANSI
   colour codes inline (gated by `process.stdout.isTTY && !args.json`)
   instead of pulling in `chalk`. Keeps the root install lean and the
   `--json` mode emits clean machine-readable output.

8. **`pg` and `@notionhq/client` dynamic-import.** Both verifier
   scripts import the AWS SDK + `pg` + `@notionhq/client` via dynamic
   `import()` so a missing peer fails with a clean error message
   ("not installed: <e.message>") rather than crashing at module-load
   before `--help` can render.

## What was NOT done (per plan instructions)

- No `git add`, `git commit`, `git push`. Working tree left dirty.
- No CDK / Terraform / cloud touches. The retirement itself is
  operator-deferred per plan: "This plan does NOT execute the
  retirement — operator does at Wave 1 gate after Phase 7 is
  deployed."
- No SSH to the actual VPS. The `--dry-run` path was used end-to-end
  for both the retire flow and the undo flow.
- No psql writes to a real RDS. Audit-first invariant was tested via
  the unset-`RDS_URL` exit-1 path only.

## Operator-deferred items (visible in the runbook)

The runbook flags these as required prerequisites BEFORE the operator
runs Step 5/6:

1. SSH key authorized for `kevin@98.91.6.66` (path defaults to
   `~/.ssh/id_ed25519`, override via `SSH_KEY_PATH`).
2. `RDS_URL` exported from `aws secretsmanager get-secret-value
   --secret-id kos/rds-admin-url` (Step 2 of runbook).
3. Phase 7 prereq: at least one weekday's `morning` + `day-close` row
   in the Notion Daily Brief Log (Step 0).
4. Plan 10-00 inventory populated by `scripts/discover-vps-scripts.sh`
   (Step 3) — required so the verifier knows the exact unit names.
5. `# DRY_RUN_EVIDENCE` placeholder filled before T-0 (Step 4).
6. Optional: Plan 10-01 1-hour soak transcript pasted (Step 1) if the
   operator wants to retire `classify_and_save` in the same session.

## Downstream plans unblocked

- **Plan 10-07 (power-down)** can proceed 7 days after the operator
  signs off MIG-01 in `MIG-01-SIGNOFF.md` (per D-16 cold-failover
  window).
- **Plan 10-06 (4 unfrozen scripts retirement)** uses the same
  `scripts/retire-vps-script.sh` tool unchanged — Wave 3 reuses Wave
  1's tooling without modification.
- **MIG-01 acceptance gate** (ROADMAP SC 1) closes for the morning +
  evening parts after the day-7 sign-off; classify is closed by
  Plan 10-01.

## Risks logged for downstream plans

1. **CDK auto-suffix on log group names.** `MORNING_BRIEF_LOG_GROUP`
   default of `/aws/lambda/KosIntegrations-MorningBrief` is a guess
   based on the integration-stack id. The operator MUST verify the
   actual log group name post-Phase-7 deploy and export the env
   override if needed. The verifier's FAIL detail message hints at
   this explicitly.

2. **Schedule group rename risk.** `SCHEDULE_GROUP_NAME` default
   `kos-schedules` matches `events-stack.ts` line 29. If a future
   phase renames the group, the verifier will fail — the override
   env is the escape hatch but the runbook does not currently
   instruct the operator to re-export it.

3. **Notion Source field is `select` (not `rich_text`).** The
   `verify-legacy-inbox-silent.mjs` filter assumes `Source` is a
   Notion `select` property (per Phase 10-00 fixture
   `legacy-inbox-row.json`). If Phase 1 freeze actually wrote it as
   `rich_text`, the filter returns 0 results regardless — causing a
   false-PASS. The runbook's Step 9 cross-check
   (`ssh ... systemctl is-active` + crontab grep) is the safety net.

4. **`--undo` audit kind reuse.** Using `vps-service-disabled` for
   undo audit rows means a downstream consumer that counts
   "disabled" events will overcount restoration events as
   disablement. If a real consumer is added later, switch the
   contract enum to include `vps-service-restored` and update the
   `--undo` write site (single grep target).

End of agent notes.
