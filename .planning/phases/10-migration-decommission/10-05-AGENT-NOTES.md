# Phase 10 Plan 10-05 — Agent Execution Notes (MIG-02)

Wave 3 execution of MIG-02: decommission n8n on the Hetzner VPS port
5678 (likely rogue caller per
`.planning/debug/resolved/telegram-webhook-auto-clear.md`).

This run implemented the **operator-tooling track only** per the user
dispatch instructions (operator scripts + runbook). The Phase 10-00
archiver Lambda (`services/n8n-workflow-archiver`) already ships the
canonical-JSON + SHA-256 + KMS-encrypted PutObject handler, so this
plan reuses it unchanged.

## Files created

```
scripts/snapshot-n8n-workflows.mjs                                     457 lines
scripts/decommission-n8n.sh                                            330 lines
scripts/verify-n8n-decommissioned.mjs                                  259 lines
.planning/phases/10-migration-decommission/10-05-DECOMMISSION-RUNBOOK.md  ~280 lines
```

All three scripts are `chmod +x` and use the same conventions as the
existing `scripts/retire-vps-script.sh` (audit-first invariant, SSH
flag overrides via env vars, `--dry-run` printing without mutation,
strict `set -euo pipefail`).

## Files NOT modified

Per the user dispatch, the existing
`services/n8n-workflow-archiver/src/handler.ts` was NOT touched —
Phase 10-00 already shipped the canonical-JSON + SHA-256 + S3 PUT path
with passing tests. The plan's PLAN.md mentions Task 1 extending the
archiver into `archive.ts` + `handler.ts` split, but the user's
dispatch explicitly scoped this run to "MIG-02 operator scripts +
runbook" with the archiver "fully implemented" already. No archiver
test changes either.

## Filename deviations from PLAN.md

The PLAN.md `files_modified` block names:
- `scripts/decom-n8n.sh`
- `scripts/verify-n8n-dead.mjs`
- `.planning/phases/10-migration-decommission/10-05-N8N-DECOM-RUNBOOK.md`

The user dispatch instructions explicitly named:
- `scripts/decommission-n8n.sh`
- `scripts/verify-n8n-decommissioned.mjs`
- `scripts/snapshot-n8n-workflows.mjs`     (new — not in PLAN.md)
- `.planning/phases/10-migration-decommission/10-05-DECOMMISSION-RUNBOOK.md`

