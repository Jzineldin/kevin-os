---
phase: 10-migration-decommission
plan: 10-06
artifact: retirement-runbook
audience: operator (Kevin)
duration_estimate: 10 min T-0 + 30 min passive + 5 min T+30m verification
---

# 10-06 Retirement Runbook — 4 Unfrozen VPS Scripts

This runbook walks the operator (Kevin) through the **retirement** of the
four UNFROZEN Hetzner VPS systemd units that Phase 10 Plan 10-06 retires:

| # | Unit | Retirement category | Replacement |
|---|------|--------------------|-------------|
| 1 | `brain-server.service`         | inert    | Phase 3 dashboard relay (Vercel Next.js + dashboard-listen-relay Fargate task + RelayProxy Lambda) |
| 2 | `gmail-classifier.service`     | replaced | Phase 4 email-triage Lambda (CDK construct `EmailTriageAgent`) |
| 3 | `brain-dump-listener.service`  | replaced | Phase 5 + Plan 10-04 Discord brain-dump Lambda (CDK construct `DiscordBrainDump`) |
| 4 | `sync-aggregated.service`      | inert    | none — aggregation handled by KOS triage + agents |

**Scope:** UNFROZEN scripts only. The 3 frozen scripts
(`classify_and_save`, `morning_briefing`, `evening_checkin`) are retired
by Plans 10-01 + 10-02. n8n is retired by Plan 10-05. VPS power-down is
Plan 10-07.

**This plan does NOT execute the retirement** — it ships the verifier
(`scripts/verify-4-unfrozen-retired.mjs`) and this runbook. Kevin runs
the runbook at the Wave 3 gate after:

- Phase 4 Gate 3 PASS (email-triage proven; gmail_classifier prereq).
- Plan 10-04 7-day same-substance PASS in
  `scripts/verify-discord-brain-dump-substance.mjs` (brain-dump-listener prereq).
- Plan 10-02 morning + evening retirement signed off (so `retire-vps-script.sh`
  is known-good in operator hands).

The generic retire tool (`scripts/retire-vps-script.sh`) is reused
verbatim; this plan only adds verifiers + the per-unit replacement
mapping.

---

## Pre-retirement (T-24h to T-0)

### Step 0: Confirm replacement readiness

The retirement is safe ONLY if all three replacements are healthy.

#### 0a. Phase 3 dashboard relay (replaces brain_server)

```bash
# Confirm relay-proxy Lambda exists + is Active.
aws lambda get-function \
  --region eu-north-1 \
  --function-name KosIntegrations-RelayProxy \
  --query 'Configuration.State' --output text
# Expected: Active

# Confirm Vercel deployment is reachable.
curl -sS -o /dev/null -w '%{http_code}\n' \
  "${KOS_DASHBOARD_URL:-https://kos.kevinelzarka.com}"
# Expected: 200 (or 401 with bearer-token auth — anything that's not 5xx)
```

If either fails: STOP. The Phase 3 dashboard owns the brain_server
replacement; without it, retirement creates a UI gap.

#### 0b. Phase 4 email-triage (replaces gmail_classifier)

```bash
# Confirm Phase 4 Gate 3 evidence committed.
ls .planning/phases/04-integrations-agents/04-PHASE-GATE-3-evidence.md
# Expected: file exists, committed

# Confirm email-triage Lambda has run in past 24h (2h schedule).
aws logs filter-log-events \
  --region eu-north-1 \
  --log-group-name /aws/lambda/KosIntegrations-EmailTriageAgent \
  --start-time $(( ($(date +%s) - 24*3600) * 1000 )) \
  --max-items 1 \
  --query 'events[0].message' --output text
# Expected: any non-empty log line
```

If either fails: STOP. Re-run Phase 4 Gate 3 first.

#### 0c. Plan 10-04 Discord brain-dump (replaces brain-dump-listener)

