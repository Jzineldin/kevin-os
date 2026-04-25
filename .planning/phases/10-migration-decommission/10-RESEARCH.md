---
phase: 10-migration-decommission
type: research
created: 2026-04-24
scope: condensed-findings
---

# Phase 10 RESEARCH — Migration & Decommission

Condensed research supporting Phase 10 planning. All findings are advisory; locked decisions live in `10-CONTEXT.md`.

---

## 1. VPS-side cleanup: systemctl + Hetzner CLI

### Systemctl script retirement (standard pattern)

```bash
# On the VPS (SSH as kevin@98.91.6.66)
sudo systemctl stop <unit-name>       # stops now
sudo systemctl disable <unit-name>    # prevents reboot auto-start
sudo systemctl status <unit-name>     # confirms inactive (dead)
sudo systemctl mask <unit-name>       # defensive: even `systemctl start` refuses
```

Phase 1 deploy-vps-freeze.sh handles two candidate unit-name sets (`kos-classify kos-morning kos-evening` OR `classify-and-save morning-briefing evening-checkin`). Phase 10 must discover the other 4 scripts' unit names via `systemctl list-units --type=service --all` and record in `vps-service-inventory.json`.

### Hetzner CLI for snapshot + power-off

```bash
# hcloud CLI (install: brew install hcloud or equivalent)
hcloud context use kevin-personal                 # or whatever project name
hcloud server snapshot <server-id> \
  --description "kos-pre-decom-2026-MM-DD" \
  --label purpose=kos-decommission-rollback

hcloud server poweroff <server-id>                # hard power-off
# vs
hcloud server shutdown <server-id>                # ACPI shutdown (preferred)
```

**Gotcha:** `poweroff` is instant; `shutdown` can take up to 5 min waiting for ACPI. Phase 10 uses `shutdown` first, falls back to `poweroff` after 5 min timeout.

**Snapshot retention:** Hetzner charges €0.0119/GB/mo. For a typical KOS VPS (~40GB disk), snapshot = ~€0.48/mo. Well within budget.

**Cost reference:** https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/

---

## 2. Notion: Status → Archived + lock database + 90-day trash

### The archive model

Notion has three layers of removal:

1. **`archived: true`** on a page/database — soft archive, still queryable via API, appears in "Trash" in UI, stays forever until deleted.
2. **`in_trash: true`** (newer API concept, 2024+) — equivalent to archived; same behavior.
3. **Actual deletion** — only possible via "Permanently delete" in UI; no API endpoint exists for this as of Notion API 2022-06-28.

**Implication:** We cannot accidentally "hard delete" a Brain DB via API. Archive-never-delete is structurally enforced.

**90-day trash window:** Notion's Enterprise/Business tiers retain trash for 90 days by default; Kevin's plan tier determines this. If Kevin's plan auto-empties trash at 30 days, MIG-03 must complete restoration window tracking accordingly.

### Status property (separate from archived)

The 5 Brain DBs have a `Status` property (select: Active/Paused/Archived/etc.). Setting `Status=Archived` via `PATCH /v1/databases/{id}` updates the DB's own property schema — different from archiving the DB itself. Phase 10 uses BOTH:
1. Set the DB's own `Status` select option to `Archived` (a Brain DB property value)
2. Prepend `[MIGRERAD-<date>]` to the DB title
3. Eventually set `archived: true` on the DB

Order preserves reversibility: title + Status changes are instant-reversible; archive is undoable from the Notion UI.

### Lock database

Notion's "lock database" prevents schema changes; it's a UI-only setting (no API as of 2022-06-28). Phase 10 uses **API workaround**: remove the Notion integration's access to the DB via `PATCH /v1/databases/{id}` cannot lock — instead, the integration leaves the DB untouched after archival, and Kevin flips the UI lock manually post-archive (documented in runbook).

### API call shape for archive

```typescript
await notion.databases.update({
  database_id: BRAIN_DB_ID,
  archived: true,   // soft archive — recoverable for 90 days
  title: [{ type: 'text', text: { content: `[MIGRERAD-${today}] ${originalTitle}` } }],
});
```

Docs: https://developers.notion.com/reference/update-a-database

---

## 3. Discord webhooks (inbound to Lambda URL) vs bot polling

### Channel webhook pattern (chosen per G-03 / D-21)

Discord supports **channel-level webhooks** — each channel can have 0..N webhook endpoints. A webhook is a URL; Discord POSTs JSON to it when a message is sent in the channel (requires a Discord bot with Manage Webhooks permission to set up initially).

**Limitation:** Discord's inbound channel webhooks are **one-way event delivery** from Discord to our URL; for a user to send a message to trigger the webhook, the channel must be sending bot-messages OR use an integration bot. For Kevin's #brain-dump channel, any user message triggers the webhook if it's configured as "all messages" type.

