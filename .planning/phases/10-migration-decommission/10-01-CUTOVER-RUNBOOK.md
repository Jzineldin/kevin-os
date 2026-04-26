---
phase: 10-migration-decommission
plan: 10-01
artifact: cutover-runbook
audience: operator (Kevin)
duration_estimate: 30 minutes (T-0 cutover) + 7 days passive (verification window)
---

# 10-01 Cutover Runbook — VPS classify_and_save → Lambda Function URL

This runbook walks the operator (Kevin) through the **atomic switchover**
from the legacy Hetzner VPS `classify_and_save.py` webhook to the new
KOS-side Lambda Function URL, plus the T+30min rollback plan if SC 1
regresses.

**Scope:** classify_and_save only. `morning_briefing` and `evening_checkin`
follow Plan 10-02. Brain DB archival follows Plan 10-03. n8n + power-down
follow Plans 10-05 and 10-07.

**Pre-conditions:**
- Plan 10-00 scaffold deployed (`KosMigration` CDK stack synthed + Function
  URL is reachable but rejecting traffic with `PLACEHOLDER` HMAC).
- Plan 10-01 Tasks 1+2 complete (handler implementation passing 32/32 tests
  + verifier script `node --check` clean).
- Phase-1 freeze still in effect on the VPS (legacy script writes every
  payload to Notion Legacy Inbox with `[MIGRERAD]` marker — preserved as
  the "ground truth" the verifier compares against).

---

## Pre-cutover (T-24h to T-0)

### Step 1: CDK deploy the migration stack

```bash
pnpm --filter @kos/cdk synth KosMigration
pnpm --filter @kos/cdk deploy KosMigration
```

Capture the output `VpsClassifyMigrationUrl`:

```
KosMigration.VpsClassifyMigrationUrl = https://<id>.lambda-url.eu-north-1.on.aws/
```

Store this URL — every subsequent step needs it.

### Step 2: Seed `kos/vps-classify-hmac-secret`

The CDK stack creates the secret with placeholder value `PLACEHOLDER`. The
Lambda fail-closes on that value so we MUST rotate it before flipping
upstream traffic.

```bash
SECRET=$(openssl rand -hex 32)
aws secretsmanager put-secret-value \
  --region eu-north-1 \
  --secret-id kos/vps-classify-hmac-secret \
  --secret-string "$SECRET"
echo "$SECRET" > .secrets/vps-classify-hmac.txt   # local-only; do NOT commit
```

The same secret value is required on the VPS-side caller (Step 3) so its
signed payloads validate at the Lambda. **Do not log this value in CI.**

### Step 3: Paste the HMAC secret into the VPS-side caller

```bash
ssh kevin@98.91.6.66
sudo vi /etc/kos-freeze.env       # add: VPS_CLASSIFY_HMAC_SECRET=<from-step-2>
sudo vi /etc/kos-freeze.env       # add: KOS_CLASSIFY_LAMBDA_URL=<from-step-1>
sudo systemctl daemon-reload
sudo systemctl restart classify_and_save.service   # picks up new env
```

If the unit name differs from `classify_and_save.service`, look it up in
the operator-populated `.planning/phases/10-migration-decommission/vps-service-inventory.json`
(produced by `scripts/discover-vps-scripts.sh` per D-14).

### Step 4: Pre-flight curl

Local terminal:

```bash
TS=$(date +%s)
BODY='{"title":"healthcheck","is_duplicate":false}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -i -X POST "$LAMBDA_URL" \
  -H "Authorization: Bearer $SECRET" \
  -H "X-KOS-Signature: t=$TS,v1=$SIG" \
  -H 'content-type: application/json' \
  -d "$BODY"
```

Expected:
```
HTTP/2 202
content-type: application/json
{"capture_id":"01HX...","emitted_at":"2026-04-25T07:00:00.000Z","source":"vps-classify-migration-adapter","adapter_version":"10-01-v1"}
```

Then verify the EventBridge bus saw it:

```bash
aws logs tail /aws/lambda/KosMigration-VpsClassifyMigration... --since 5m --region eu-north-1
```

# DRY_RUN_EVIDENCE:
# (operator pastes the curl 202 + CloudWatch grep transcript here for the gate audit)

---

## T-0 cutover (target window: < 30 seconds)

The cutover IS the moment when upstream callers (n8n / cron / whatever
fired the legacy webhook) start hitting the Lambda Function URL instead of
the VPS-side script. The VPS-side `classify_and_save.py` MUST be stopped at
the same moment to satisfy the no-dual-write invariant (D-23).

### Step 5: Stop the VPS-side classify unit

```bash
ssh kevin@98.91.6.66 'sudo systemctl stop classify_and_save.service'
```

### Step 6: Flip the upstream caller's webhook URL

The actual upstream caller is one of:

