# Phase 5: Messaging Channels — Validation (Nyquist per-task matrix)

**Principle:** Every task in Phase 5 has an `<automated>` verify command that runs in < 60 s. Manual operator steps (install unpacked extension, scan QR, deploy Fargate) are companion scripts the automation layer validates after execution.

---

## Plan 05-00: Wave 0 Scaffold

| Task | Automated Verify |
|------|------------------|
| 1. Scaffold apps/chrome-extension + 4 services + contracts + migration 0017 + fixtures | `pnpm -w typecheck` |
| 2. @kos/contracts Zod schemas (ChromeHighlight, LinkedInDm, WhatsappIncoming, SystemAlert) | `pnpm --filter @kos/contracts test -- --run` |
| 3. Migration 0017 SQL (next-number guard) | `test -f packages/db/drizzle/0017_phase_5_messaging.sql && head -1 packages/db/drizzle/0017_phase_5_messaging.sql \| grep -E '^-- phase 5 messaging'` |

## Plan 05-01: apps/chrome-extension MV3 + highlight context menu + options page

| Task | Automated Verify |
|------|------------------|
| 1. manifest.json MV3 + background.ts skeleton + content-highlight.ts + options.html/js + esbuild config | `node -e "JSON.parse(require('fs').readFileSync('apps/chrome-extension/src/manifest.json'))" && grep -c '"manifest_version": 3' apps/chrome-extension/src/manifest.json` |
| 2. HMAC helper + "Send to KOS" context menu + POST flow + test fixtures | `pnpm --filter @kos/chrome-extension test -- --run --reporter=basic 2>&1 \| tail -20` |

## Plan 05-02: services/chrome-webhook Lambda

| Task | Automated Verify |
|------|------------------|
| 1. Lambda handler + Bearer + HMAC validation (mirror telegram-bot gate) + Zod + emit | `pnpm --filter @kos/service-chrome-webhook test -- --run --reporter=basic 2>&1 \| tail -15` |
| 2. CDK integrations-chrome-webhook.ts + Function URL + IAM + test | `pnpm --filter @kos/cdk test -- --run integrations-chrome-webhook --reporter=basic 2>&1 \| tail -20` |

## Plan 05-03: LinkedIn content script + webhook Lambda

| Task | Automated Verify |
|------|------------------|
| 1. chrome-extension LinkedIn content-linkedin.ts (visibility-gated 30-min poll, 2-15s delays, 401/403 silent-fail) + background alarm | `pnpm --filter @kos/chrome-extension test -- --run linkedin --reporter=basic 2>&1 \| tail -20` |
| 2. services/linkedin-webhook Lambda + /alert path for system_alert emits | `pnpm --filter @kos/service-linkedin-webhook test -- --run --reporter=basic 2>&1 \| tail -15` |
| 3. scripts/verify-linkedin-observation.mjs (14-day evidence template) | `node --check scripts/verify-linkedin-observation.mjs && echo OK` |

## Plan 05-04: services/baileys-fargate + read-only defense-in-depth CDK

| Task | Automated Verify |
|------|------------------|
| 1. services/baileys-fargate/src/wa-socket.ts (read-only wrapper) + usePostgresAuthState + entrypoint | `pnpm --filter @kos/service-baileys-fargate test -- --run --reporter=basic 2>&1 \| tail -20` |
| 2. CDK integrations-baileys.ts (TaskDef + Service + SG egress lock + metric filter + CloudWatch alarm + IAM grep test) + Dockerfile | `pnpm --filter @kos/cdk test -- --run integrations-baileys --reporter=basic 2>&1 \| tail -30` |
| 3. 05-WHATSAPP-RISK-ACCEPTANCE.md + human_verification checkpoint | `test -f .planning/phases/05-messaging-channels/05-WHATSAPP-RISK-ACCEPTANCE.md && grep -c "I, Kevin El-zarka" .planning/phases/05-messaging-channels/05-WHATSAPP-RISK-ACCEPTANCE.md` |

## Plan 05-05: services/baileys-sidecar Lambda

