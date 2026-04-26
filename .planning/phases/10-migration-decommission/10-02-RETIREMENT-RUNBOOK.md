---
phase: 10-migration-decommission
plan: 10-02
artifact: retirement-runbook
audience: operator (Kevin)
duration_estimate: 5 min T-0 + 2h passive + 5 min T+2h verification
---

# 10-02 Retirement Runbook — `morning_briefing.py` + `evening_checkin.py`

This runbook walks the operator (Kevin) through the **retirement** of the
two Hetzner VPS systemd units that Phase 7 AUTO-01 (morning-brief) and
AUTO-03 (day-close) Lambdas already replace, plus the rollback procedure
if either replacement misbehaves in the first 24h.

**Scope:** `morning_briefing.py` and `evening_checkin.py` only. The
`classify_and_save.py` retirement is appended (optional) once Plan
10-01's 1-hour soak is clean. Brain DB archival follows Plan 10-03.
n8n + power-down follow Plans 10-05 and 10-07.

**This plan does NOT execute the retirement** — it ships the tooling
(`scripts/retire-vps-script.sh`, two verifier scripts) and this runbook.
Kevin runs the runbook at the Wave 1 gate after Phase 7 is deployed and
verified.

---

## Pre-retirement (T-24h to T-0)

### Step 0: Confirm Phase 7 is healthy

The retirement is safe ONLY if AUTO-01 + AUTO-03 are firing on schedule
and writing to the Daily Brief Log every weekday.

1. Open Notion → "Daily Brief Log" DB.
2. Filter by `Type ∈ {morning, day-close}` and last 7 days.
3. Confirm at least one `morning` row Mon-Fri at ~08:05 Stockholm AND
   at least one `day-close` row Mon-Fri at ~18:05 Stockholm.

If either is missing for >2 weekdays in a row, **STOP**. Open an
incident — Phase 7 must be re-verified before retiring the legacy.

### Step 1: Confirm Plan 10-01 Wave 1 cutover is clean (optional)

Only required if you're appending `classify_and_save` to this same
retirement run. Check Plan 10-01 `10-01-CUTOVER-RUNBOOK.md` Step 8 has a
1-hour soak transcript pasted under `# DRY_RUN_EVIDENCE`.

If `classify_and_save` is NOT being retired this run, skip to Step 2.

### Step 2: Set RDS_URL for the audit-first invariant

```bash
export RDS_URL=$(aws secretsmanager get-secret-value \
  --region eu-north-1 \
  --secret-id kos/rds-admin-url \
  --query SecretString --output text)
```

Sanity check:

```bash
psql "$RDS_URL" -c 'SELECT 1;' >/dev/null && echo OK || echo "RDS_URL bad"
```

If this fails, **STOP** — `scripts/retire-vps-script.sh` will refuse to
proceed and the systemd mutation cannot happen without an audit row.

### Step 3: Resolve the systemd unit name

Look in
`.planning/phases/10-migration-decommission/vps-service-inventory.json`
(populated by `scripts/discover-vps-scripts.sh` per D-14):

```bash
jq '.services[] | select(.unit_name|test("morning_briefing|evening_checkin")) | .unit_name' \
   .planning/phases/10-migration-decommission/vps-service-inventory.json
```

Expected output:

```
"morning_briefing.service"
"evening_checkin.service"
```

If the inventory shows `.timer` or a different suffix, use the actual
name — `retire-vps-script.sh` accepts any systemd unit name.

### Step 4: Dry-run the retirement once per unit

```bash
bash scripts/retire-vps-script.sh \
  --unit morning_briefing.service \
  --replaced-by kos-morning-brief \
  --dry-run

bash scripts/retire-vps-script.sh \
  --unit evening_checkin.service \
  --replaced-by kos-day-close \
  --dry-run
```

Each run prints the full SSH + psql sequence WITHOUT touching the VPS
or RDS. Copy the printed output into the `# DRY_RUN_EVIDENCE` section
at the bottom of this file before the real run.

---

## T-0 retirement (target window: < 5 minutes total)

The two units fire on different schedules (`morning_briefing` 07:00 or
08:00, `evening_checkin` 18:00) and do not interact, so the retirement
order does not matter. Run them back-to-back.

