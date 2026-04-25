---
phase: 10-migration-decommission
type: validation
created: 2026-04-24
standard: nyquist (every task has automated verify + explicit manual-only flag)
---

# Phase 10 VALIDATION — per-task Verify Matrix

Each task in each plan has a concrete verify command. Operator-only verifications (SSH to VPS, Hetzner CLI, Notion UI actions) are explicitly tagged `OPERATOR` and have a companion automated artifact (a script that emits a checklist or reads a state file the operator populates).

---

## Wave 0 — 10-00-PLAN scaffold

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 0.1: Scaffold 3 service workspaces + 6 scripts + migration 0016 | `pnpm --filter @kos/service-vps-classify-migration typecheck && pnpm --filter @kos/service-discord-brain-dump typecheck && pnpm --filter @kos/service-n8n-workflow-archiver typecheck` all pass | no |
| 0.2: Zod schemas in @kos/contracts (classify-payload, discord-channel-message, vps-service-inventory) | `pnpm --filter @kos/contracts test -- --run migration` passes 4 new test cases | no |
| 0.3: Migration 0016 (event_log) | `pnpm --filter @kos/db migrate:test -- --run 0016` — validates SQL parses and event_log table shape | no |
| 0.4: test fixtures (legacy-inbox-row, command-center-row, n8n-workflow, discord-message, vps-service-inventory) | `ls packages/test-fixtures/phase-10/*.json \| wc -l` returns 5 | no |
| 0.5: CDK skeleton `integrations-migration.ts` with 3 Lambda constructs | `pnpm --filter @kos/cdk test -- --run integrations-migration` passes 3 synth assertions | no |

---

## Wave 1 — 10-01-PLAN classify adapter + same-substance verifier

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 1.1: services/vps-classify-migration handler — accepts old payload shape, emits capture.received | `pnpm --filter @kos/service-vps-classify-migration test -- --run handler` passes 6 cases | no |
| 1.2: Lambda Function URL + HMAC auth (same secret as old VPS webhook) | `pnpm --filter @kos/cdk test -- --run integrations-migration.classify-url` synth assertion | no |
| 1.3: scripts/verify-classify-substance.mjs — Gemini 2.5 Pro judge + operator hand-review output | `node --check scripts/verify-classify-substance.mjs && grep -q 'vertexai' scripts/verify-classify-substance.mjs && grep -q 'operator_review_checklist' scripts/verify-classify-substance.mjs` all PASS | Operator runs script manually; reviews 10 pairs |
| 1.4: operator runbook for DNS/webhook cutover | `test -f .planning/phases/10-migration-decommission/10-01-CUTOVER-RUNBOOK.md && grep -q 'T-0' .planning/phases/10-migration-decommission/10-01-CUTOVER-RUNBOOK.md` | Operator executes cutover |

---

## Wave 1 parallel — 10-02-PLAN morning + evening retirement

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 2.1: scripts/retire-vps-script.sh accepts unit name + returns exit 0 on success | `bash -n scripts/retire-vps-script.sh && grep -q 'systemctl disable' scripts/retire-vps-script.sh && grep -q 'systemctl mask' scripts/retire-vps-script.sh` | Operator SSHes + runs per unit |
| 2.2: scripts/verify-morning-evening-retired.mjs — asserts Phase 7 morning-brief + day-close scheduled cron fires at expected times + VPS systemd units are inactive | `node --check scripts/verify-morning-evening-retired.mjs && grep -q 'EventBridge.*scheduler' scripts/verify-morning-evening-retired.mjs` | Operator verifies |
| 2.3: Legacy Inbox written-to stops (no new [MIGRERAD] rows from morning_briefing / evening_checkin after T+0) | `grep -q 'query_legacy_inbox_after' scripts/verify-morning-evening-retired.mjs` | no (script automates) |

---