```bash
# 7-day same-substance PASS — hard prereq per CAP-10.
node scripts/verify-discord-brain-dump-substance.mjs
# Expected: PASS for 7 consecutive days at ≥ 8/10 substance.

# Confirm DiscordBrainDump Lambda has run in past 1h (5min schedule).
aws logs filter-log-events \
  --region eu-north-1 \
  --log-group-name /aws/lambda/KosMigration-DiscordBrainDump \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --max-items 1 \
  --query 'events[0].message' --output text
# Expected: any non-empty log line (5-min schedule guarantees activity)
```

If either fails: **DO NOT proceed with brain-dump-listener retirement.**
The other 3 retirements (brain_server, gmail_classifier, sync_aggregated)
can still run independently. Skip Step 5 below and resume at Step 6.

### Step 1: Set RDS_URL for the audit-first invariant

```bash
export RDS_URL=$(aws secretsmanager get-secret-value \
  --region eu-north-1 \
  --secret-id kos/rds-admin-url \
  --query SecretString --output text)

# Sanity check:
psql "$RDS_URL" -c 'SELECT 1;' >/dev/null && echo OK || echo "RDS_URL bad"
```

If this fails, **STOP** — `scripts/retire-vps-script.sh` will refuse to
proceed and the systemd mutation cannot happen without an audit row.

### Step 2: Resolve the systemd unit names

Look in
`.planning/phases/10-migration-decommission/vps-service-inventory.json`
(populated by `scripts/discover-vps-scripts.sh` per D-14):

```bash
jq '.services[]
    | select(.unit_name|test("brain.server|gmail|brain.dump|sync.aggregated"))
    | .unit_name' \
   .planning/phases/10-migration-decommission/vps-service-inventory.json
```

Expected output (suffix `.service` or `.timer` may vary by host install):

```
"brain-server.service"
"gmail-classifier.service"
"brain-dump-listener.service"
"sync-aggregated.service"
```

If any of those report `.timer` instead of `.service`, set the matching
env var (e.g. `export GMAIL_CLASSIFIER_UNIT=gmail_classifier.timer`)
before invoking `retire-vps-script.sh` — that script accepts any
systemd unit name verbatim.

### Step 3: Dry-run all 4 retirements

```bash
bash scripts/retire-vps-script.sh \
  --unit brain-server.service \
  --replaced-by phase-3-dashboard-relay-proxy \
  --dry-run

bash scripts/retire-vps-script.sh \
  --unit gmail-classifier.service \
  --replaced-by phase-4-email-triage-agent \
  --dry-run

bash scripts/retire-vps-script.sh \
  --unit sync-aggregated.service \
  --replaced-by INERT-no-replacement \
  --dry-run

bash scripts/retire-vps-script.sh \
  --unit brain-dump-listener.service \
  --replaced-by phase-10-plan-04-discord-brain-dump \
  --dry-run
```

Each run prints the full SSH + psql sequence WITHOUT touching the VPS
or RDS. Copy the printed output into the `# DRY_RUN_EVIDENCE` section
at the bottom of this file before the real run.

---

## T-0 retirement (target window: < 10 minutes total)

The four units do not interact, so order does not technically matter.
**Order rationale:** retire the inert units first (lowest risk), then
the replaced units. brain-dump-listener is sequenced LAST because its
prereq (Plan 10-04 7-day same-substance PASS) is the most fragile.

### Step 4a: Retire `brain-server.service` (inert — Phase 3 supersedes)

```bash
bash scripts/retire-vps-script.sh \
  --unit brain-server.service \
  --replaced-by phase-3-dashboard-relay-proxy
```

Expected output:

```
[INFO] retire brain-server.service on kevin@98.91.6.66 — replaced_by=phase-3-dashboard-relay-proxy
[OK]  retired brain-server.service — replaced by phase-3-dashboard-relay-proxy
      journal log: .planning/phases/10-migration-decommission/retirement-logs/brain-server.service-<TS>.log
```

### Step 4b: Retire `sync-aggregated.service` (inert — no replacement)

```bash
bash scripts/retire-vps-script.sh \
  --unit sync-aggregated.service \
  --replaced-by INERT-no-replacement
```

### Step 4c: Retire `gmail-classifier.service` (replaced by Phase 4)

