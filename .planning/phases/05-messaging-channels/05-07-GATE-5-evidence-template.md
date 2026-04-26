# Gate 5 Evidence — WhatsApp Baileys + Phase 5 Production Label

**Phase:** 5 — Messaging Channels
**Plan:** 05-07
**Gate:** HARD — Phase 5 internal gate. All criteria must be simultaneously true
before CAP-06 (WhatsApp), CAP-04 (Chrome), CAP-05 (LinkedIn), and CAP-10
(Discord polling half) are labelled production.

**Verifier:** `scripts/verify-gate-5.mjs --mode=live`
**E2E:** `scripts/verify-phase-5-e2e.mjs --mode=live`

Each criterion below has either an automated probe (machine-fillable) or a
manual operator step (human-fillable). `/FILL-IN` slots are left blank for the
operator to populate when running the gate.

---

## Criterion 1 — Baileys 7-day zero-write soak

**Gate rule:** zero `BAILEYS_WRITE_REJECTED`, `sendMessage(`, `updateStatus(`,
or `BAILEYS_WRITE_CALL` log lines in `/ecs/baileys` for 7 consecutive 24h
buckets.

**Mechanism:** the `verify-gate-5-baileys` Lambda runs daily (EventBridge
Scheduler `cron(0 1 * * ? *)` UTC), greps the log group, and increments
`sync_status.queue_depth WHERE channel='baileys_gate_5'`. Pass = counter `>= 7`.

| Date (yyyy-mm-dd) | CloudWatch grep matches | zero_write_days counter | PASS? |
|-------------------|-------------------------|-------------------------|-------|
| /FILL-IN | 0 | 1 | [ ] |
| /FILL-IN | 0 | 2 | [ ] |
| /FILL-IN | 0 | 3 | [ ] |
| /FILL-IN | 0 | 4 | [ ] |
| /FILL-IN | 0 | 5 | [ ] |
| /FILL-IN | 0 | 6 | [ ] |
| /FILL-IN | 0 | 7 | [ ] |

Automated probe:
```
node scripts/verify-gate-5.mjs --mode=live --test=soak
```
Expected output: `[6-baileys-7day-soak] PASS  {"zero_write_days": >=7, ...}`.

Status (`PASS` / `FAIL` / `MANUAL_BLOCKED`): /FILL-IN

> Note: until Plan 05-04 (Baileys Fargate CDK, autonomous=false) is deployed,
> this criterion is `MANUAL_BLOCKED`. The script structure already accommodates
> the post-deploy fill-in.

---

## Criterion 2 — Session auth persisted in RDS (not container filesystem)

**Gate rule:** `whatsapp_session_keys` table contains a `creds` row owned by
Kevin. This proves the postgres-backed `SignalKeyStore` is active and a Fargate
task restart will not re-trigger a QR scan.

SQL probe:
```sql
SELECT COUNT(*)::int AS c
  FROM whatsapp_session_keys
 WHERE key_id = 'creds';
```
Expected: `>= 1`. Observed: /FILL-IN

Automated probe:
```
DATABASE_URL=postgres://... node scripts/verify-gate-5.mjs --mode=live --test=session
```

PASS? [ ]

---

## Criterion 3 — Kill Fargate task → reconnect WITHOUT QR re-scan

**Gate rule:** forcing a redeployment of `BaileysService` MUST NOT print a new
QR-code log line; the WebSocket MUST re-open within 60s using the persisted
session keys.

Operator runbook:
1. `aws ecs update-service --cluster kos-cluster --service BaileysService --force-new-deployment --region eu-north-1`
2. Wait 60 s.
3. ```
   aws logs filter-log-events \
     --log-group-name /ecs/baileys \
     --start-time $(date -d "2 minutes ago" -u +%s)000 \
     --filter-pattern "QR" \
     --region eu-north-1 --max-items 5
   ```
   → expect zero matches.
4. ```
   aws logs filter-log-events \
     --log-group-name /ecs/baileys \
     --start-time $(date -d "2 minutes ago" -u +%s)000 \
     --filter-pattern "connection opened" \
     --region eu-north-1 --max-items 5
   ```
   → expect ≥1 match.

Observed QR prompt? /FILL-IN  (expected: NO)
Connection re-opened within 60 s? /FILL-IN  (expected: YES)

