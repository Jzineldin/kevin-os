---
status: partial
phase: 01-infrastructure-foundation
source: [01-VERIFICATION.md]
started: 2026-04-22T03:15:00Z
updated: 2026-04-22T03:15:00Z
---

## Current Test

[awaiting human testing — Phase 1 code-complete, operator deploy + verify-gate-1 pending]

## Tests

### 1. Seed Secrets Manager placeholders with real values

expected: All 4 secrets populated (notion-token, telegram-bot-token, azure-search-admin, bedrock-api-key) or documented as not-yet-needed
result: [pending]

Command: `bash scripts/seed-secrets.sh`

### 2. Bootstrap Notion databases

expected: `scripts/.notion-db-ids.json` produced with 5 keys (entities/projects/kevinContext/legacyInbox/commandCenter); idempotent re-run yields zero new rows
result: [pending]

Prereq: `NOTION_TOKEN`, `NOTION_PARENT_PAGE_ID`, `EXISTING_COMMAND_CENTER_DB_ID` env vars set
Command: `pnpm notion:bootstrap && pnpm notion:bootstrap` (second run no-op)

### 3. Provision Azure AI Search service

expected: `kos-search-prod` Basic tier service in `westeurope`; admin key persisted into Secrets Manager `kos/azure-search-admin`
result: [pending]

Command: `bash scripts/provision-azure-search.sh`

### 4. Deploy all 5 CDK stacks

expected: `cdk deploy KosNetwork KosEvents KosData KosIntegrations KosSafety` exits 0; CloudFormation shows all 5 stacks `CREATE_COMPLETE`
result: [pending]

Command: `cd packages/cdk && npx cdk deploy KosNetwork KosEvents KosData KosIntegrations KosSafety --context bastion=true --require-approval never`

### 5. Push Drizzle schema via SSM bastion tunnel

expected: 8 tables live in RDS + pgvector 0.8.0 extension + HNSW index; second `db-push.sh` run is idempotent
result: [pending]

Command: `KOS_DB_TUNNEL_PORT=15432 bash scripts/db-push.sh`

### 6. Confirm SNS email subscription

expected: Kevin clicks the AWS SNS "Confirm subscription" link sent to `kevin@tale-forge.app`; `aws sns list-subscriptions-by-topic` shows status `Confirmed`
result: [pending]

Action: Click link in Kevin's inbox

### 7. Deploy VPS freeze

expected: Patched `classify_and_save.py` / `morning_briefing.py` / `evening_checkin.py` installed on 98.91.6.66 with originals backed up to `/opt/kos-vps/original/`; systemd units restarted; first invocation writes to Notion Legacy Inbox DB only (Command Center untouched)
result: [pending]

Commands:
```
bash scripts/deploy-vps-freeze.sh
NOTION_TOKEN=$NOTION_TOKEN COMMAND_CENTER_DB_ID=<ID> node scripts/verify-vps-freeze.mjs
```

### 8. VPS freeze 48-hour observation

expected: After 48 hours, `verify-vps-freeze-48h.mjs` confirms zero writes from the 3 legacy sources into Command Center over the observation window
result: [pending]

Command (run ≥48 h after test 7): `NOTION_TOKEN=$NOTION_TOKEN COMMAND_CENTER_DB_ID=<ID> node scripts/verify-vps-freeze-48h.mjs`

### 9. Master Gate 1 verifier

expected: `pnpm run verify:gate-1` exits 0 — all 9 Gate 1 criteria pass
result: [pending]

Command: `pnpm run verify:gate-1`

## Summary

total: 9
passed: 0
issues: 0
pending: 9
skipped: 0
blocked: 0

## Gaps

(none recorded — all items pending initial operator execution; record gaps here if any test above fails)