User-dispatch names take precedence. The snapshot script is a new
artifact split out of what PLAN.md called Task 2 Stage 2 ("for each
workflow ID in list, fetch full"); separating it lets the snapshot
phase be tested + dry-run independently of the destructive shell
script.

## Architectural decisions

### 1. Archive-before-destroy enforced in two places

- `decommission-n8n.sh` Stage 2 must succeed (snapshot script exit 0)
  before Stage 3 confirmation gate.
- Between Stage 2 and Stage 3, the shell reads `event_log` for a
  recent `n8n-workflows-archived` `detail.action='snapshot-ok'` row.
  If absent, the script aborts before any mutation. This is a defense
  against the case where `aws lambda invoke` returned 0 but actually
  failed silently — the audit row is the ground truth.

### 2. Audit-first ordering (D-12)

- Snapshot script writes a `snapshot-begin` audit row BEFORE the
  Lambda invocation (so a partial failure leaves a trail).
- Snapshot script writes a `snapshot-ok` audit row AFTER successful
  Lambda return (the existence of this row is the gate for Stage 4).
- Decommission script writes the `n8n-stopped` audit row AFTER the
  systemctl stop+disable+mask succeeds (matches existing
  `retire-vps-script.sh` post-mutation pattern; the preceding
  `snapshot-ok` row already proves intent).

### 3. Two-source port probe (P-07 mitigation)

- `verify-n8n-decommissioned.mjs` runs the port probe from the
  operator's machine via `node:net`.
- The runbook documents a manual `nc -zv 98.91.6.66 5678` from AWS
  CloudShell as the second source. Not automated — the verifier returns
  PASS on the first source, runbook records the second.
- A future iteration could ship a one-shot probe Lambda
  (deployed via CDK) for fully automated dual-source confirmation;
  current decision is to keep the verifier dependency-free and leave
  the second-source check as an operator step.

### 4. SSH tunnel ownership

- The shell script opens the tunnel (`ssh -f -N -L 15678:localhost:5678`)
  before invoking the snapshot script.
- The snapshot script connects to `127.0.0.1:15678` (the local end of
  the forward), NOT directly to the VPS — so the snapshot script can
  also be exercised against a `ssh -L` tunnel set up manually for
  debugging.
- An EXIT trap in the shell pkills the tunnel on any exit path
  (success, failure, abort) — match-string narrow enough not to stomp
  on unrelated forwards.

### 5. Credential metadata (NOT secrets)

- `scripts/snapshot-n8n-workflows.mjs` calls `/rest/credentials` to
  capture the credential `id`, `name`, `type` only.
- The actual decrypted secret material stays in n8n's encryption-at-rest
  store; n8n's REST does not expose it via the list endpoint anyway.
- The credential names are written into the `snapshot-ok`
  `event_log.detail.credential_names` array for the audit trail —
  during a rollback, the operator knows which credential names existed
  and can re-create them by hand.

### 6. Firewall closure NOT done by this plan

- PLAN.md mentions Stage 4 UFW closure of port 5678. Discussions with
  the user-dispatch scope this to "operator scripts + runbook" without
  the firewall step.
- Process-level closure is sufficient for now: with `n8n.service`
  masked, no listener exists on 5678 → external probes return
  `ECONNREFUSED` regardless of firewall state.
- Plan 10-06's broader firewall pass owns the UFW rule.

### 7. Non-destructive abort paths

- Stage 1 (DISCOVER): if `is-active` returns inactive, the script
  warns but continues — n8n's data dir may still hold workflow state
  worth archiving.
- Stage 2 (SNAPSHOT): if 0 workflows are returned, the script exits 3
  — either the tunnel is wrong or the archive is empty; either way,
  destroying without an archive is forbidden.
- Stage 3 (CONFIRM): typing anything other than `decom` exits 3 with
  no destructive action. The snapshot is in S3 and the audit rows are
  written, so resuming later is safe.

## Verification outputs

```
$ bash -n scripts/decommission-n8n.sh
(no output — passes)

$ node --check scripts/snapshot-n8n-workflows.mjs
(no output — passes)

$ node --check scripts/verify-n8n-decommissioned.mjs
(no output — passes)

$ bash scripts/decommission-n8n.sh --help
(prints usage block, exits 0)

$ node scripts/snapshot-n8n-workflows.mjs --help
(prints usage block, exits 0)

$ node scripts/verify-n8n-decommissioned.mjs --help
(prints usage block, exits 0)

$ unset RDS_URL && node scripts/verify-n8n-decommissioned.mjs --skip-ssh --port 1 --host 127.0.0.1
[SKIP] systemd  skipped (--skip-ssh)
[PASS] port     127.0.0.1:1 → ECONNREFUSED — port closed cleanly (no listener)
[FAIL] audit    RDS_URL env var missing — cannot read event_log

Summary: 1/2 PASS  (1 failed)
$ echo $?
1
(exit code 1 on partial fail — correct behavior)
```

## Operator-deferred items

These are intentionally NOT done by this run; runbook documents each:

1. **Phase 4 Gate 3 PASS** — hard prereq, run `verify-gate-3.mjs`
   before any T-0 step.
2. **`MigrationStack` deployment** — must be deployed before the
   Lambda fn name + bucket name + KMS key arn can be resolved.
3. **SSH key access** to `kevin@98.91.6.66`.
4. **AWS CLI auth** for `aws lambda invoke`.
5. **AWS-side port probe** (P-07 mitigation second source).
6. **UFW firewall closure of port 5678** — owned by Plan 10-06.

## What was NOT done

- No `git add`, `git commit`, `git push` (per user dispatch).
- No archiver Lambda code changes (already shipped in Phase 10-00).
- No CDK / Terraform / cloud touches.
- No real n8n REST hits (script syntax + --help only).
- No SSH to the VPS.
- No `event_log` writes against any real RDS (--skip-ssh + missing
  RDS_URL was the only runtime smoke-test).

## Risks / follow-ups

1. **n8n `/rest/credentials` may return 401 on auth-protected n8n
   instances.** Per the user dispatch, the VPS n8n is unauthenticated
   on port 5678, so this should be a non-issue, but the snapshot
   script handles 401 gracefully (warns, continues with empty
   credential list).

2. **Lambda invocation via `aws` CLI** instead of `@aws-sdk/client-lambda`
   keeps the script dependency-free (no `pnpm install` requirement at
   the root). The trade-off is the operator must have AWS CLI v2
   configured, but the `retire-vps-script.sh` pattern already assumes
   AWS CLI access.

3. **Archive-before-destroy gate uses a 15-minute window** for the
   `snapshot-ok` row freshness check. If the operator splits the
   snapshot from the destroy by >15 min (e.g. snapshot today, decom
   tomorrow), the gate will fail. This is intentional — a stale
   snapshot is dangerous because n8n workflows may have changed
   since. Override would require editing the SQL.

4. **The verifier's port check accepts `ETIMEDOUT` as PASS** to
   accommodate firewall DROP scenarios. If a network glitch causes a
   genuine timeout against a still-running n8n, the verifier could
   false-positive. Mitigation: the runbook's two-source step (operator
   network + AWS CloudShell `nc`) catches this.

5. **`snapshot-n8n-workflows.mjs` uses `psql` via `spawnSync` for
   audit rows** rather than the `pg` library — same rationale as #2
   (zero-deps script). The `retire-vps-script.sh` uses the same
   pattern.

End of agent notes.