PASS? [ ]

> Intentionally NOT auto-run by `verify-gate-5.mjs` to avoid bouncing
> production Fargate without explicit operator confirmation.

---

## Criterion 4 — 4h backoff on session rejection

**Gate rule:** the Baileys task MUST escalate retry delay 1h → 2h → 4h on
repeated session rejections, never busy-looping reconnect attempts.

Operator runbook:
1. WhatsApp mobile → Settings → Linked Devices → "Kevin OS" → Log out.
2. Observe `/ecs/baileys` log line `backing off 1h`.
3. Repeat logout to validate escalation 1h → 2h → 4h.
4. Confirm `system_alerts` row appears with severity=warn after the first
   rejection (dashboard banner expected within 30s of the rejection event).

Observed backoff sequence: /FILL-IN
> Example: `1h @ 15:30 UTC, 2h @ 16:45 UTC, 4h @ 19:10 UTC`

Unit-test evidence (offline proxy):
```
node scripts/verify-gate-5.mjs --mode=offline --test=read-only
```
Expected: `[2-read-only-defense] PASS` with `backoff_tests_present: true`.

PASS? [ ]

---

## Criterion 5 — Chrome extension reliability

**Gate rule:** the Chrome MV3 extension successfully POSTs a highlight capture
to the webhook with valid Bearer + HMAC; the capture appears in Inbox within
5 s.

Operator round-trip (M1 + M2 in 05-VALIDATION.md):
1. Load unpacked `apps/chrome-extension/dist` into Chrome.
2. Highlight any text on any page.
3. Right-click → "Send to KOS" (or use the configured shortcut).
4. Observe Inbox row within 5 s.

Automated probe (offline):
```
node scripts/verify-gate-5.mjs --mode=offline --test=chrome
```

Observed round-trip latency: /FILL-IN ms (expected: < 5000 ms)
PASS? [ ]

---

## Criterion 6 — LinkedIn rate-limit safety

**Gate rule:** content-linkedin.ts MUST poll Voyager API at most once per 30
min, with 2-15 s randomized delays, tab-focus-gated, and silent-fail to
`system_alerts` on 401/403. Plus 14 days of zero "unusual activity" warnings
in the LinkedIn UI.

Automated probe (offline):
```
node scripts/verify-gate-5.mjs --mode=offline --test=linkedin
```

14-day observation: see `05-07-LINKEDIN-14-DAY-evidence-template.md`.

PASS? [ ]  (auto-probe must pass AND 14-day template must be all-clean)

---

## Criterion 7 — Discord scheduler wiring

**Gate rule:** EventBridge Scheduler rule `cron(0/5 * * * ? *)` UTC exists and
targets a real Lambda ARN resolved from SSM
`/kos/discord/brain-dump-lambda-arn`. The Lambda body is a Phase 10 deliverable;
Phase 5 owns only the scheduler + capture.received contract.

Automated probe (offline + live):
```
node scripts/verify-gate-5.mjs --mode=live --test=discord
```

Live SSM probe:
```
aws ssm get-parameter --name /kos/discord/brain-dump-lambda-arn \
  --query Parameter.Value --output text --region eu-north-1
```
Expected: a string starting `arn:aws:lambda:`.

Observed ARN: /FILL-IN

PASS? [ ]  (Phase 5 alone PASSes when Scheduler synthesizes; full PASS gates
on Phase 10 Plan 10-04 landing.)

---

## Final

All 7 criteria PASS → Phase 5 (CAP-04 + CAP-05 + CAP-06 + CAP-10) labelled
production. CAP-06 specifically requires criteria 1+2+3+4 simultaneously
green.

| Criterion | Status |
|-----------|--------|
| 1 — 7-day Baileys soak | /FILL-IN |
| 2 — RDS session persistence | /FILL-IN |
| 3 — Kill-task reconnect | /FILL-IN |
| 4 — 4h backoff | /FILL-IN |
| 5 — Chrome reliability | /FILL-IN |
| 6 — LinkedIn rate-limit + 14-day | /FILL-IN |
| 7 — Discord scheduler wiring | /FILL-IN |

Signed: /FILL-IN (Kevin)
Date:   /FILL-IN
Verifier output archive: /FILL-IN (path to stdout/stderr capture)