**Actual discovery:** Discord channel webhooks only trigger when **bot-sent** messages are posted. For USER messages (Kevin typing in #brain-dump) to trigger, we need a Discord bot with `MESSAGE_CONTENT` intent + `on_message` listener that forwards to our URL. So "Discord webhook" still requires a bot → the bot posts to our Lambda Function URL.

**Revised approach:** Use a tiny Discord bot on the Lambda (grammY-style — gateway connection via webhook interaction mode IS NOT supported for message events; must use WebSocket gateway). Since KOS doesn't want another Fargate service, the correct pattern is:

- **Option A (simpler):** Keep the existing `brain-dump-listener` pattern but migrate it to Lambda with a bot token + polling (like a Discord version of Telegram's getUpdates). Bot polls every 5 min per ROADMAP Phase 5 SC 4.
- **Option B (webhook-style):** Use Discord's **Interaction Webhook** pattern — only works for slash commands, not free-text messages.

**D-21 + ROADMAP Phase 5 SC 4 resolution:** Phase 5 SC 4 says "Discord #brain-dump fallback poller running every 5 min." Phase 10's CAP-10 migration honors that shape — Lambda runs every 5 min via EventBridge Scheduler, polls Discord channel history via `discord.js` REST (not WebSocket), forwards NEW messages to KOS webhook.

So the actual pattern is **Lambda polling** (not webhook inbound), matching how the VPS script currently works. Phase 10 plan text adjusted accordingly in 10-04-PLAN.

### Rate limits

Discord REST: 50 requests/sec per bot, 10k/hour free-tier guideline. Polling /channels/{id}/messages every 5 min = 288 calls/day = well within limits.

Docs: https://discord.com/developers/docs/topics/rate-limits

---

## 4. n8n workflow export shape

### REST endpoints (n8n local API)

```bash
# List all workflows
curl http://localhost:5678/rest/workflows \
  | jq '.data[] | {id, name, active, nodes: [.nodes[].type]}'

# Get full workflow JSON (including credentials refs)
curl http://localhost:5678/rest/workflows/<id> \
  > workflow-<id>.json
```

**Critical caveat:** n8n on Kevin's VPS at port 5678 is **unauthenticated** (per CLAUDE.md). Any caller on the VPS network (or internet if port 5678 is firewall-open) can dump workflows. Phase 10 archives workflows via SSH-tunneled localhost:5678 — no internet exposure.

### Export JSON contains credentials IDs, not secrets

n8n stores credentials (API keys, OAuth tokens) separately in its encrypted store. Exported workflow JSON references credentials by ID, not by value. So **archived workflow JSON is safe to persist in S3 without credential leakage** — credentials stay on the VPS until power-down, then are wiped with the VM.

### Pitfall: archive BEFORE shutdown

If n8n is stopped before `rest/workflows` is queried, the REST endpoint is dead. Archive → stop → disable → port-close → power-off. Order matters.

Docs: https://docs.n8n.io/api/

---

## 5. Same-substance verification approaches

### The problem

"Identical in substance" means the old VPS script and the new Lambda, given equivalent inputs, produce equivalent outputs — where "equivalent" is squishy (task row vs entity-tagged task row; formatted prose vs structured prose).

### Three approaches considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Hash-based comparison | Deterministic; fast | Fails on whitespace / entity ID / timestamp diffs | REJECTED |
| Field-level structural diff | Catches field drift | False positives on equivalent rephrasings | REJECTED (too noisy) |
| LLM-judged semantic equivalence + operator hand-review | Robust to rephrasing + operator absorbs residual risk | LLM judgment has variance; operator time cost | ACCEPTED per D-03 + D-19 |

### Implementation (per D-19)

`scripts/verify-classify-substance.mjs`:
1. Pick 10 sample inputs from last 7 days of VPS classify_and_save output (stored in Legacy Inbox with `[MIGRERAD]` marker per Phase 1).
2. Re-run each input through the new adapter Lambda; capture output.
3. Send each (old_output, new_output) pair to Gemini 2.5 Pro with prompt: "Are these two outputs equivalent in substance? Scale 0-1. Explain drift if <0.9."
4. Output: markdown report with per-pair score, rationale, flags. Operator reviews → hand-marks PASS or FAIL per pair.
5. Gate = 10/10 marked PASS by operator; Gemini scores are advisory.

**Cost:** 10 comparisons × 3 scripts × Gemini 2.5 Pro @ ~$0.01/call = ~$0.30 total. Negligible.

### Why not automated-only

Kevin explicitly said "sample-compared by hand on 10 cases per script" in ROADMAP SC 1. Operator-in-the-loop is the invariant. Machine-assisted, not machine-decided.

---

## 6. Telegram webhook persistence re-test

### The hypothesis

Per `.planning/debug/telegram-webhook-auto-clear.md`, the rogue caller is most likely **n8n on VPS port 5678** OR **one of the 4 unfrozen VPS scripts** (`gmail_classifier`, `brain-dump-listener`, `sync_aggregated`, `brain_server`). Phase 10 MIG-02 + INF-11 closure should resolve both.

### Re-test after Wave 3 (n8n decom)

```bash
node scripts/register-telegram-webhook.mjs
# Start timestamp
date --iso-8601=seconds > /tmp/set.ts
# Wait 60 seconds
sleep 60
# Re-check URL
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" \
  | jq '{url: .result.url, last_error: .result.last_error_message}'
```

**Expected (PASS):** `url` is the Lambda URL; `last_error` is null or empty.
**FAIL state:** `url` is empty → rogue caller is NOT on the VPS → escalate to dev machine hunt per `telegram-webhook-auto-clear.md` Test 3.

### Re-test after Wave 4 (power-down)

Same command; after VPS is powered off, zero processes on VPS can call Telegram API. If webhook still clears → dev-laptop or similar external process.

---

## 7. Pitfalls (12 documented)

| # | Pitfall | Mitigation |
|---|---------|------------|
| P-01 | Notion DB archive is reversible but title prefix is sticky — if we rollback the archival, the `[MIGRERAD-<date>]` title stays unless explicitly reverted | Runbook includes title restore step: `PATCH /v1/databases/{id}` with original title |
| P-02 | Hetzner snapshot storage costs €0.48/mo; if forgotten, compounds | 30-day retention + hard calendar reminder at day 30 |
| P-03 | Discord channel webhook URL rotation requires channel admin action (Kevin) | Secret storage in AWS Secrets Manager; Kevin rotates via Discord UI |
| P-04 | VPS power-down must precede snapshot deletion; delete-before-down is destructive | Runbook order enforced; script refuses to proceed if snapshot missing |
| P-05 | If n8n is stopped before workflows are archived, /rest/workflows returns 404 | Wave 3 Plan enforces: archive FIRST (Task 1), stop SECOND (Task 2) |
| P-06 | iptables DROP on port 5678 won't persist across reboot without `iptables-persistent` package or systemd netfilter rule | Runbook uses `ufw deny 5678/tcp` (Ubuntu firewall persists across reboots) |
| P-07 | External probe from a residential IP may be blocked by Hetzner's firewall at infra layer, giving false "Connection refused" | Probe from AWS Lambda (external known-good path) OR from a third-party service like nmap.online |
| P-08 | Same-substance verifier needs real recent VPS outputs; if VPS scripts haven't run in 7+ days due to stalled polls, there's no input corpus | Wave 1 first step: confirm Legacy Inbox has ≥ 10 recent rows per script; if not, trigger a batch of VPS runs via `systemctl restart` |
| P-09 | Command Center race condition — if classify-adapter Lambda writes a row AND the VPS script's residual run also writes (during the cutover minute) → duplicate | Mitigated by atomic cutover: systemd disable VPS scripts at T, enable Lambda at T+1s, verify zero dual-writes in 5-min window |
| P-10 | Gemini 2.5 Pro (Vertex AI) quota limits for the verifier — first-time project may have low quota | 30 calls/day well within default quota; documented |
| P-11 | Notion lock-database is UI-only; archived DB can still be unarchived via API → accidental reopen | Runbook: Kevin manually flips the UI lock-database post-archive (doc'd, not agent-automatable) |
| P-12 | Hetzner billing dashboard may lag 24-48h; day-14 zero-egress check may read day-12 data | Documented; verify for 16 consecutive days (2 days buffer) to ensure 14 real days |

---

## 8. Cost impact summary

| Item | Monthly change |
|------|----------------|
| Hetzner VPS decommission | -$50 |
| Hetzner snapshot retention (30 days) | +$0.50 |
| New Lambda invocations (classify adapter, Discord poller) | +$0.20 (essentially free tier) |
| S3 storage for n8n workflow archives (~50MB) | +$0.01 |
| **Net** | **-$49.29/mo** |

Phase 10 delivers **$49/mo steady-state savings** — ~22% reduction on the $200-400/mo target.

---

## 9. Sources

- Hetzner Cloud server lifecycle (shutdown vs poweroff) — https://docs.hetzner.com/cloud/servers/overview/
- Hetzner Cloud snapshot pricing — https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/
- Notion API databases.update — https://developers.notion.com/reference/update-a-database
- Notion archived + restored databases — https://developers.notion.com/docs/working-with-databases
- Discord channel webhooks vs bot — https://discord.com/developers/docs/resources/webhook
- Discord REST rate limits — https://discord.com/developers/docs/topics/rate-limits
- n8n REST API (workflows) — https://docs.n8n.io/api/
- Telegram Bot API webhook + polling mutual exclusion — https://core.telegram.org/bots/api#setwebhook
- Ubuntu UFW persistent firewall rules — https://help.ubuntu.com/community/UFW
- Phase 1 VPS freeze artifacts — `.planning/phases/01-infrastructure-foundation/01-07-SUMMARY.md`
- Telegram webhook debug — `.planning/debug/telegram-webhook-auto-clear.md`
- REQUIREMENTS.md MIG-01..04 + INF-11 + CAP-10
- ROADMAP.md Phase 10 Success Criteria
