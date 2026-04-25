---
phase: 10-migration-decommission
plan: 07
type: power-down-runbook
created: 2026-04-24
timing: Wave 4 — after Waves 1-3 all complete + 7 days cold-inert VPS operation + rollback dry-run rehearsed
---

# Plan 10-07 Power-Down Runbook

Operator-facing sequence for Wave 4 Hetzner VPS power-down. Assumes:
- Wave 1 (classify-adapter + morning/evening retirement) shipped + 7-day same-substance PASS.
- Wave 2 (Brain DB archival + Discord Lambda) shipped + 7-day Discord same-substance PASS.
- Wave 3 (n8n decom + unfrozen VPS scripts retirement) shipped.
- +7 additional days of cold-inert VPS operation (all systemd units masked) with no KOS gaps surfaced.
- `10-ROLLBACK-RUNBOOK.md` dry-run rehearsed + transcript pasted.

## Pre-flight checklist

- [ ] All Phase 10 verifiers 7-day clean (waves 1-3).
- [ ] Operator confirms no unknown VPS-side processes referencing the bot token (Test 3 of telegram-webhook-auto-clear.md if any doubt).
- [ ] Hetzner API token in operator's environment: `export HCLOUD_TOKEN=...`.
- [ ] `hcloud context active` points at KOS project.
- [ ] Kevin signs off in writing (Telegram or doc comment) with timestamp.
- [ ] Dry-run evidence pasted in 10-ROLLBACK-RUNBOOK.md `DRY_RUN_EVIDENCE` section.

If any pre-flight fails, STOP. Do not proceed.

---

## T-0: Take final snapshot + power off (10-20 min wall-clock)

```bash
cd /home/ubuntu/projects/kevin-os
bash scripts/power-down-hetzner.sh
```

Script flow:
1. Interactive POWEROFF confirmation (type literal `POWEROFF` to proceed).
2. `hcloud server create-image --type snapshot --description "kos-vps-final-$(date -I)"` — blocks until `status=available` (usually 5-15 min).
3. Writes `event_log` kind=`hetzner-snapshot-created`.
4. `hcloud server poweroff $SERVER_ID` — blocks until `status=off` (usually 1-3 min).
5. Writes `event_log` kind=`vps-powered-down`.

---

## T+5: External probe (1 min)

```bash
node scripts/verify-hetzner-dead.mjs
```

Expected: all 4 ports (22, 80, 443, 5678) return `ECONNREFUSED` or `ETIMEDOUT`. If ANY port establishes a connection, the server didn't power off — ABORT and investigate (check Hetzner console).

---

## T+10: Telegram webhook persistence re-test (2 min)

```bash
export TELEGRAM_BOT_TOKEN=$(aws secretsmanager get-secret-value --secret-id kos/telegram-bot-token --query SecretString --output text)
export KOS_TELEGRAM_WEBHOOK_URL="<Lambda Function URL>"
node scripts/verify-telegram-webhook-persistence.mjs
```

**Interpretation:**
- Exit 0 + `[OK] Telegram webhook persisted` → M1 from 02-VERIFICATION.md is **RESOLVED**. Note this in 10-07-GATE-evidence-template.md.
- Exit 2 + `[ESCALATE]` → rogue caller remains on Kevin's dev laptop or elsewhere; rotate bot token per `.planning/debug/telegram-webhook-auto-clear.md`.

Either outcome advances the phase; only exit 1 (script error) blocks.

---

## T+1 to T+14: Daily Hetzner billing check (1 min/day)

```bash
# Visit https://console.hetzner.cloud/projects/<project-id>/billing or
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/invoices | jq '.invoices[0]'
```

Record each day's billing row in 10-07-GATE-evidence-template.md. Expected: €0 new VM usage. If any usage appears, power-off failed — re-run T-0 step 4.

---

## T+14: Gate verification (5 min)

Run the aggregator:
```bash
node scripts/verify-phase-10-e2e.mjs --run-upstream
```

On all-green:
- `.planning/phases/10-migration-decommission/10-07-GATE-evidence.json` emitted.
- ROADMAP promotion patch printed. Apply manually:
  ```bash
  # Edit .planning/REQUIREMENTS.md traceability table: MIG-01..04, INF-11, CAP-10 → Verified
  # Commit: docs(10): ROADMAP + REQUIREMENTS promote Phase 10 reqs to Verified
  ```

---

## T+15: Snapshot-delete decision (operator)

If 14-day clean-ops streak holds AND no rollback was needed AND Kevin signs off:
- **Option A (early delete):** `hcloud image delete $SNAPSHOT_ID`. Write `event_log` kind=`hetzner-snapshot-deleted` reason=`14-day-clean-ops-early-delete`. Cost: lose the rollback option.
- **Option B (wait for T+30):** keep snapshot to the 30-day hard deadline. Cost: ~$0.50 more in storage (Hetzner ~$0.0119/GB-month).

Default recommendation: **Option B** — $0.50 for 16 extra days of optionality is a steal.

---

## T+30: Hard-delete snapshot (2 min)

```bash
hcloud image delete $SNAPSHOT_ID
aws lambda invoke --function-name kos-event-log \
  --payload '{"kind":"hetzner-snapshot-deleted","details":{"image_id":"'$SNAPSHOT_ID'","reason":"30-day-retention-complete"}}' \
  /tmp/resp.json
```

After this, rollback is no longer possible. Phase 10 is irreversibly complete.

Update `10-07-SUMMARY.md` with T+30 deletion timestamp + confirmation.

---

## Escalation paths

| Problem | Action |
|---------|--------|
| Snapshot stuck in "creating" past 20 min | Hetzner support case; keep VPS running |
| Power-off failed (`hcloud server poweroff` returned error) | Retry; if 2nd fail, hcloud `server shutdown` (graceful ACPI) as fallback |
| External probe shows port open after power-off | Investigate Hetzner console; may be another server at the same IP (reassigned); OK if IP fingerprint differs |
| Telegram webhook still cleared <60s | Per debug doc: bot token rotation |
| Kevin flags a missing KOS function in week 1 | Execute 10-ROLLBACK-RUNBOOK.md |

---

*Runbook finalized 2026-04-24; executes at Wave 4 after all 3 prior waves' 7-day windows elapse.*