**Prereq check (re-confirm immediately before retiring):**

```bash
aws logs filter-log-events \
  --region eu-north-1 \
  --log-group-name /aws/lambda/KosIntegrations-EmailTriageAgent \
  --start-time $(( ($(date +%s) - 4*3600) * 1000 )) \
  --max-items 1 --query 'events[0].timestamp' --output text
```

Expected: a recent timestamp (< 4h old). If empty, abort: Phase 4
email-triage has not run on its expected 2h schedule.

```bash
bash scripts/retire-vps-script.sh \
  --unit gmail-classifier.service \
  --replaced-by phase-4-email-triage-agent
```

### Step 5: Retire `brain-dump-listener.service` (replaced by Plan 10-04)

**Hard prereq — run again immediately before:**

```bash
node scripts/verify-discord-brain-dump-substance.mjs
```

Expected: 7 consecutive days of ≥ 8/10 substantively-identical messages
between the legacy listener output and the Plan 10-04 Lambda output.
If the verifier returns ANY non-zero exit, **DO NOT PROCEED.**

```bash
bash scripts/retire-vps-script.sh \
  --unit brain-dump-listener.service \
  --replaced-by phase-10-plan-04-discord-brain-dump
```

`retire-vps-script.sh` does, in order, for each invocation:

1. Writes 2 rows to `event_log` (`vps-service-stopped` +
   `vps-service-disabled`) — audit-first per D-12.
2. `ssh kevin@98.91.6.66 'sudo systemctl stop <unit>'`.
3. Verifies `is-active` returns inactive.
4. `ssh kevin@98.91.6.66 'sudo systemctl disable <unit>'`.
5. `ssh kevin@98.91.6.66 'sudo systemctl mask <unit>'` — defensive lock
   so even a manual `start` refuses.
6. Captures `journalctl -u <unit> -n 50` to the retirement-logs dir.

After all four retirements complete, the VPS still holds the
`/opt/kos-vps/original/` rollback floor (Phase 1 D-14 artifact) — this
runbook's rollback section relies on that being untouched.

---

## T+30 minute verification

### Step 6: Run the consolidated verifier

```bash
node scripts/verify-4-unfrozen-retired.mjs
```

Expected (last line):

```
[OK] 4/4 unfrozen VPS scripts retired (16/16 checks PASS)
```

The five check classes:

| Check class | What it asserts | Per-service entries |
|-------------|-----------------|---------------------|
| `systemctl-active`   | `ssh ... systemctl is-active <unit>` returns inactive/failed/unknown | 4 |
| `systemctl-enabled`  | `ssh ... systemctl is-enabled <unit>` returns masked or disabled | 4 |
| `ps-clean`           | `ssh ... ps aux | grep <process_name>` returns 0 lines | 4 |
| `event_log`          | RDS `event_log` has ≥ 1 `vps-service-stopped` row per service in past 30d | 4 |
| `replacement`        | Replacement Lambda is Active + (where applicable) has logs ≤ 48h | 4 |

If any check FAILs, **do NOT proceed to power-down**. Diagnose the
specific check, fix, re-run.

### Step 7: Spot-check the replacements

```bash
# Phase 3 dashboard relay — open the dashboard in browser and confirm
# entity context loads. (Manual; no scripted check.)

# Phase 4 email-triage — confirm email-triage classifications appear in
# Notion's Email Triage board within 2h after a fresh inbound email.

# Plan 10-04 Discord brain-dump — write a test message to the Discord
# brain-dump channel; confirm a kos.capture event lands in EventBridge
# within 5min and a row appears in the Notion Inbox.
```

If any spot-check fails, follow the rollback procedure for that unit
(Step R1 below) and open an incident.

---

## Rollback (T-0 + 14-day window)

Trigger conditions:
- Verifier (Step 6) reports any FAIL within 24h.
- Manual spot-check (Step 7) fails for any replacement.
- Sentry exception count for any replacement Lambda spikes within 24h.
- Kevin notices missing data in the dashboard, Notion, or Inbox over 24h.

