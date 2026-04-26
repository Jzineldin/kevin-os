---
phase: 10-migration-decommission
plan: 10-05
artifact: decommission-runbook
audience: operator (Kevin)
duration_estimate: 10 min T-0 + 5 min T+1m verification
---

# 10-05 Decommission Runbook — n8n on Hetzner VPS port 5678

This runbook walks the operator (Kevin) through the **archive-then-stop**
decommissioning of the unauthenticated n8n daemon running on the Hetzner
VPS port 5678 — the most likely source of the Telegram-webhook
auto-clear behaviour catalogued in
`.planning/debug/resolved/telegram-webhook-auto-clear.md`. n8n is also
the only Phase-10 service whose REST endpoint is exposed without
authentication, so closing it solves a security exposure even if the
Telegram theory turns out to be wrong.

**Scope:** the n8n systemd unit only. UFW firewall closure of port 5678
is NOT done by this runbook — it is owned by Plan 10-06's full
firewall-tightening pass after every VPS service is retired. Stage 7's
external port probe will return `ECONNREFUSED` once the n8n process is
gone (no listener), which is sufficient closure for this plan.

**This runbook does NOT execute the decom** — it ships three scripts
plus this document. Kevin runs the runbook at the Wave 3 gate after
Plan 10-02 (morning + evening retire) is GREEN and Phase 4 Gate 3
(email-triage parity) is GREEN.

**Hard prerequisite:** Phase 4 Gate 3 PASS. If any n8n workflow is the
only path delivering an email-classification function that
`services/email-triage` has not yet replaced, archival + shutdown will
lose the function. Inspect the snapshot output during Stage 1 of the
dry-run before signing off on the real run.

---

## Tooling shipped by this plan

| File | Purpose |
|------|---------|
| `scripts/decommission-n8n.sh` | 7-stage operator orchestration (discover → snapshot → confirm → stop → disable → audit → verify). |
| `scripts/snapshot-n8n-workflows.mjs` | Fetches every n8n workflow + credential metadata over SSH tunnel, invokes the `n8n-workflow-archiver` Lambda, writes `event_log` rows. |
| `scripts/verify-n8n-decommissioned.mjs` | Three-check post-decom verifier: systemctl, port probe, audit-row ordering. |
| `services/n8n-workflow-archiver/` | Lambda from Phase 10-00 that owns canonical-JSON + SHA-256 + KMS-encrypted PutObject. Reused unchanged. |

The archive-before-destroy invariant is enforced in two places:
1. `decommission-n8n.sh` Stage 2 must succeed before Stage 4 stops the daemon.
2. `decommission-n8n.sh` reads `event_log` for a recent `snapshot-ok` row
   between Stage 2 and Stage 3; if missing, the script aborts.

---

## Pre-decom (T-24h to T-0)

### Step 0 — Confirm Phase 4 Gate 3 is PASS (hard prereq)

```bash
node scripts/verify-gate-3.mjs
```

Expected: `Summary: N/N PASS`. If any check FAILs, **STOP**. Email
triage parity must be confirmed before n8n's Telegram trigger nodes can
be safely retired (which is what archive + stop achieves). Open an
incident in `INCIDENTS.md` and re-run Phase 4 Gate 3.

### Step 1 — Confirm Plan 10-02 is GREEN

`morning_briefing` + `evening_checkin` retirement signed off in
`MIG-01-SIGNOFF.md` (or this run is a fast-path appended to that
session). Without 10-02 GREEN, the operator hasn't proven the
retire pattern works against the same VPS host.

### Step 2 — Set RDS_URL for the audit-first invariant

```bash
export RDS_URL=$(aws secretsmanager get-secret-value \
  --region eu-north-1 \
  --secret-id kos/rds-admin-url \
  --query SecretString --output text)

# Sanity:
psql "$RDS_URL" -c 'SELECT 1;' >/dev/null && echo OK || echo "RDS_URL bad"
```

If this fails, **STOP** — `snapshot-n8n-workflows.mjs` and
`decommission-n8n.sh` both refuse to run without it (audit-first
invariant per D-12).

### Step 3 — Resolve the n8n systemd unit name

The unit name is canonically `n8n.service` but check
`vps-service-inventory.json`:

```bash
jq '.services[] | select(.unit_type=="n8n-daemon") | .unit_name' \
   .planning/phases/10-migration-decommission/vps-service-inventory.json
```

If the inventory shows a different name (`n8n@kevin.service`,
`docker-n8n.service`, etc.), pass `--unit <actual>` to the script.

### Step 4 — Resolve the Lambda function name + KMS key + bucket

The Phase 10-00 `MigrationStack` has been deployed and exposes the
following CloudFormation outputs:

```bash
aws cloudformation describe-stacks --stack-name KosMigration \
  --region eu-north-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`MigrationArchiveBucketName`].OutputValue' \
  --output text
# → kos-migration-archive-XXXXXXXX

aws lambda list-functions --region eu-north-1 \
  --query 'Functions[?starts_with(FunctionName, `KosMigration`) && contains(FunctionName, `N8nWorkflowArchiver`)].FunctionName' \
  --output text
# → KosMigration-N8nWorkflowArchiver-XXXX

aws kms list-aliases --region eu-north-1 \
  --query 'Aliases[?starts_with(AliasName, `alias/KosMigration`)].TargetKeyId' \
  --output text
# → <key-uuid>
```