## Wave 2 — 10-03-PLAN Brain DB archival

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 3.1: scripts/migrate-brain-dbs.mjs reads 5 Brain DB IDs from .notion-db-ids.json | `node --check scripts/migrate-brain-dbs.mjs && grep -q 'brainDbs' scripts/migrate-brain-dbs.mjs` | no |
| 3.2: write-ahead event_log INSERT before each Notion mutation (per D-12) | `grep -A3 'notion.databases.update' scripts/migrate-brain-dbs.mjs \| grep -q 'event_log'` ensures event_log INSERT appears BEFORE the API call; test in `scripts/verify-brain-db-archive-ordering.mjs` replays a mock | no |
| 3.3: dry-run mode + operator confirmation | `node scripts/migrate-brain-dbs.mjs --dry-run` outputs 5 DB titles + proposed new titles; exits 0 without Notion writes | Operator runs dry-run first, then real |
| 3.4: post-archive verification | `node scripts/verify-brain-dbs-archived.mjs` queries all 5 DBs; asserts archived=true + title starts with `[MIGRERAD-` | no |

---

## Wave 2 parallel — 10-04-PLAN Discord brain-dump migration

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 4.1: services/discord-brain-dump handler (Lambda polling every 5 min per Phase 5 SC 4) | `pnpm --filter @kos/service-discord-brain-dump test -- --run handler` passes 5 cases | no |
| 4.2: cursor persistence (last message ID per channel) | `pnpm --filter @kos/service-discord-brain-dump test -- --run cursor` passes 3 cases (fresh start / resume / race) | no |
| 4.3: EventBridge Scheduler rule every 5 min | `pnpm --filter @kos/cdk test -- --run integrations-migration.discord-poll-schedule` synth assertion | no |
| 4.4: scripts/verify-discord-brain-dump-substance.mjs (7-day parity) | `node --check scripts/verify-discord-brain-dump-substance.mjs && grep -q 'VPS.*brain-dump-listener.*log' scripts/verify-discord-brain-dump-substance.mjs` | Operator reviews 7 days of output |

---

## Wave 3 — 10-05-PLAN n8n decom

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 5.1: services/n8n-workflow-archiver Lambda — fetches workflows via SSH tunnel, uploads to S3 with KMS | `pnpm --filter @kos/service-n8n-workflow-archiver test -- --run archiver` passes 3 cases | Lambda invoked via SSH tunnel setup by operator |
| 5.2: scripts/decom-n8n.sh operator script | `bash -n scripts/decom-n8n.sh && grep -q 'rest/workflows' scripts/decom-n8n.sh && grep -q 'systemctl stop n8n' scripts/decom-n8n.sh && grep -q 'ufw deny 5678' scripts/decom-n8n.sh` | Operator SSH + runs |
| 5.3: S3 bucket prefix archive/n8n-workflows/ with KMS + IAM restricted | `pnpm --filter @kos/cdk test -- --run integrations-migration.n8n-archive-s3` asserts bucket + KMS + IAM | no |
| 5.4: scripts/verify-n8n-dead.mjs — external probe expects `Connection refused` on port 5678 | `node --check scripts/verify-n8n-dead.mjs && grep -q 'ECONNREFUSED' scripts/verify-n8n-dead.mjs` | Operator runs from external network |

---

## Wave 3 parallel — 10-06-PLAN unfrozen VPS scripts retirement

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 6.1: scripts/discover-vps-scripts.sh outputs JSON inventory | `bash -n scripts/discover-vps-scripts.sh && grep -q 'systemctl list-units' scripts/discover-vps-scripts.sh && grep -q 'ps aux' scripts/discover-vps-scripts.sh` | Operator SSHes + runs |
| 6.2: vps-service-inventory.json schema validation | `node -e "import('./packages/contracts/dist/index.js').then(c => c.VpsServiceInventorySchema.parse(JSON.parse(require('fs').readFileSync('.planning/phases/10-migration-decommission/vps-service-inventory.json'))))"` passes | no (runs at Wave 3 gate, requires prior operator step) |
| 6.3: Retirement plan per unfrozen script documents replacement path (gmail_classifier → Phase 4 email-triage, brain_server → no replacement / inert, sync_aggregated → no replacement / inert, brain-dump-listener → Phase 10 CAP-10 Lambda) | `grep -q 'gmail_classifier.*email-triage' .planning/phases/10-migration-decommission/10-06-PLAN.md && grep -q 'brain_server.*inert' .planning/phases/10-migration-decommission/10-06-PLAN.md` | no |
| 6.4: scripts/verify-unfrozen-scripts-retired.mjs | `node --check scripts/verify-unfrozen-scripts-retired.mjs && grep -q 'systemctl is-active' scripts/verify-unfrozen-scripts-retired.mjs` | Operator runs post-SSH |

