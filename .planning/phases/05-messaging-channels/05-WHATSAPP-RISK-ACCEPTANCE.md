# WhatsApp Baileys Risk Acceptance

**Phase:** 5 — Messaging Channels
**Plan:** 05-04 (Baileys Fargate deployment — CAP-06)
**Gate:** This file MUST be signed (below) before Plan 05-04 executes. Human_verification checkpoint blocks without it.

---

## What We Are Doing

Deploying a self-hosted Baileys WhatsApp gateway on AWS Fargate that:

1. Connects to WhatsApp Web using Kevin's personal number (+46-XXX) as the authenticated device.
2. Maintains a persistent WebSocket to `*.whatsapp.net` (same protocol as the official WhatsApp Web browser client).
3. Reads EVERY inbound chat (1:1 + groups) and forwards message bodies to KOS via the `baileys-sidecar` Lambda.
4. NEVER sends a message, NEVER creates a group, NEVER updates presence / status / profile, NEVER reads-receipt, NEVER types-indicator.

---

## Risk Surface

### WhatsApp TOS

Meta's Terms of Service prohibit automated access to WhatsApp. Baileys is reverse-engineered and unofficial. Personal-number read-only gateways are in a grey zone: WhatsApp has not publicly stated enforcement policy for strictly-read personal clients.

**Observed enforcement signals** (public ban reports):
- High-volume outbound automation → banned fast.
- Multi-tenant SaaS wrappers → banned in waves.
- Personal-number read-only → rare bans, usually triggered by concurrent session churn or mass-group-join behavior.

**Our exposure profile:**
- Single personal number.
- Single Fargate task (no concurrent sessions).
- Strict read-only (defense-in-depth: library wrapper + SG egress lock + CloudWatch metric + IAM boundary + soak log assertion).
- Connection churn <1/day under normal operation; 4-hour backoff on any rejection.

**Estimated ban probability:** Low. Not zero. Acknowledged.

### Data residency

- Baileys task runs in AWS eu-north-1 (Stockholm) — GDPR-compliant for EU data.
- Session keys persisted in RDS (eu-north-1, KMS-encrypted).
- Message bodies flow into the Phase-2 entity graph (RDS + Notion, same tenancy model as Telegram captures).

### Fallback plan

If WhatsApp revokes the session (QR reject, connection reject, ban):

1. Dashboard `system_alert` surfaces the event (no Telegram fire-alarm per notification-cap).
2. Next daily brief mentions the downtime in prose.
3. Kevin decides: (a) re-scan QR on the Dashboard, (b) abandon WhatsApp channel indefinitely, (c) switch primary capture back to Telegram (which already covers the main flow).
4. **No data loss:** every captured message is already in the entity graph. WhatsApp channel revocation only affects future captures.

---

## Read-only Invariants (defense-in-depth — MUST stay green post-deploy)

1. **Library wrapper** — `services/baileys-fargate/src/wa-socket.ts` throws on `sendMessage`, `updateStatus`, `groupCreate`, `groupParticipantsUpdate`, `chatModify`, `readMessages`, `sendPresenceUpdate`.
2. **SG egress** — Fargate task SG allows outbound only to WhatsApp endpoints + AWS VPC endpoints. No other internet.
3. **CloudWatch metric** — `KOS::Baileys::whatsapp_write_calls_total`. Alarm fires on `>0` over 1 min → `system_alert`.
4. **IAM boundary** — Task role has ZERO bedrock:*, SES:*, DynamoDB:* write, outbound-mutating actions beyond `whatsapp_session_keys` DML.
5. **7-day log assertion** — `verify-gate-5-baileys` Lambda greps `/ecs/baileys` daily; 7 consecutive zero-hit days → Gate 5 passes.

If ANY invariant goes red, Plan 05-04 rolls back (Fargate `desiredCount: 0`) automatically and surfaces a `system_alert`. Kevin re-signs this document before re-enabling.

---

## Human Verification (MUST sign before Plan 05-04 executes)

I have read the above. I understand:

- [ ] Baileys is unofficial / reverse-engineered; WhatsApp can revoke the session at any time.
- [ ] The five read-only invariants are non-negotiable; if any fail, the task shuts down automatically.
- [ ] Telegram remains my primary capture; WhatsApp is a convenience channel.
- [ ] If my number is banned from WhatsApp, that is my personal number — I accept this as a non-zero, low-probability risk.
- [ ] If the defensive posture (single-task, read-only, SG locked) is ever weakened, I re-sign this document.

**Signed:**

`I, Kevin El-zarka, accept the above WhatsApp Baileys risk profile for Phase 5 Plan 05-04 of Kevin OS.`

Date: ____________________

Signature (type full name): ____________________

---

## Revision History

| Date | Change | Signer |
|------|--------|--------|
| 2026-04-24 | Initial risk acceptance (Phase 5 planning) | (unsigned) |
</content>
</invoke>