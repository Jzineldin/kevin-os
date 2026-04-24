---
slug: telegram-webhook-auto-clear
status: root_cause_candidates_identified
trigger: |
  After operator runs scripts/register-telegram-webhook.mjs the webhook URL is set and setWebhook returns ok. But ~30s later getWebhookInfo returns an empty url. getWebhookInfo.last_error stays empty throughout, so Telegram is not auto-disabling due to error. Some external process is calling either setWebhook with empty string, deleteWebhook, or getUpdates (which implicitly clears the webhook).

  Consequence: CAP-01 (Phase 2 core) cannot be end-to-end verified via real Telegram ingress. Wave-5 worked around by emitting capture.voice.transcribed directly to EventBridge (commit c5435b0), proving the post-ingress pipeline works but not the ingress itself.
created: 2026-04-23
updated: 2026-04-24
---

# Debug Session: telegram-webhook-auto-clear

## Symptoms

- **Expected behavior:** After `scripts/register-telegram-webhook.mjs` runs, `getWebhookInfo.url` stays set indefinitely. Messages from Kevin's phone arrive at the Lambda; Lambda processes them and emits `capture.received` to EventBridge.
- **Actual behavior:** The webhook URL is cleared ~30s after `setWebhook`. Subsequent messages from Kevin's phone go nowhere (Telegram has no webhook to POST to).
- **Error messages:** None. `getWebhookInfo.last_error` stays empty — Telegram is not auto-disabling because of webhook errors.
- **Timeline:** Discovered during Phase 2 Wave 5 live E2E attempts (2026-04-22). Workaround (synthetic EventBridge event) used for `c5435b0` "unblock Gate 2" proof.
- **Reproduction:** `node scripts/register-telegram-webhook.mjs && sleep 60 && curl ".../getWebhookInfo"` — URL is empty on second check.

## Non-causes (ruled out via code inspection, 2026-04-24)

The following have been proven NOT to cause the clear via repo grep:

1. **The `telegram-bot` Lambda itself.** [services/telegram-bot/src/handler.ts](../../services/telegram-bot/src/handler.ts) only calls `bot.handleUpdate(update)` on incoming POSTs. It never invokes `setWebhook('')`, `deleteWebhook`, or `getUpdates`. grammY's `Bot` constructor does a `getMe()` call (optional via `TELEGRAM_BOT_INFO_JSON` env var), which is read-only.
2. **VPS-freeze-patched scripts.** `services/vps-freeze-patched/{classify_and_save,morning_briefing,evening_checkin}.py` have zero references to `TELEGRAM`, `BOT_TOKEN`, or `telegram` (confirmed via grep). These scripts only write to Notion Legacy Inbox.
3. **Other KOS services.** Monorepo grep for `setWebhook|getUpdates|deleteWebhook` across `services/**/*.ts` and `packages/**/*.ts` returns only the operator script (`scripts/register-telegram-webhook.mjs`) and a doc comment in `packages/cdk/lib/stacks/integrations-telegram.ts`. No runtime caller in the monorepo clears or polls.
4. **Other process within the deployed Lambda pipeline.** `push-telegram` Lambda only calls `sendMessage`; grammY-wise it uses `bot.api.sendMessage` which is orthogonal to webhook state.

## Causes remaining — ranked by likelihood

**High likelihood:**

1. **n8n on the VPS port 5678, unauthenticated.** CLAUDE.md documents: *"Hetzner VPS at 98.91.6.66 (ubuntu) — runs … n8n on port 5678 (no auth)"* and *"MIG-02: Decommission n8n on VPS once all flows migrated (port 5678 is unauthenticated security risk)"*. An n8n workflow with a Telegram Trigger node in long-polling mode would implicitly call `getUpdates` on a loop — Telegram invalidates any webhook when `getUpdates` is called, even by a different client using the same bot token. The ~30s timing is consistent with an n8n polling interval.
2. **Legacy VPS Python scripts not on the `vps-freeze-patched` list.** CLAUDE.md enumerates: *"runs brain_server, classify_and_save (just patched), morning_briefing, evening_checkin, gmail_classifier, brain-dump-listener, sync_aggregated"*. Only 3 (classify/morning/evening) have been freeze-patched. The other 4 (`brain_server`, `gmail_classifier`, `brain-dump-listener`, `sync_aggregated`) are unknown — any of them could use `python-telegram-bot` in polling mode.

**Medium likelihood:**

3. **A second bot instance on a dev laptop.** If Kevin or a dev machine is running the bot token in long-polling mode anywhere (an old `npm run dev`, a leftover tmux pane, a scheduled cron), it will clear the webhook on each poll.
4. **BotFather-side action.** Unlikely — Telegram doesn't proactively clear webhooks without cause.

**Low likelihood:**