### Rollback Step R1: Restore the legacy unit(s)

```bash
bash scripts/retire-vps-script.sh --undo --unit brain-server.service
# and/or:
bash scripts/retire-vps-script.sh --undo --unit gmail-classifier.service
# and/or:
bash scripts/retire-vps-script.sh --undo --unit brain-dump-listener.service
# and/or:
bash scripts/retire-vps-script.sh --undo --unit sync-aggregated.service
```

The `--undo` flag does, in order:
1. Writes a `vps-service-disabled` row to `event_log` with
   `detail.action = 'restored'` (audit trail captures restoration
   without requiring a contract-enum change).
2. `ssh ... sudo systemctl unmask <unit>`.
3. `ssh ... sudo systemctl enable <unit>`.
4. `ssh ... sudo systemctl start <unit>`.
5. Re-checks `is-active` and warns if not yet active.

### Rollback Step R2: Leave replacements running

Do NOT disable the Phase 3 dashboard, Phase 4 email-triage, or Plan
10-04 Discord brain-dump Lambdas. They continue to run alongside the
restored VPS scripts during the rollback window. Both write to
different downstream destinations (e.g., gmail_classifier → Notion
Legacy Inbox; email-triage → Notion Email Triage board), so there is
no dual-write conflict.

### Rollback Step R3: Open an incident ticket

In `.planning/phases/10-migration-decommission/INCIDENTS.md` (create
if absent), append:
- Cutover transcript (Step 4/5 output captured at T-0).
- Suspected regression (Sentry ID, CloudWatch log link, or "no
  email-triage row in Notion").
- Rollback acknowledgement timestamp + which units were restored.

The Phase 10 power-down (Plan 10-07) does NOT proceed until the
regression is diagnosed and the retirement is retried with green
verification.

(After Plan 10-07 power-down, VPS is off; rollback requires Hetzner
snapshot restore — see `10-ROLLBACK-RUNBOOK.md`.)

---

## Day 14 gate (closes Plan 10-06)

After 14 consecutive days of:
- All 4 retired units staying `inactive` + `masked` (verifier daily PASS).
- Phase 3 dashboard healthy (no Sentry spikes).
- Phase 4 email-triage firing on its 2h schedule with email-triage rows
  in Notion.
- Plan 10-04 Discord brain-dump firing on its 5min schedule with
  capture events flowing.

Kevin signs off in `.planning/phases/10-migration-decommission/MIG-01-SIGNOFF.md`
with:

```
2026-MM-DD: brain_server + gmail_classifier + brain-dump-listener +
            sync_aggregated retirement signed off.
            14 consecutive verifier PASS days; 0 replacement Sentry
            exceptions; 0 missing-data incidents.
            Next: Plan 10-07 power-down dependency-chain unblocks 14
            days after the last retirement (D-16 cold-failover window).
```

---

## DRY_RUN_EVIDENCE

After Step 3 dry-runs, paste the transcript below for the gate audit:

```
# DRY_RUN_EVIDENCE: <paste --dry-run output for all four units here>
```

This placeholder MUST be filled before Step 4/5 real retirement runs.

---

## Cross-references

- Plan 10-06 PLAN: `.planning/phases/10-migration-decommission/10-06-PLAN.md`
- Plan 10-02 RUNBOOK (frozen scripts; reuses `retire-vps-script.sh`):
  `10-02-RETIREMENT-RUNBOOK.md`
- Plan 10-04 PLAN (Discord brain-dump prereq): `10-04-PLAN.md`
- Plan 10-07 power-down: `10-07-PLAN.md` + `10-07-POWER-DOWN-RUNBOOK.md`
- Phase 3 dashboard: `apps/dashboard/` + `services/dashboard-listen-relay/`
- Phase 4 email-triage: `services/email-triage/`
- Plan 10-04 Discord brain-dump: `services/discord-brain-dump/`
- Generic retire tool: `scripts/retire-vps-script.sh`
- VPS service inventory: `vps-service-inventory.json` (operator-populated)
- Master rollback runbook: `10-ROLLBACK-RUNBOOK.md`
