---
phase: 10-migration-decommission
type: rollback-runbook
created: 2026-04-24
budget: < 30 min best-case; < 60 min worst-case with Hetzner support escalation
triggers:
  - Any KOS replacement function fails in week 1 of decommissioning
  - SC 4 INF-11 external probe failure + no route to remediate in KOS
  - Operator decision (Kevin signs off) during the 14-day observation window
retention:
  snapshot: 30 days post-power-down (D-15 early-delete option if 14-day clean-ops streak)
  rollback-window: 14 days (D-15+ requires Hetzner support case to recover snapshot if already deleted)
---

# Phase 10 Rollback Runbook — VPS Re-Spin from Hetzner Snapshot

This runbook exists because INF-11 power-down is reversible. If ANY KOS replacement function fails in week 1 of decommissioning (morning brief missing, email triage dead, Discord brain-dump cap lost, or the Telegram webhook auto-clear reproducing despite Phase 10 decom), the operator executes this runbook to restore the Hetzner VPS from the `kos-vps-final-YYYYMMDD` snapshot in < 30 min.

**Rehearsal requirement:** this runbook is rehearsed in dry-run BEFORE the real power-down. Transcript pasted in DRY_RUN_EVIDENCE section below. Without rehearsal evidence, Plan 10-07 Wave 4 Gate does NOT pass (SC 5).

---

## Prereqs (have ready BEFORE you need this)