### Step 5: Retire morning_briefing

```bash
bash scripts/retire-vps-script.sh \
  --unit morning_briefing.service \
  --replaced-by kos-morning-brief
```

Expected output (paraphrased):

```
[INFO] retire morning_briefing.service on kevin@98.91.6.66 — replaced_by=kos-morning-brief
[OK]  retired morning_briefing.service — replaced by kos-morning-brief
      journal log: .planning/phases/10-migration-decommission/retirement-logs/morning_briefing.service-<TS>.log
```

The script does, in order:
1. Writes 2 rows to `event_log` (`vps-service-stopped` + `vps-service-disabled`) — audit-first per D-12.
2. `ssh kevin@98.91.6.66 'sudo systemctl stop morning_briefing.service'`.
3. Verifies `is-active` returns inactive.
4. `ssh kevin@98.91.6.66 'sudo systemctl disable morning_briefing.service'`.
5. `ssh kevin@98.91.6.66 'sudo systemctl mask morning_briefing.service'` — defensive lock so even a manual `start` refuses.
6. Captures `journalctl -u morning_briefing.service -n 50` to the retirement-logs dir.

### Step 6: Retire evening_checkin

```bash
bash scripts/retire-vps-script.sh \
  --unit evening_checkin.service \
  --replaced-by kos-day-close
```

Same six-step sequence. After both retirements complete the VPS still
holds the `/opt/kos-vps/original/` rollback floor (Phase 1 D-14
artifact) — this runbook's rollback section relies on that being
untouched.

### Step 7: (Optional) retire classify_and_save

Only run this step if Plan 10-01 Wave 1 is GREEN and you want to
collapse all three retirements into one operator session:

```bash
bash scripts/retire-vps-script.sh \
  --unit classify_and_save.service \
  --replaced-by vps-classify-migration-lambda
```

Otherwise skip — Plan 10-01's own runbook owns the classify cutover.

---

## T+2h verification

Two passes — the AWS-side health and the Notion-side silence.

### Step 8: Verify Phase 7 + audit trail (AWS-side)

```bash
node scripts/verify-morning-evening-retired.mjs
```

Expected: `Summary: 6/6 PASS  (0 failed)` (or `5/6` if one log group
has no events in the past 48h because of a long weekend — re-run on
the next weekday).

The four checks:

| Check | What it asserts |
|-------|-----------------|
| scheduler:kos-morning-brief | EventBridge schedule `morning-brief-weekdays-08` is ENABLED with cron `(0 8 ? * MON-FRI *) Europe/Stockholm` |
| scheduler:kos-day-close     | EventBridge schedule `day-close-weekdays-18` is ENABLED with cron `(0 18 ? * MON-FRI *) Europe/Stockholm` |
| logs:morning-brief          | Lambda log group has at least one event in past 48h |
| logs:day-close              | Lambda log group has at least one event in past 48h |
| systemd:morning_briefing    | `ssh kevin@98.91.6.66 systemctl is-active` returns `inactive` |
| systemd:evening_checkin     | same |
| event_log:audit-rows        | RDS event_log contains `vps-service-stopped` rows for both units |

If any check FAILs, do NOT proceed to power-down. Diagnose the
specific check, fix, re-run.

### Step 9: Verify Legacy Inbox silence (Notion-side)

```bash
node scripts/verify-legacy-inbox-silent.mjs
```

Expected: `[OK]  Legacy Inbox silent — 0 new rows since T-0 across 2
retired source(s)`.

If it fails with `N new Legacy Inbox row(s) since retirement T-0`, the
VPS-side unit started writing again. Possible causes:
- Someone (or some scheduled task) ran `sudo systemctl unmask` +
  `start` after the retirement.
- A cron entry outside the systemd unit (e.g. `/etc/cron.d/...`) is
  still firing the underlying Python.
- A *second copy* of the freeze script (e.g. inside a docker container
  on the VPS) is alive.

Diagnose by:

```bash
ssh kevin@98.91.6.66 'systemctl is-active morning_briefing.service evening_checkin.service'
ssh kevin@98.91.6.66 'sudo crontab -l ; grep -r morning_briefing /etc/cron* 2>/dev/null'
ssh kevin@98.91.6.66 'docker ps 2>/dev/null | grep -i kos || true'
```