Export them:

```bash
export ARCHIVE_BUCKET_NAME=kos-migration-archive-XXXXXXXX
export N8N_ARCHIVER_FN=KosMigration-N8nWorkflowArchiver-XXXX
export KMS_KEY_ID=arn:aws:kms:eu-north-1:XXXXXXXX:key/<key-uuid>
```

### Step 5 — Dry-run the orchestration

```bash
bash scripts/decommission-n8n.sh --dry-run
```

The dry-run prints every SSH command, every psql command, the snapshot
script invocation, the confirmation prompt, the systemctl mutations,
the n8n-stopped audit row INSERT, and the verifier invocation —
**without touching the VPS, Lambda, S3, RDS, or running the verifier**.

Paste the dry-run output into the `# DRY_RUN_EVIDENCE` section at the
bottom of this file. Review especially the snapshot stage block — if
the operator network can't reach the VPS or the AWS CLI is misconfigured,
the dry-run output of the env-validation block surfaces it before T-0.

---

## T-0 decommission (target: < 10 minutes total)

### Step 6 — Execute the orchestration

```bash
bash scripts/decommission-n8n.sh
```

The script will, in order:

| Stage | What it does | Audit |
|-------|--------------|-------|
| 1 DISCOVER | `ssh systemctl is-active n8n.service` | none |
| 2 SNAPSHOT | open SSH tunnel localhost:15678 → VPS:5678; run `snapshot-n8n-workflows.mjs` which fetches `/rest/workflows` + `/rest/workflows/<id>` per id + `/rest/credentials` (names only); invoke `n8n-workflow-archiver` Lambda | `event_log` rows: `n8n-workflows-archived` action=`snapshot-begin`, then action=`snapshot-ok` |
| 3 CONFIRM | interactive prompt: type `decom` to proceed | none |
| 4 STOP | `ssh sudo systemctl stop n8n.service` + verify is-active != active | none |
| 5 DISABLE | `ssh sudo systemctl disable n8n.service` + `ssh sudo systemctl mask n8n.service` | none |
| 6 AUDIT | `psql INSERT event_log kind='n8n-stopped' detail.action='stop+disable+mask'` | `event_log` row written here |
| 7 VERIFY | invokes `verify-n8n-decommissioned.mjs` | reads event_log, does not write |

The script enforces the **archive-before-destroy** invariant by reading
back the `snapshot-ok` row from `event_log` between Stage 2 and Stage 3.
If that row is missing, the script aborts before the confirmation gate.

Expected final output:

```
[OK] n8n decommissioned — port 5678 closed, n8n.service masked, audit trail complete
     Next: T+1min Telegram webhook re-test (see runbook)
```

If the user types anything other than `decom` at the Stage 3 prompt,
the script exits 3 with no destructive action taken — the snapshot is
already in S3 and the audit rows are present, so the run can be
resumed later.

---

## T+1min — Telegram webhook re-test (rogue-caller closure)

This is the **rogue-caller hypothesis closure** step. If n8n was the
caller clearing the Telegram webhook, the URL should now persist
indefinitely.

### Step 7 — Re-register the Telegram webhook

```bash
node scripts/register-telegram-webhook.mjs
```

### Step 8 — Wait 60 seconds, then verify persistence

```bash
sleep 60
node scripts/verify-telegram-webhook-persistence.mjs   # ships in Plan 10-07 Task 4
```

(If Plan 10-07 verifier isn't shipped yet, do the manual probe:
`curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq '.result.url'`
and confirm the URL matches the one you registered.)