- **n8n** (port 5678 on the VPS) — edit the webhook node's URL inside the n8n UI.
- **A cron / scheduler** that POSTs via `curl` — edit `/etc/cron.d/<unit>`
  to point `curl -X POST <new-url>`.
- **An external SaaS webhook** — edit the SaaS's outbound webhook URL.

Operator-known: the upstream caller for classify is documented in the
operator-populated `vps-service-inventory.json`. If unsure, run
`scripts/discover-vps-scripts.sh` and grep for `classify`.

### Step 7: Local health check

```bash
node scripts/verify-classify-lambda-health.mjs   # 5 test POSTs over 30s
```

(Note: this script lands in Plan 10-07's verification suite. For Plan 10-01
cutover use Step 4's curl loop manually 5 times instead.)

---

## T+5min verification

### Step 8: Run the same-substance verifier on last 5 minutes

```bash
node scripts/verify-classify-substance.mjs --script classify --since "$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S)" --dry-run
```

`--dry-run` here because we want to inspect the new-vs-legacy pairs WITHOUT
calling Vertex Gemini (saves $0.05 per pair when we know there's almost no
data yet). Spot-check Kevin's Notion Command Center for new rows from the
adapter — they should appear under `[MIGRERAD]`-prefixed titles, but if
the freeze is still active on the VPS and we just stopped that script,
NEW rows may stop arriving entirely until the upstream caller is fully
flipped (Step 6).

If 0 rows arrive in T+5min, the upstream caller flip didn't take. Re-check Step 6.

---

## Rollback at T+30min if SC 1 regression

Trigger conditions:
- Any 500 from the Lambda (CloudWatch logs).
- Any pair from `verify-classify-substance.mjs` flagged < 0.5 (Gemini score).
- Kevin notices a missing capture in the dashboard within the first hour.

### Rollback Step R1: Flip the upstream caller URL back

```bash
# UNDO Step 6 — point the upstream back at the legacy VPS endpoint
# (n8n UI / cron / SaaS dashboard, depending on your caller).
```

### Rollback Step R2: Restart the VPS classify unit

```bash
ssh kevin@98.91.6.66 'sudo systemctl start classify_and_save.service'
```

The Phase-1 freeze redirect is still in place on disk (Plan 04-`SAFEKEEPING`)
so the restarted unit writes new payloads back to the Notion Legacy Inbox
with `[MIGRERAD]` markers — safe.

### Rollback Step R3: Leave the Lambda running

Per the reversibility floor (Locked #12 from STATE.md), do NOT delete the
`KosMigration` stack. The Lambda sits idle (zero invocations) waiting for
the operator to re-attempt the cutover after the regression is diagnosed.

### Rollback Step R4: Open an incident ticket

In `.planning/phases/10-migration-decommission/INCIDENTS.md` (create if
absent), append a row with:
- Cutover transcript (Step 4 curl output, Step 7 health check, Step 8 report)
- Suspected regression (Sentry exception ID, CloudWatch log link, or Gemini
  drift summary)
- Rollback acknowledgement timestamp

The 14-day decom timeline pauses; Plan 10-07 power-down does NOT happen
until SC 1 is back to green.

---

## Day 7 gate

`scripts/verify-classify-substance.mjs --script classify` produces the
report at:

```
.planning/phases/10-migration-decommission/10-01-substance-report-classify-<date>.md
```

Kevin reviews:
- Summary table — all 10 pairs with Gemini score + verdict.
- Operator hand-review checklist — Kevin marks each pair PASS or FAIL +
  free-form note.

**Gate criterion:** 10/10 PASS = SC 1 closed for classify_and_save.

If any FAIL: open an incident, hold Plan 10-07 power-down, diagnose, fix,
re-run the 7-day window. **Never** ship the power-down with even one open
SC 1 FAIL — the rollback floor (Hetzner snapshot) is the only fallback at
that point and we want it untouched.

---

## DRY_RUN_EVIDENCE

After the operator completes a dry-run rehearsal of this runbook (no real
cutover, just walk-through), paste the transcript below for gate audit:

```
# DRY_RUN_EVIDENCE: <paste curl + CDK + ssh transcripts here>
```

This placeholder MUST be filled before the T-0 real cutover proceeds.

---

## Cross-references

- Plan 10-01 PLAN: `.planning/phases/10-migration-decommission/10-01-PLAN.md`
- Plan 10-02 (morning_briefing/evening_checkin retire): `10-02-PLAN.md`
- Plan 10-07 (power-down): `10-07-PLAN.md`
- Phase 1 freeze redirect: `services/vps-freeze-patched/classify_and_save.py`
- VPS service inventory: `vps-service-inventory.json` (operator-populated)
- Roll-back master runbook: `10-ROLLBACK-RUNBOOK.md`