---

## Rollback (T-0 + 24h window)

Trigger conditions:
- AUTO-01 fails to fire by 08:30 Stockholm on the next weekday (no
  `morning` row in the Daily Brief Log).
- AUTO-03 fails to fire by 18:30 Stockholm on the next weekday.
- Either Lambda emits a Sentry exception in CloudWatch within the
  first 24h.
- Kevin notices a missing brief or end-of-day reflection in the
  dashboard.

### Rollback Step R1: Restore the legacy unit

```bash
bash scripts/retire-vps-script.sh --undo --unit morning_briefing.service
# and/or:
bash scripts/retire-vps-script.sh --undo --unit evening_checkin.service
```

The `--undo` flag does, in order:
1. Writes a `vps-service-disabled` row to `event_log` with
   `detail.action = 'restored'` (the audit trail captures restoration
   without requiring a contract-enum change).
2. `ssh ... sudo systemctl unmask <unit>`.
3. `ssh ... sudo systemctl enable <unit>`.
4. `ssh ... sudo systemctl start <unit>`.
5. Re-checks `is-active` and warns if not yet active.

The Phase 1 freeze script will resume writing to Notion Legacy Inbox
with `[MIGRERAD]` markers — this is **safe** (read-only redirection;
Brain DBs are still untouched).

### Rollback Step R2: Leave Phase 7 Lambdas running

Do NOT disable the EventBridge schedules. The Phase 7 Lambdas continue
to run alongside the restored VPS scripts during the rollback window.
Both write to different downstream destinations (Lambdas → Daily Brief
Log; VPS scripts → Legacy Inbox), so there is no dual-write conflict.

### Rollback Step R3: Open an incident ticket

In `.planning/phases/10-migration-decommission/INCIDENTS.md` (create
if absent), append:
- Cutover transcript (Step 5/6 output captured at T-0).
- Suspected regression (Sentry ID, CloudWatch log link, or "no brief
  in Daily Brief Log").
- Rollback acknowledgement timestamp + which units were restored.

The Phase 10 power-down (Plan 10-07) does NOT proceed until the
regression is diagnosed and the retirement is retried with green
verification.

---

## Day 7 gate (closes MIG-01 morning + evening parts)

After 7 consecutive days of:
- AUTO-01 firing at 08:00 Stockholm Mon-Fri with a Daily Brief Log row.
- AUTO-03 firing at 18:00 Stockholm Mon-Fri with a Daily Brief Log row.
- `verify-legacy-inbox-silent.mjs` returning 0 leaks each day.

Kevin signs off in `.planning/phases/10-migration-decommission/MIG-01-SIGNOFF.md`
with:

```
2026-MM-DD: morning_briefing + evening_checkin retirement signed off.
            7 consecutive AUTO-01 + AUTO-03 firings; 0 Legacy Inbox leaks.
            Next: Plan 10-07 power-down dependency-chain unblocks 7 days
            after the last retirement (D-16 cold-failover window).
```

---

## DRY_RUN_EVIDENCE

After Step 4 dry-runs, paste the transcript below for the gate audit:

```
# DRY_RUN_EVIDENCE: <paste --dry-run output for both units here>
```

This placeholder MUST be filled before Step 5/6 real retirement runs.

---

## Cross-references

- Plan 10-02 PLAN: `.planning/phases/10-migration-decommission/10-02-PLAN.md`
- Plan 10-01 cutover (classify): `10-01-CUTOVER-RUNBOOK.md`
- Plan 10-07 power-down: `10-07-PLAN.md` + `10-07-POWER-DOWN-RUNBOOK.md`
- Phase 7 AUTO-01 morning-brief: `services/morning-brief/`
- Phase 7 AUTO-03 day-close: `services/day-close/`
- Phase 1 freeze pattern: `services/vps-freeze-patched/`
- Generic retire tool: `scripts/retire-vps-script.sh`
- VPS service inventory: `vps-service-inventory.json` (operator-populated)
- Master rollback runbook: `10-ROLLBACK-RUNBOOK.md`