| Task | Automated Verify |
|------|------------------|
| 1. Sidecar handler (X-BAILEYS-Secret auth + Zod parse + capture.received emit + voice route to S3 + transcribe-starter reuse) | `pnpm --filter @kos/service-baileys-sidecar test -- --run --reporter=basic 2>&1 \| tail -20` |
| 2. CDK integrations-baileys-sidecar.ts (Function URL + SG ingress for Baileys task) | `pnpm --filter @kos/cdk test -- --run integrations-baileys-sidecar --reporter=basic 2>&1 \| tail -20` |

## Plan 05-06: Discord EventBridge Scheduler (polling half)

| Task | Automated Verify |
|------|------------------|
| 1. CDK integrations-discord-schedule.ts (EventBridge Scheduler cron 0/5 min UTC + placeholder Lambda ARN + schema) + docs | `pnpm --filter @kos/cdk test -- --run integrations-discord-schedule --reporter=basic 2>&1 \| tail -15` |
| 2. @kos/contracts DiscordTextCaptureSchema | `pnpm --filter @kos/contracts test -- --run discord --reporter=basic` |

## Plan 05-07: Gate 5 Baileys verifier + Phase 5 E2E gate

| Task | Automated Verify |
|------|------------------|
| 1. services/verify-gate-5-baileys Lambda + EventBridge Scheduler daily trigger | `pnpm --filter @kos/service-verify-gate-5-baileys test -- --run --reporter=basic 2>&1 \| tail -15` |
| 2. scripts/verify-phase-5-e2e.mjs + scripts/verify-gate-5-baileys.mjs (CLI; 7-day soak evidence + RDS session persistence + 4h backoff + graceful-degrade) | `node --check scripts/verify-phase-5-e2e.mjs && node --check scripts/verify-gate-5-baileys.mjs && echo OK` |
| 3. 05-07-GATE-5-evidence-template.md + 05-07-LINKEDIN-14-DAY-evidence-template.md | `test -f .planning/phases/05-messaging-channels/05-07-GATE-5-evidence-template.md && test -f .planning/phases/05-messaging-channels/05-07-LINKEDIN-14-DAY-evidence-template.md` |

---

## Operator-only manual verifications (post-execute, NOT part of plan automation)

These steps run AFTER `/gsd-execute-phase 5` lands all code. They require live cloud mutations and cannot be validated by automated commands at planning time:

| # | Step | Owner |
|---|------|-------|
| M1 | Load `apps/chrome-extension/dist/` unpacked into Chrome → "Send to KOS" appears on any highlight context menu | Operator |
| M2 | Paste Bearer + Webhook URL + HMAC secret into extension Options page → POST reaches chrome-webhook Lambda | Operator |
| M3 | Deploy Baileys Fargate task → scan QR on dashboard (Phase 3 surface) → session persists across task kill without re-scan | Operator |
| M4 | 7-day soak: grep CloudWatch `/ecs/baileys` logs for `sendMessage`, `updateStatus`, `BAILEYS_WRITE_CALL` patterns → ZERO matches | Verifier Lambda (auto) + Operator (spot-check) |
| M5 | 14-day LinkedIn observation: no "unusual activity" warning visible in Kevin's LinkedIn UI | Operator |
| M6 | Kill Baileys task → no Telegram fire-alarm + next daily brief mentions downtime | Operator |
| M7 | Kill Chrome extension → Dashboard Inbox shows `system_alert` card | Operator |
| M8 | Sign 05-WHATSAPP-RISK-ACCEPTANCE.md (type full name + date in the human_verification block) | Operator |

All M-steps have script companions in `scripts/verify-phase-5-e2e.mjs` that collect evidence + write to `05-07-GATE-5-evidence-template.md` when executed by the operator.

---

## Cherry-pick validation paths

**Chrome-only (low-risk):** Plans 05-00 + 05-01 + 05-02 → success = M1 + M2 pass.
**Chrome + LinkedIn (medium-risk):** + Plan 05-03 → success = M1 + M2 + M5 pass over 14 days.
**Full Phase 5 (incl. WhatsApp):** + Plan 05-04 + 05-05 + 05-07 → success = Gate 5 (M3 + M4 + M6) + M8 signed.
**+ Discord fallback:** + Plan 05-06 → success = capture.received kind=discord_text flowing post Phase 10 Lambda deploy.
</content>
</invoke>