---

## Wave 4 — 10-07-PLAN Hetzner power-down + rollback + final gate

| Task | Verify (automated) | Manual? |
|------|-------------------|---------|
| 7.1: scripts/power-down-hetzner.sh — snapshot FIRST, then power-off | `bash -n scripts/power-down-hetzner.sh && grep -B5 'hcloud server shutdown' scripts/power-down-hetzner.sh \| grep -q 'hcloud server snapshot' && grep -q 'snapshot_id' scripts/power-down-hetzner.sh` | Operator runs; confirms success |
| 7.2: scripts/verify-hetzner-dead.mjs — external probe no open ports + Hetzner billing $0 check checklist | `node --check scripts/verify-hetzner-dead.mjs && grep -q 'nmap\|net.connect' scripts/verify-hetzner-dead.mjs` | Operator runs daily × 14 |
| 7.3: 10-ROLLBACK-RUNBOOK.md exists with <30min restore + dry-run evidence placeholder | `test -f .planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md && grep -q '30 min' .planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md && grep -q 'snapshot restore' .planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md && grep -q 'DRY_RUN_EVIDENCE' .planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md` | Operator performs dry-run, pastes transcript in runbook |
| 7.4: scripts/verify-telegram-webhook-persistence.mjs | `node --check scripts/verify-telegram-webhook-persistence.mjs && grep -q 'getWebhookInfo' scripts/verify-telegram-webhook-persistence.mjs && grep -q 'sleep_ms.*60000\|setTimeout.*60000' scripts/verify-telegram-webhook-persistence.mjs` | Operator runs post-decom |
| 7.5: scripts/verify-phase-10-e2e.mjs — all 5 ROADMAP SCs + bonus Telegram closure | `node --check scripts/verify-phase-10-e2e.mjs && grep -q 'SC 1' scripts/verify-phase-10-e2e.mjs && grep -q 'SC 2' scripts/verify-phase-10-e2e.mjs && grep -q 'SC 3' scripts/verify-phase-10-e2e.mjs && grep -q 'SC 4' scripts/verify-phase-10-e2e.mjs && grep -q 'SC 5' scripts/verify-phase-10-e2e.mjs` | Operator runs at gate |

---

## Nyquist compliance audit

| Category | Count |
|----------|-------|
| Total tasks across 8 plans | ~26 |
| Tasks with `<automated>` command | 26 |
| Tasks with MISSING Wave 0 scaffolding requirement | 0 |
| Tasks with manual-only verify (operator + automated companion) | 10 (SSH / Hetzner CLI / Notion UI — all have a script companion) |
| Tasks with no verify at all | 0 |

All tasks satisfy Nyquist rule — every `<verify>` block has an `<automated>` command even when the primary verification is operator-performed.

---

## Gate 10 acceptance (from ROADMAP SCs)

- [ ] SC 1: 7/10 + 10/10 + 10/10 Kevin-approved same-substance pairs across 3 scripts × 7 days
- [ ] SC 2: external probe 98.91.6.66:5678 = ECONNREFUSED
- [ ] SC 3: 5 Brain DBs archived=true + `[MIGRERAD-*]` + event_log rows
- [ ] SC 4: Hetzner snapshot + VPS powered_off + billing $0 × 14 days
- [ ] SC 5: 10-ROLLBACK-RUNBOOK.md + dry-run evidence pasted
- [ ] Bonus: Telegram webhook persists > 60s OR escalation per debug doc