| Outcome | Interpretation |
|---------|----------------|
| URL persists for >5 min | rogue-caller hypothesis CLOSED — n8n was the culprit. Document in `.planning/debug/resolved/telegram-webhook-auto-clear.md`. |
| URL clears within 5 min | rogue caller is on a different VPS script (await Plan 10-06's broader retirement) or off-VPS (escalate per debug doc). |

Either outcome is informative; only the URL-clears branch leaves the
question open.

---

## T+5min — Final verification

### Step 9 — Re-run the verifier

```bash
node scripts/verify-n8n-decommissioned.mjs
```

Expected: `Summary: 3/3 PASS  (0 failed)` with all three checks GREEN:

| Check | Expected |
|-------|----------|
| systemd | `is-active=inactive is-enabled=masked` |
| port    | `98.91.6.66:5678 → ECONNREFUSED — port closed cleanly` |
| audit   | `snapshot-ok @ <ts1>  <  n8n-stopped @ <ts2> (archive-before-destroy OK)` |

### P-07 mitigation — two-source port probe

The `verify-n8n-decommissioned.mjs` port check runs from the operator's
machine. If the operator's network sits behind the same upstream as
Hetzner (e.g. Kevin probes from a Stockholm coffee shop whose ISP
peers via the same backbone), an upstream firewall could mask a
still-running n8n with a fake `ECONNREFUSED`. To rule this out, do the
AWS-side cross-check:

```bash
# From any AWS CloudShell session (different network than operator laptop):
nc -zv -w 5 98.91.6.66 5678   # expect: Connection refused
```

A second `Connection refused` from a different network confirms the
process is truly dead, not just unreachable from one path.

### Step 10 — Sign off

In `MIG-01-SIGNOFF.md` append:

```
2026-MM-DD: n8n decommissioned (Plan 10-05).
            Workflows archived: <N> @ s3://<bucket>/<prefix>/
            event_log rows: snapshot-ok @ <ts1>; n8n-stopped @ <ts2>.
            External probe ECONNREFUSED from operator + AWS.
            Telegram webhook URL persisted for >5 min after T-0  → rogue-caller CLOSED.
            (or: Telegram webhook still clears  → escalating to Plan 10-06.)
```

---

## Rollback (within 1h of decom)

The S3 archive at `s3://<bucket>/<prefix>/` is your restore source.
Each archived blob is a valid n8n workflow JSON.

### Rollback Step R1 — Restart n8n

```bash
ssh kevin@98.91.6.66 'sudo systemctl unmask n8n.service'
ssh kevin@98.91.6.66 'sudo systemctl enable n8n.service'
ssh kevin@98.91.6.66 'sudo systemctl start n8n.service'
ssh kevin@98.91.6.66 'systemctl is-active n8n.service'
# expect: active
```

### Rollback Step R2 — Restore workflows from archive

```bash
# List archived workflows:
aws s3 ls s3://${ARCHIVE_BUCKET_NAME}/archive/n8n-workflows/

# Download a workflow:
aws s3 cp s3://${ARCHIVE_BUCKET_NAME}/archive/n8n-workflows/<id>.json /tmp/wf.json

# Re-import into n8n via REST (port 5678 is back up):
ssh -L 15678:localhost:5678 kevin@98.91.6.66 -N -f
curl -X POST -H 'Content-Type: application/json' \
     -d @/tmp/wf.json \
     http://localhost:15678/rest/workflows
```

### Rollback Step R3 — Document the rollback

Append a row to `event_log` with `kind='vps-service-disabled'`
`detail.action='restored'` (matching the pattern from
`retire-vps-script.sh --undo`) so the audit trail captures both
directions:

```bash
psql "$RDS_URL" -c "INSERT INTO event_log(owner_id,kind,detail,actor) VALUES ('kevin','vps-service-disabled','{\"unit\":\"n8n.service\",\"action\":\"restored\",\"reason\":\"<why>\"}'::jsonb,'operator-manual-rollback');"
```

### Rollback > 1h — Hetzner snapshot restore

If more than 1h has elapsed and any n8n state-on-disk has been mutated
since stop (unlikely since the unit is masked, but possible if a stray
process touched the data dir), see
`.planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md` for
the Hetzner snapshot restore procedure.

---

## Operator-deferred items

These are intentionally NOT done by this runbook and need separate ops
work:

1. **Phase 4 Gate 3 PASS** — hard prereq, run `verify-gate-3.mjs` before
   Step 0 above.
2. **`MigrationStack` deployment** — must be deployed before Step 4 can
   resolve real bucket / key / Lambda names.
3. **SSH key access to `kevin@98.91.6.66`** — assumed. The script uses
   `~/.ssh/id_ed25519` by default; override with `SSH_KEY_PATH`.
4. **AWS CLI auth** — `aws lambda invoke` and `aws cloudformation
   describe-stacks` need valid creds. Assume `aws sso login --profile
   kos-prod` is current.
5. **AWS-side port probe** — operator must run the
   `nc -zv 98.91.6.66 5678` from CloudShell as the second source for
   the P-07 mitigation. Not automated.
6. **UFW firewall closure of port 5678** — owned by Plan 10-06's
   firewall pass. With n8n masked, the port has no listener anyway, so
   the security exposure is closed at process level.

---

## DRY_RUN_EVIDENCE

After Step 5 dry-run, paste the transcript below for the gate audit:

```
# DRY_RUN_EVIDENCE: <paste --dry-run output here>
```

This placeholder MUST be filled before Step 6 real run.

---

## Cross-references

- Plan 10-05 PLAN: `.planning/phases/10-migration-decommission/10-05-PLAN.md`
- Phase 10-00 archiver Lambda: `services/n8n-workflow-archiver/`
- Plan 10-02 retirement runbook: `10-02-RETIREMENT-RUNBOOK.md`
- Generic retire tool: `scripts/retire-vps-script.sh` (pattern this runbook follows)
- Telegram-webhook auto-clear debug: `.planning/debug/resolved/telegram-webhook-auto-clear.md`
- Master rollback: `10-ROLLBACK-RUNBOOK.md`
- Phase 4 Gate 3 verifier: `scripts/verify-gate-3.mjs`
- Phase 10 power-down: `10-07-POWER-DOWN-RUNBOOK.md` (uses the same `event_log` audit table)