5. **Transient network issue at webhook URL.** Would show in `getWebhookInfo.last_error`. Not this.
6. **Old register script still running on the VPS.** Would need to be explicitly polling setWebhook — grep shows no such script on repo side.

## Hypothesis test (requires operator; no agent access to Bot API or VPS)

### Test 1 — Identify n8n workflows touching Telegram (highest-likelihood cause)

```bash
# SSH to VPS
ssh kevin@98.91.6.66

# List all n8n workflows (n8n exposes /rest/workflows without auth)
curl -s http://localhost:5678/rest/workflows | jq '.data[] | {id, name, active}'

# Find any workflow with a Telegram Trigger node
curl -s http://localhost:5678/rest/workflows | jq '
  .data[]
  | select(.nodes[]? | .type == "n8n-nodes-base.telegramTrigger")
  | {id, name, active}
'

# Stop any such workflow (replace WORKFLOW_ID)
curl -X POST http://localhost:5678/rest/workflows/WORKFLOW_ID/deactivate
```

**Expected if this is the cause:** after deactivating the n8n workflow, `setWebhook` + `sleep 60 && getWebhookInfo` returns the URL still set.

### Test 2 — Find VPS-side legacy Telegram callers (second-highest)

```bash
ssh kevin@98.91.6.66

# Search ALL python/node files on VPS for Telegram API calls
sudo find / -type f \( -name "*.py" -o -name "*.js" -o -name "*.mjs" -o -name "*.ts" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null \
  | xargs grep -lE "getUpdates|setWebhook|deleteWebhook|long.?polling|telegram.Bot|telegram-bot" 2>/dev/null

# Check systemd units
systemctl list-units --type=service --all | grep -iE "telegram|bot|brain"

# Check recent telegram.org API calls in journal
sudo journalctl --since "2 hours ago" | grep -iE "telegram|api.telegram"
```

**Expected if this is the cause:** you find a running systemd unit or cron job using the same bot token in polling mode. Stop it and retest.

### Test 3 — Dev machine check (tertiary)

```bash
# On Kevin's primary laptop + any other machine that has seen the bot token
find ~ -type f \( -name "*.py" -o -name "*.js" -o -name "*.mjs" -o -name "*.ts" \) \
  -not -path "*/node_modules/*" 2>/dev/null \
  | xargs grep -lE "BOT_TOKEN|TELEGRAM_BOT_TOKEN" 2>/dev/null

# Also check env files
grep -rE "BOT_TOKEN|TELEGRAM" ~/.env* ~/.config/*.env 2>/dev/null
```

### Test 4 — Active observation (catches everything)

Run this live: it lets you catch the rogue caller red-handed:

```bash
# 1. Note the exact moment of setWebhook
date --iso-8601=seconds
node scripts/register-telegram-webhook.mjs

# 2. Poll webhook state every 3s for 60s — record exact time it flips empty
for i in $(seq 1 20); do
  date --iso-8601=seconds
  curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq '.result.url, .result.last_error_date, .result.last_error_message'
  echo ""
  sleep 3
done
```

The time-to-clear pattern helps identify the culprit:
- **~30s consistently** → a scheduled polling loop (n8n, systemd timer, cron `*/1 * * * *`)
- **Exactly when another client POSTs** → `getUpdates` from that client
- **Random** → multiple competing clients

## Mitigation path if rogue caller not found

If operator cannot identify and stop the rogue caller (unlikely — it's almost certainly on the VPS), the nuclear options are:

1. **Rotate the bot token.** New token via @BotFather, update `kos/telegram-bot-token` Secret, re-register. Old token becomes stale so any clinging polling loop goes quiet. Cheap, effective; one-time.
2. **Move to long-polling mode ourselves.** Abandon webhook, run grammy on Fargate (not Lambda) with `bot.start()`. Loses the "Lambda-native" cost benefit but dodges the webhook-clearing issue entirely. Adds ~$36/month Fargate cost.

Recommendation: **rotate the token first** (10-minute fix); if the clearing recurs, then something on the VPS got hold of the new token, which implies a deeper hygiene problem worth fixing via Phase 10 decommissioning anyway.

## Current state

- **Workaround active:** `scripts/verify-phase-2-e2e.mjs` falls back to synthetic EventBridge PutEvents when the webhook is cleared. Phase 2 Gate 2 evidence reissue (in `02-VERIFICATION.md`) accepts this as a known-issue `human_needed` item.
- **Audit tracking:** M1 in `.planning/v1.0-MILESTONE-AUDIT.md`. Affects CAP-01.
- **Phase 10 lever:** MIG-02 (decommission n8n on port 5678) will likely solve this as a side effect. If Phase 10 lands before this is manually fixed, no further action needed.

## Next action (operator)

Run Test 1 (n8n workflows) first. It's the highest-likelihood cause and takes 2 minutes. If nothing found, Test 2 (VPS legacy callers) — 10 minutes. If both clean, rotate the bot token and be done.