- [ ] `hcloud` CLI installed + authenticated (`hcloud context active` shows correct project).
- [ ] Hetzner snapshot image_id from `event_log` kind=`hetzner-snapshot-created` (query via `scripts/query-event-log.mjs`).
- [ ] SSH private key for `kevin@98.91.6.66` (operator's laptop).
- [ ] Telegram bot token (readable from `kos/telegram-bot-token` Secret).
- [ ] Operator aware of the current IP; Hetzner server recreate may issue a NEW IP — DNS updates needed (see step 4).
- [ ] KOS replacement Lambdas documented as failing (specific error + CloudWatch log link) — don't rollback without evidence.

---

## Step 0 — Decide. (2 min)

Answer:
1. Which specific KOS replacement has failed? (morning-brief, day-close, email-triage, Discord brain-dump, classify-adapter?)
2. Is there a forward-fix (bug report / plan 10-XX-gaps) that could ship within 24h?
3. Is the failure impacting Kevin's daily work RIGHT NOW?

If Q3=no AND Q2=yes: **open a gap-closure plan**, not rollback. Rollback is irreversible capital — use it only if KOS is actively broken and forward-fix is > 24h away.

---

## Step 1 — Snapshot sanity (3 min)

```bash
# Confirm snapshot still exists (within 30-day retention)
SNAPSHOT_ID=$(node scripts/query-event-log.mjs --kind=hetzner-snapshot-created --latest | jq -r '.details.image_id')
hcloud image describe $SNAPSHOT_ID
# Expected: type=snapshot; status=available; labels include kos-retention=30days
```

If the snapshot is NOT `available` OR was deleted (past day-30), ABORT this runbook and open a support case with Hetzner. No other recovery path exists.

---

## Step 2 — Create server from snapshot (5-15 min)

```bash
TS=$(date -I)
hcloud server create \
  --image $SNAPSHOT_ID \
  --type cx22 \
  --location fsn1 \
  --name kos-vps-rollback-${TS} \
  --ssh-key <operator-ssh-key-name>
# Output: server-id + new IP
```

**Timing:** 5-15 min depending on snapshot size + Hetzner provisioning queue.

Capture the new IP (let's call it `$NEW_IP`).

```bash
# Wait for SSH (port 22) responsive
until nc -zv $NEW_IP 22; do sleep 10; done
```

---

## Step 3 — Systemd verification (2 min)

```bash
ssh kevin@$NEW_IP '
  # Before decom these were all masked. Unmask + start the ones that were failed-replacements.
  sudo systemctl unmask kos-classify.service kos-morning.service kos-evening.service
  sudo systemctl enable kos-classify.service kos-morning.service kos-evening.service
  sudo systemctl start kos-classify.service kos-morning.service kos-evening.service
  systemctl is-active kos-classify.service kos-morning.service kos-evening.service
'
```

Expected: all 3 return `active`. If any fail, check journalctl:
```bash
ssh kevin@$NEW_IP 'sudo journalctl -u <unit> -n 50 --no-pager'
```

Don't unmask ALL units — only the replacements that failed. If only morning-brief is broken in KOS, only restart `kos-morning.service` on the VPS.

---

## Step 4 — DNS / webhook repoint (5-10 min)

The old IP (98.91.6.66) is gone. New IP = $NEW_IP.

### 4a — Telegram webhook (if MIG-02 rollback)

```bash
BOT_TOKEN=$(aws secretsmanager get-secret-value --secret-id kos/telegram-bot-token --query SecretString --output text)
WEBHOOK_URL="https://$NEW_IP/telegram-webhook"   # If VPS-side webhook was restored
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}"
```

**OR** if you're rolling back selectively and KOS Lambda-based webhook still works, leave the webhook pointed at the Lambda Function URL. Decide based on which replacement failed.

### 4b — SES / webhook forwarding (if MIG-01 classify-adapter rollback)

If the classify-adapter Lambda is broken and you need the VPS `classify_and_save` flow back, repoint whatever upstream (iOS Shortcut, n8n, external webhook) was sending to the Lambda Function URL — now send to `https://$NEW_IP/classify`.

### 4c — Discord brain-dump (if CAP-10 rollback)

Discord channel webhook points at a URL in Discord server settings. Update via Discord UI (no CLI): Server Settings → Integrations → Webhooks → edit → paste new VPS URL.

---

## Step 5 — Firewall re-open (1 min)

If MIG-02 n8n rollback needed:
```bash
ssh kevin@$NEW_IP 'sudo ufw allow 5678/tcp && sudo systemctl start n8n && sudo systemctl enable n8n'
```
Expected: `Active: active (running)`. (Note: rolling back n8n leaves port 5678 unauth again — temporary risk; triage the broken KOS function ASAP.)

---

## Step 6 — Verification (2-5 min)

Run the inverse of each verify script:
```bash
# Expect OPEN port now (inverse of verify-hetzner-dead)
nc -zv $NEW_IP 22    # open
nc -zv $NEW_IP 5678  # open if n8n restored

# Telegram webhook persists
node scripts/verify-telegram-webhook-persistence.mjs
# Expect exit 0 if webhook moved back to VPS successfully

# VPS legacy scripts writing to Legacy Inbox (during rollback we accept dual-write)
node scripts/query-legacy-inbox.mjs --since "10 minutes ago"
# Expect new [MIGRERAD] rows arriving
```

---

## Step 7 — Write event_log audit + notify Kevin (1 min)

```bash
aws lambda invoke \
  --function-name kos-event-log \
  --payload '{"kind":"phase-10-rollback-executed","details":{"reason":"<brief reason>","trigger_commit":"<SHA>","new_ip":"'$NEW_IP'","snapshot_id":"'$SNAPSHOT_ID'","operator":"<name>"}}' \
  /tmp/rollback-audit.json
```

Then post to Telegram (1 of 3 cap — urgent, bypass):
```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=<kevin-chat-id>&text=KOS VPS rolled back from snapshot. New IP: $NEW_IP. Reason: <brief>. Forward-fix issue opened."
```

---

## Step 8 — Open gap-closure plan (post-incident)

Within 24 hours:
1. Write `/gsd-plan-phase 10 --gaps` documenting what broke in KOS.
2. Fix the forward path; re-attempt Plan 10-07 once clean.
3. Don't keep the VPS running indefinitely — it's costing ~$50/mo again. Target: second power-down within 14 days.

---

## Kill-switch (nuclear): Telegram bot token rotation

If the Telegram webhook auto-clear reproduces post-rollback, rotate the token:
```bash
# 1. @BotFather → /revoke → new token
# 2. Update Secret
aws secretsmanager update-secret --secret-id kos/telegram-bot-token --secret-string '<new-token>'
# 3. Re-register webhook with new token
# 4. Observe 60 min — if still clearing, investigate dev machine per debug doc Test 3
```

Cost: Kevin re-adds the bot to DM-relevant chats.

---

## DRY_RUN_EVIDENCE

Operator: paste transcript of the dry-run rehearsal BEFORE Plan 10-07 Wave 4 real power-down. Include:
- Timestamp of dry-run.
- hcloud commands + output (anonymize IP if needed).
- Time from start to SSH-responsive.
- Time from SSH-responsive to systemd units active.
- Any surprises / runbook corrections discovered.

```
<paste dry-run transcript here>

# Example shape (operator replaces):
# [2026-05-10 14:03:00] Dry-run started
# [14:03:05] hcloud server create --image 12345678 ... → server-id=87654321, IP=203.0.113.42
# [14:08:12] nc -zv 203.0.113.42 22 → Connected (5 min 7 sec to SSH-responsive)
# [14:08:45] ssh kevin@203.0.113.42 'systemctl is-active kos-classify' → active (33 sec)
# [14:09:30] Telegram webhook re-set → getWebhookInfo persists (60 sec observation)
# [14:10:00] Dry-run complete. Total time: 7 min.
# [14:10:30] hcloud server delete 87654321 → disposable dry-run VM removed
```

**Rehearsal required before:** Plan 10-07 Task 3 checkpoint resume-signal.

---

## Post-rollback snapshot retention

After rollback, the `kos-vps-final-YYYYMMDD` snapshot can be deleted once:
- The new rolled-back VPS has been stable for 7 days, AND
- A new snapshot `kos-vps-post-rollback-YYYYMMDD` has been taken.

Hard-delete the original snapshot via `hcloud image delete $SNAPSHOT_ID`. Update event_log kind=`hetzner-snapshot-deleted`.

---

## Contacts

- Hetzner support: https://console.hetzner.cloud/support — response time ~2-4 hours business hours
- AWS support: AWS Console → Support (Business plan if KOS account is enrolled)
- @BotFather: in Telegram, any bot-related recovery

---

*Runbook approved by operator via Plan 10-07 Task 3 checkpoint.*
