---
phase: 01-infrastructure-foundation
verified: 2026-04-22T03:15:00Z
status: human_needed
score: 6/6 roadmap success criteria verified at code level; 0 of 9 Gate 1 criteria verifiable as DEPLOYED
overrides_applied: 0
re_verification:
  previous_status: null
  previous_score: null
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Operator executes full deploy + verify-gate-1 runbook on a workstation with AWS + Azure + Notion + VPS SSH credentials"
    expected: "`pnpm run verify:gate-1` exits 0 — all 9 Gate 1 criteria green"
    why_human: "Phase 1 executed autonomously overnight under explicit 'do-not-spend' guardrails. No AWS/Azure/Notion/VPS mutations occurred. Every deploy step and live assertion is deferred to the operator per each plan's SUMMARY §'Deferred to Operator'. Verification of actual deployed state requires Kevin-authorized live AWS spend + SSH key access."
    runbook: |
      # Prereqs (operator supplies):
      export NOTION_TOKEN=secret_...                     # Notion integration token
      export NOTION_PARENT_PAGE_ID=<uuid>                 # KOS parent page
      export EXISTING_COMMAND_CENTER_DB_ID=<uuid>         # pre-existing Command Center
      export AZURE_SUBSCRIPTION_ID=6dd3d2ff-0dd4-4878-b5e2-6bd65893ac74
      export AZURE_SEARCH_SERVICE_NAME=kos-search-prod
      # (SSH key for kevin@98.91.6.66 must be on operator workstation)

      # 1. Seed secrets (interactive)
      bash scripts/seed-secrets.sh

      # 2. Bootstrap Notion DBs
      pnpm notion:bootstrap
      git add scripts/.notion-db-ids.json && git commit -m "chore: real notion db ids"

      # 3. Provision Azure Search service (~2 min)
      bash scripts/provision-azure-search.sh

      # 4. Deploy all 5 stacks (~15 min including RDS)
      cd packages/cdk
      npx cdk deploy KosNetwork KosEvents KosData KosIntegrations KosSafety \
        --context bastion=true --require-approval never
      cd ../..

      # 5. Push Drizzle schema via SSM bastion tunnel
      # (see Plan 02 SUMMARY operator runbook)
      KOS_DB_TUNNEL_PORT=15432 bash scripts/db-push.sh

      # 6. Confirm SNS email subscription link in Kevin's inbox

      # 7. Deploy VPS freeze (SSH required)
      bash scripts/deploy-vps-freeze.sh
      NOTION_TOKEN=$NOTION_TOKEN COMMAND_CENTER_DB_ID=<ID> \
        node scripts/verify-vps-freeze.mjs
      # WAIT 48h, then:
      NOTION_TOKEN=$NOTION_TOKEN COMMAND_CENTER_DB_ID=<ID> \
        node scripts/verify-vps-freeze-48h.mjs

      # 8. Tear down bastion
      cd packages/cdk && npx cdk deploy KosData --require-approval never && cd ../..

      # 9. Master Gate 1 verifier
      pnpm run verify:gate-1
  - test: "After deploy, confirm Wave 3 pre-existing IntegrationsStack test file failures are addressed"
    expected: "`pnpm --filter @kos/cdk test -- --run` exits 0 — integrations-stack-{azure,notion}.test.ts updated with new required props"
    why_human: "deferred-items.md documents 5 failing tests in two Wave-3 test files — they call `new IntegrationsStack(...)` with the Plan 05-era props interface but Plan 04 merge expanded IntegrationsStackProps. The production code is correct (Plans 04/05/06 all compose cleanly in bin/kos.ts and synth green); only the test fixtures need updating. This does not affect deploy, but should be fixed before Phase 2 planning begins so CI is green."
    runbook: "Update `packages/cdk/test/integrations-stack-azure.test.ts:29` and `packages/cdk/test/integrations-stack-notion.test.ts:31` to pass the full IntegrationsStackProps (vpc, rdsSecret, rdsProxyEndpoint, rdsProxyDbiResourceId, notionTokenSecret, captureBus, systemBus, scheduleGroupName) via a shared test helper."
  - test: "Confirm SSH access to 98.91.6.66 from operator workstation and capture A6 systemd unit names"
    expected: "`ssh kevin@98.91.6.66 'systemctl list-units --type=service | grep -E kos-|classify-|briefing|checkin'` returns at least one of the two candidate sets"
    why_human: "Preflight during Plan 00 recorded SSH permission-denied for the agent host (no key). VPS Assumption A6 (actual systemd unit names — `kos-classify kos-morning kos-evening` OR `classify-and-save morning-briefing evening-checkin`) could not be resolved. `scripts/deploy-vps-freeze.sh` handles both candidate sets and logs which worked; operator should record the confirmed names in a follow-up SUMMARY patch."
---

# Phase 1: Infrastructure Foundation Verification Report

**Phase Goal:** A production-grade AWS substrate exists with the entity graph schema, event buses, and safety rails (notification cap, archive-not-delete, VPS freeze) in place — before any agent logic is written.

**Verified:** 2026-04-22T03:15:00Z
**Status:** `human_needed`
**Re-verification:** No — initial verification.

## Executive Summary

Phase 1 is **code-complete** and **design-complete**. All 9 plans landed. All 14 required requirement IDs have implementation backing. All 15 locked decisions (D-01..D-15) are honored in the actual source. Every Gate 1 criterion has a live-verification script in `scripts/verify-*.{mjs,sh}` and they are chained by `scripts/verify-gate-1.mjs`.

Phase 1 is **NOT deployed.** Under the explicit "keep working overnight" / "don't spend Kevin's money" guardrail, the autonomous executors deliberately stopped at `cdk synth` and committed code artifacts only. No `cdk deploy` occurred. No RDS exists. No Notion DBs were created (IDs still `pending-bootstrap`). No Azure Search service was provisioned. No VPS freeze SSH'd. This is documented faithfully in every plan's `## Deferred to Operator` section.

**Decision:** `human_needed`. The code layer of Phase 1 passes verification; the infrastructure layer (what Gate 1 actually measures) requires the operator runbook to execute. Phase 2 cannot begin until `pnpm run verify:gate-1` exits 0 against live infrastructure.

**One known code-level carryover** (documented in `deferred-items.md`, not blocking): Wave 3 test files `integrations-stack-azure.test.ts` and `integrations-stack-notion.test.ts` have 5 failing tests after Plan 04 extended `IntegrationsStackProps`. Production code paths (bin/kos.ts, all three helper files, all 5 stacks) synthesize cleanly; only test fixtures are stale. Non-blocking for deploy; should be fixed before Phase 2 to keep CI green.

## Goal Achievement — Roadmap Success Criteria

All six criteria verified at the code/schema/script level. Live verification deferred to operator.

| # | Success Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `cdk deploy` produces clean stack (VPC, RDS+pgvector, S3+VPCe, 5 EventBridge buses, Secrets Manager) | ✓ VERIFIED (code) | 5 CDK stacks (`KosNetwork`/`KosData`/`KosEvents`/`KosIntegrations`/`KosSafety`) wired in `packages/cdk/bin/kos.ts:35-63`; `cdk synth` green per SUMMARYs 01-00..01-08. 4 Secret constructs in `data-stack.ts:153-172`. **Live deploy deferred.** |
| 2 | Notion Entities (13 fields) + Projects + notion-indexer upserts + Kevin Context seeded | ✓ VERIFIED (code) | `scripts/bootstrap-notion-dbs.mjs:152-213` creates Entities with all 13 spec fields (Name, Aliases, Type, Org, Role, Relationship, Status, LinkedProjects, SeedContext, LastTouch, ManualNotes, Confidence, Source); Projects with 6 fields (verified by grep); Kevin Context page + Legacy Inbox handled; `services/notion-indexer/` + `-backfill/` + `-reconcile/` complete with idempotent upserts + archive-not-delete. **Bootstrap NOT executed — `.notion-db-ids.json` = pending-bootstrap.** |
| 3 | Azure AI Search Basic-tier with binary quantization AT CREATION + semantic reranker in West Europe | ✓ VERIFIED (code) | `services/azure-search-bootstrap/src/index-schema.ts:68-85` pins `kind: 'binaryQuantization'` + `rescoreStorageMethod: 'preserveOriginals'` + `kos-semantic` config at PUT time; `scripts/provision-azure-search.sh` provisions Basic-tier @ West Europe; `scripts/verify-azure-index.mjs` asserts all three post-deploy. **Azure service NOT provisioned.** |
| 4 | Transcribe sv-SE custom vocabulary deployed | ✓ VERIFIED (code) | `vocab/sv-se-v1.txt` (26 phrases: Kevin/Damien/Christina/Marcus/Monika, Tale-Forge/Outbehaving/Almi, Bolag/konvertibellån/aktieägaravtal/ESOP/GDPR, Claude/Sonnet/Haiku/Bedrock/pgvector/Postgres/Granola/Notion/Telegram/WhatsApp/LinkedIn); `services/transcribe-vocab-deploy/src/handler.ts` CustomResource with archive-not-delete; `scripts/.transcribe-region = eu-north-1`. **Vocabulary NOT yet created in AWS.** |
| 5 | Safety rails: $50/$100 cost alarms; archive-not-delete; 3-msg/day cap; VPS freeze → Legacy Inbox | ✓ VERIFIED (code) | `safety-stack.ts:107-149` CfnBudget with 3 thresholds (50 ACTUAL, 100 ACTUAL, 100 FORECASTED); `services/push-telegram/src/cap.ts` INLINE DynamoDB cap (max 3/day, quiet-hours-first); `services/vps-freeze-patched/*.py` write only to Legacy Inbox with `[MIGRERAD]`/`[SKIPPAT-DUP]`; `notion-indexer/upsert.ts` archive-not-delete verified per Plan 04 SUMMARY. **SNS email unconfirmed; VPS freeze NOT deployed.** |
| 6 | owner_id forward-compat on every RDS table with Kevin UUID default | ✓ VERIFIED (code+tests) | `packages/db/src/owner.ts` exports `ownerId()` helper; `packages/db/src/schema.ts` uses it on all 8 tables; `packages/db/drizzle/0001_initial.sql` emits `owner_id uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid` on every table; `packages/db/test/owner-sweep.test.ts` PASSES asserting dataType=string + notNull=true + ≥7 tables; `packages/db/test/schema.test.ts` PASSES. **Schema NOT pushed to live RDS.** |

**Score: 6/6 roadmap SCs verified at code level. 0/6 verified as live-deployed.**

## Gate 1 Criteria (Phase 1 → Phase 2 Hard Gate)

ROADMAP.md lists 9 Gate 1 criteria. All have code-backing; none have live verification yet. Each maps to a step in `scripts/verify-gate-1.mjs`.

| # | Gate 1 Criterion | Code Backing | Verifier Step | Live State |
|---|---|---|---|---|
| 1 | CDK deploy clean for all 5 stacks | 5 stacks wired in `bin/kos.ts`; each SUMMARY confirms `cdk synth` green | `verify-gate-1.mjs` step 1/9 → `verify-stacks-exist.sh` | NOT DEPLOYED |
| 2 | All 5 EventBridge buses provisioned | `events-stack.ts:8` declares 5 bus short names; `KosBus` construct creates bus+policy+DLQ uniformly | step 2/9 → `ListEventBuses` SDK call | NOT DEPLOYED |
| 3 | Postgres schema with `owner_id` on every table | `schema.ts` 8 tables + `0001_initial.sql` DEFAULT; `owner-sweep.test.ts` 4/4 PASS | step 3/9 → live psql `SELECT extversion / count / information_schema.columns` | SCHEMA NOT PUSHED |
| 4 | Notion Entities DB has all 13 spec fields | `bootstrap-notion-dbs.mjs:152-213` — 13 fields verified by grep | step 4/9 → `databases/get` API + field-list assert | BOOTSTRAP NOT RUN |
| 5 | S3 VPC Gateway Endpoint verified | `network-stack.ts:48-50` `addGatewayEndpoint(GatewayVpcEndpointAwsService.S3)`; NAT=0 | step 5/9 → `describe-vpc-endpoints` CLI | NOT DEPLOYED |
| 6 | Cost alarms active | `safety-stack.ts:107-149` 50/100/forecast thresholds → SNS → email | step 6/9 → `describe-budgets` + `list-subscriptions-by-topic` (PendingConfirmation=0) | NOT DEPLOYED; EMAIL UNCONFIRMED |
| 7 | VPS scripts frozen | `services/vps-freeze-patched/*.py` target Legacy Inbox with markers; `deploy-vps-freeze.sh` + 48h verifier | step 7/9 → `verify-vps-freeze.mjs` + `-48h.mjs` | NOT DEPLOYED (SSH unavailable to agent) |
| 8 | Azure AI Search index with binary quantization | `index-schema.ts:68-85` pins `kind: 'binaryQuantization'`; `handler.ts` post-PUT GET asserts same; `verify-azure-index.mjs` triple-checks | step 8/9 → `verify-azure-index.mjs` | NOT PROVISIONED |
| 9 | archive-not-delete in notion-indexer (via reconcile + event_log) | `notion-reconcile` Lambda + `event_log` table (SQL: `kind='notion-hard-delete'`); weekly Sunday schedule in `integrations-notion.ts` | step 9/9 → `verify-transcribe-vocab.sh` + `list-schedules` asserts `notion-reconcile-weekly` count=1 | NOT DEPLOYED |

**Gate 1 live-pass state: 0/9. Gate 1 code-readiness state: 9/9.**

## Required Artifacts

All Phase 1 artifacts exist on disk, substantive, and wired into `bin/kos.ts`.

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/cdk/lib/stacks/network-stack.ts` | NetworkStack with VPC(2AZ, NAT=0) + S3 gateway endpoint | ✓ VERIFIED | 53 lines; `natGateways: 0`, `GatewayVpcEndpointAwsService.S3`; wired in `bin/kos.ts:35` |
| `packages/cdk/lib/stacks/data-stack.ts` | RDS+pgvector + blobs bucket (VPCe-scoped) + 4 secrets + RDS Proxy IAM + ECS cluster | ✓ VERIFIED | 192 lines; all elements present; `aws:SourceVpce` policy; `iamAuth: true`, `requireTLS: true`; `ecsCluster` field exposed |
| `packages/cdk/lib/stacks/events-stack.ts` | 5 `kos.*` buses + kos-schedules group | ✓ VERIFIED | `BUS_SHORT_NAMES = ['capture','triage','agent','output','system']`; KosBus construct + DLQ + same-account policy each |
| `packages/cdk/lib/stacks/integrations-stack.ts` | Thin orchestrator composing notion+azure+transcribe | ✓ VERIFIED | 95 lines; calls `wireNotionIntegrations`, `wireAzureSearch`, `wireTranscribeVocab` in order |
| `packages/cdk/lib/stacks/integrations-notion.ts` | Notion indexer + backfill + reconcile + 5 schedules | ✓ VERIFIED | 7.5KB helper; 4 indexer schedules + 1 weekly reconcile on `kos-schedules`, all Europe/Stockholm |
| `packages/cdk/lib/stacks/integrations-azure.ts` | AzureSearchBootstrap Lambda + CustomResource | ✓ VERIFIED | `createHash('sha256')` fingerprint of index-schema.ts; Provider pattern |
| `packages/cdk/lib/stacks/integrations-transcribe.ts` | CDK Asset + Transcribe deploy Lambda + CustomResource | ✓ VERIFIED | contentHash via `vocabAsset.assetHash`; KosLambda 10min timeout |
| `packages/cdk/lib/stacks/safety-stack.ts` | DynamoDB cap + push-telegram + Budgets + SNS | ✓ VERIFIED | 170 lines; 3 Budgets notifications; SNS policy with `aws:SourceArn` scope |
| `packages/cdk/lib/constructs/kos-lambda.ts` | Shared NodejsFunction (Node22 ARM64 + externalize @aws-sdk/*) | ✓ VERIFIED | `Runtime.NODEJS_22_X`, `Architecture.ARM_64`, `externalModules: ['@aws-sdk/*']`, `TZ: 'UTC'`, `RetentionDays.ONE_MONTH` |
| `packages/cdk/lib/constructs/kos-bus.ts` | EventBus + CfnEventBusPolicy + DLQ triple | ✓ VERIFIED | Same-account PutEvents; 14-day DLQ |
| `packages/cdk/lib/constructs/kos-rds.ts` | RDS Postgres 16.5 + generated credentials | ✓ VERIFIED | `Credentials.fromGeneratedSecret`, force_ssl param group (per test assertions) |
| `packages/cdk/lib/constructs/kos-bastion.ts` | Opt-in SSM bastion for Task 3 push | ✓ VERIFIED | Context-gated `bastion=true` |
| `packages/cdk/lib/constructs/kos-cluster.ts` | Empty ECS Fargate cluster (INF-06) | ✓ VERIFIED | 41 lines; `containerInsightsV2: DISABLED`; services attach in Phases 4/5/8 |
| `packages/db/src/schema.ts` | 8 Drizzle tables, all with owner_id | ✓ VERIFIED | 186 lines; entity_index/project_index/notion_indexer_cursor/agent_runs/mention_events/event_log/telegram_inbox_queue/kevin_context |
| `packages/db/drizzle/0001_initial.sql` | pgvector extension + 8 CREATE TABLEs + indexes | ✓ VERIFIED | 125 lines; `CREATE EXTENSION vector`; inline `vector(1536)` on entity_index (Pitfall 5 compliant) |
| `packages/db/drizzle/0002_hnsw_index.sql` | HNSW index for pgvector | ✓ VERIFIED | Matches Plan 02 SUMMARY; `m=16, ef_construction=64, vector_cosine_ops` |
| `packages/contracts/src/events.ts` | BUS_NAMES const + EventMetadataSchema (zod ulid+uuid) | ✓ VERIFIED | All 5 bus names; `ulid()` captureId, `uuid()` ownerId |
| `services/notion-indexer/src/{handler,upsert,notion-shapes}.ts` | 5-min poller + idempotent upsert + archive-not-delete | ✓ VERIFIED | Cursor advance only on full pagination; `handleArchivedOrMissing` logs event_log, never mutates |
| `services/notion-indexer-backfill/` | One-shot full-scan backfill | ✓ VERIFIED | Shares `upsert.ts` with indexer; 350ms leaky-bucket |
| `services/notion-reconcile/` | Weekly Sunday 04:00 Stockholm hard-delete detector | ✓ VERIFIED | Writes `event_log kind='notion-hard-delete'`; never mutates entity_index |
| `services/azure-search-bootstrap/src/{handler,index-schema}.ts` | Azure PUT with binary quantization at creation | ✓ VERIFIED | Post-PUT GET asserts kind; Delete = no-op (archive-not-delete) |
| `services/transcribe-vocab-deploy/src/handler.ts` | CreateVocabulary or UpdateVocabulary sv-SE with polling | ✓ VERIFIED | 5-min deadline; FAILED → throw; Delete = archive-not-delete |
| `services/push-telegram/src/{cap,quiet-hours,handler}.ts` | Inline cap + Stockholm DST-safe quiet hours | ✓ VERIFIED | Atomic DynamoDB ADD+Condition; `toLocaleString('sv-SE', timeZone: 'Europe/Stockholm')`; 27 tests pass |
| `services/vps-freeze-patched/*.py` | classify_and_save, morning_briefing, evening_checkin → Legacy Inbox | ✓ VERIFIED | All 3 files present; `[MIGRERAD]` / `[SKIPPAT-DUP]` markers; grep confirms zero refs to COMMAND_CENTER/KONTAKTER/DAILY_BRIEF_LOG |
| `vocab/sv-se-v1.txt` | Kevin entities + Swedish finance + English tech | ✓ VERIFIED | 26 phrases; Kevin/Damien/Christina/Marcus/Monika; Tale-Forge/Almi; konvertibellån/ESOP/GDPR; Claude/Sonnet/Haiku |
| `scripts/bootstrap-notion-dbs.mjs` | Idempotent 4-DB + Kevin Context + Legacy Inbox creator | ✓ VERIFIED | 13 Entity fields + 6 Project fields present; reads EXISTING_COMMAND_CENTER_DB_ID |
| `scripts/verify-gate-1.mjs` | Sequential 9-step Gate 1 verifier | ✓ VERIFIED | 297 lines; all 9 hard steps + 2 bonus; auto-fetches secrets; exits 1 on any fail |
| `scripts/verify-stacks-exist.sh` | 5-stack CFN health probe | ✓ VERIFIED | Iterates KosNetwork/KosData/KosEvents/KosIntegrations/KosSafety |
| `scripts/verify-{azure-index,cap,transcribe-vocab,vps-freeze,vps-freeze-48h}` | Per-Gate-1-criterion live assertions | ✓ VERIFIED | All present + executable; called by verify-gate-1.mjs |
| `scripts/{deploy-vps-freeze.sh,seed-secrets.sh,db-push.sh,provision-azure-search.sh,backfill-notion.sh}` | Operator runbook scripts | ✓ VERIFIED | All present + executable |
| `scripts/.transcribe-region` | Pinned Transcribe region (A9 resolution) | ✓ VERIFIED | Contents = `eu-north-1` |
| `scripts/.notion-db-ids.json` | DB ID manifest (placeholder until bootstrap) | ⚠️ PENDING | All 5 keys = `"pending-bootstrap"`; intentional per Plan 04 SUMMARY so `cdk synth` works on clean clone. Operator replaces with real IDs post-bootstrap. |
| `package.json` `verify:gate-1`, `verify:stacks`, `notion:bootstrap`, `db:push`, `preflight` | npm script entries | ✓ VERIFIED | Plan 08 SUMMARY confirms; self-check passed |

## Key Link Verification

| From | To | Via | Status | Detail |
|---|---|---|---|---|
| `bin/kos.ts` | NetworkStack | `new NetworkStack(app, 'KosNetwork', {env})` | ✓ WIRED | `bin/kos.ts:35` |
| `bin/kos.ts` | DataStack | passes `vpc + s3Endpoint` from network | ✓ WIRED | `bin/kos.ts:37-41` |
| `bin/kos.ts` | EventsStack | `new EventsStack(app, 'KosEvents', {env})` | ✓ WIRED | `bin/kos.ts:36` |
| `bin/kos.ts` | IntegrationsStack | passes 10 props including vpc, rdsSecret, buses, schedule group, transcribeRegion | ✓ WIRED | `bin/kos.ts:42-56` |
| `bin/kos.ts` | SafetyStack | passes rdsSecret, rdsProxyEndpoint, telegramBotTokenSecret | ✓ WIRED | `bin/kos.ts:58-64` |
| `network-stack.ts` | S3 Gateway Endpoint | `vpc.addGatewayEndpoint(...GatewayVpcEndpointAwsService.S3)` | ✓ WIRED | `network-stack.ts:48-50` |
| `data-stack.ts` | S3 bucket policy | `aws:SourceVpce = props.s3Endpoint.vpcEndpointId` | ✓ WIRED | `data-stack.ts:137` |
| `data-stack.ts` | RDS Proxy IAM | `iamAuth: true, requireTLS: true` | ✓ WIRED | `data-stack.ts:88-98` |
| `data-stack.ts` | ECS Cluster | `new KosCluster(this, 'EcsCluster', { vpc })` | ✓ WIRED | `data-stack.ts:178` |
| `events-stack.ts` | 5 KosBus | for-loop over BUS_SHORT_NAMES | ✓ WIRED | `events-stack.ts:36-40` |
| `integrations-notion.ts` | EventBridge Scheduler | `new CfnSchedule` × 5 in `kos-schedules` group, Europe/Stockholm | ✓ WIRED | Per Plan 04 SUMMARY + acceptance greps |
| `integrations-azure.ts` | CustomResource | Provider + `schemaFingerprint = sha256(index-schema.ts)` | ✓ WIRED | Per Plan 05 SUMMARY determinism test |
| `integrations-transcribe.ts` | CDK Asset + CustomResource | `vocabAsset.assetHash` as contentHash | ✓ WIRED | Per Plan 06 SUMMARY |
| `safety-stack.ts` | Budgets → SNS → Email | 3 notifications target topicArn; SNS subscribes ALARM_EMAIL | ✓ WIRED | `safety-stack.ts:107-149` |
| `safety-stack.ts` | push-telegram Lambda → DynamoDB cap table | `capTable.grantReadWriteData(pushTelegram)` | ✓ WIRED | `safety-stack.ts:90` |
| `push-telegram handler` | telegram_inbox_queue (RDS) on denial | Drizzle insert → `telegramInboxQueue` table | ✓ WIRED | Per Plan 07 SUMMARY task 1 |
| `notion-indexer upsert` | event_log (archive-not-delete sink) | `handleArchivedOrMissing` inserts `kind='notion-hard-delete'` | ✓ WIRED | Per Plan 04 SUMMARY |
| `schema.ts`.ownerId() | `0001_initial.sql` SQL DEFAULT | Drizzle helper emits `DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid` | ✓ WIRED | Confirmed in SQL file; owner-sweep test passes |
| `contracts events.ts` BUS_NAMES | EventsStack bus creation | Load-bearing 5-tuple, immutable | ✓ WIRED | Same strings in both files |

## Data-Flow Trace (Level 4)

Phase 1 is infrastructure scaffolding — dynamic data flows begin in Phase 2. The one live data flow Phase 1 owns end-to-end is **Notion → Postgres index** (via notion-indexer).

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `services/notion-indexer/src/handler.ts` | page list | Notion `databases.query` with `last_edited_time` filter | Yes (live Notion API, gated by operator-supplied `NOTION_TOKEN`) | ⚠️ HOLLOW — data will flow only after operator bootstraps DBs + deploys stack; `.notion-db-ids.json` is pending-bootstrap |
| `services/notion-reconcile/src/handler.ts` | active page IDs | Notion full-scan + `entity_index` SELECT | Yes (after deploy) | ⚠️ HOLLOW — same as above |
| `safety-stack` push-telegram | cap count | DynamoDB UpdateItem response | Yes (after deploy) | ⚠️ HOLLOW — no cap table exists yet |
| `vps-freeze-patched/classify_and_save.py` | inbound payload | VPS runtime env | Yes (after SSH deploy) | ⚠️ HOLLOW — not deployed; SSH blocked from agent |

All four are HOLLOW in the sense that their wiring is correct but no live infrastructure exists for them to write to yet. None are stubs in the `return null` sense — the logic is complete. This is consistent with the phase goal ("substrate exists… before any agent logic is written"): the substrate is coded, not yet substantiated.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| `packages/db` schema tests pass | `pnpm --filter @kos/db test -- --run` | 8/8 pass (owner-sweep 4/4 + schema 4/4) | ✓ PASS |
| `packages/cdk` tests pass | `pnpm --filter @kos/cdk test -- --run` | 39/44 PASS; 5 FAIL in `integrations-stack-{azure,notion}.test.ts` | ⚠️ PARTIAL (pre-existing, documented) |
| Repo has 9 completed SUMMARYs | `ls .planning/phases/01-infrastructure-foundation/01-0{0..8}-SUMMARY.md` | 9/9 present | ✓ PASS |
| Every committed git sha from SUMMARYs exists | `git log --oneline` inspection | All 15+ plan-feat commits present (4cef320→1b270e0) | ✓ PASS |
| Preflight resolved region | `cat scripts/.transcribe-region` | `eu-north-1` | ✓ PASS |
| Notion ID manifest tracked | `cat scripts/.notion-db-ids.json` | 5 keys all `"pending-bootstrap"` | ⚠️ EXPECTED — operator step |
| Live stacks deployed | `aws cloudformation describe-stacks --stack-name KosNetwork` | — not run (agent has AWS creds but workflow prohibits deploy) | ? SKIP (deferred to operator) |
| Live Gate 1 verifier passes | `pnpm run verify:gate-1` | — not run (requires deployed stacks) | ? SKIP (deferred to operator) |

## Requirements Coverage

All 14 Phase 1 requirement IDs have implementation backing. Status breakdown:

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| INF-01 | 01-00, 01-01 | CDK stack as single AWS account primary | ✓ SATISFIED (code) | `bin/kos.ts` wires 5 stacks; `env.ts` pins account+region; CDK bootstrap live on 239541130189 |
| INF-02 | 01-02 | RDS Postgres 16 + pgvector 0.8.0 + Drizzle migrations | ✓ SATISFIED (code) | `kos-rds.ts` engine version; `0001_initial.sql` `CREATE EXTENSION vector`; Drizzle schema versioned |
| INF-03 | 01-01, 01-02 | S3 (eu-north-1) + VPC Gateway Endpoint before Lambda writes | ✓ SATISFIED (code) | `network-stack.ts` S3 gateway endpoint; `data-stack.ts` bucket with `aws:SourceVpce` policy |
| INF-04 | 01-03 | 5 EventBridge custom buses (capture/triage/agent/output/system) | ✓ SATISFIED (code) | `events-stack.ts` + `kos-bus.ts` + `contracts/events.ts` BUS_NAMES (same 5 strings, canonical) |
| INF-05 | 01-01, 01-04 | Lambda (Node 22.x) for event-driven agents | ✓ SATISFIED (code) | `kos-lambda.ts` `Runtime.NODEJS_22_X` + `Architecture.ARM_64`; all 3 notion lambdas + azure + transcribe + push-telegram use it |
| INF-06 | 01-08 | ECS Fargate cluster (ARM64) for long-running services | ✓ SATISFIED (code) | `kos-cluster.ts` empty `Cluster` resource named `kos-cluster`; services attach in Phases 4/5/8 |
| INF-07 | 01-02 | Secrets Manager holds all keys + Bearer token | ✓ SATISFIED (code) | 4 Secret constructs: notion/azure-search/telegram/dashboard; `seed-secrets.sh` TTY-only seed path |
| INF-08 (vocab) | 01-06 | Transcribe sv-SE custom vocabulary | ✓ SATISFIED (code) | `vocab/sv-se-v1.txt` 26 phrases; `transcribe-vocab-deploy` CustomResource; region pinned |
| INF-09 | 01-05 | Azure AI Search Basic @ West Europe, binary quantization at creation, hybrid BM25+vector+semantic | ✓ SATISFIED (code) | `provision-azure-search.sh` Basic-tier West Europe; `index-schema.ts` pins binary quantization + kos-semantic + BM25 analyzer |
| ENT-01 | 01-02, 01-04 | Notion Entities DB with 13 fields + mirror in Postgres | ✓ SATISFIED (code) | `bootstrap-notion-dbs.mjs` all 13 fields; `entity_index` table matches |
| ENT-02 | 01-02, 01-04 | Notion Projects DB + mirror | ✓ SATISFIED (code) | Bootstrap has 6 fields (Name/Bolag/Status/Description/LinkedPeople/SeedContext); `project_index` table matches |
| MEM-01 | 01-04 | Notion source of truth → notion-write-confirmed event → Postgres upsert | ✓ SATISFIED (code) | notion-indexer publishes `notion-write-confirmed` on capture bus per successful upsert; Plan 04 SUMMARY confirms |
| MEM-02 | 01-04 | Kevin Context page maintained, prompt-cache-ready | ✓ SATISFIED (code) | Bootstrap creates Kevin Context page with 6 sections; indexer walks heading_2+paragraph and upserts per notion_block_id into `kevin_context` table |
| MIG-04 (freeze) | 01-07 | VPS legacy scripts frozen → Legacy Inbox | ✓ SATISFIED (code) | 3 patched Python scripts; deploy script + 2 verifiers; `[MIGRERAD]`/`[SKIPPAT-DUP]` markers; zero refs to original destinations |

**No orphaned requirements.** All 14 IDs mapped in ROADMAP.md are claimed by plans in this phase.

**Cross-phase requirements status (owned here, tested elsewhere):**
- **INF-08** (vocab) owned here; Phase 2 owns the WER < 10% gate.
- **MIG-04** (freeze) owned here; Phase 10 owns the formal archive marker.
- **INF-06** (Fargate cluster) owned here; Phase 4 deploys EmailEngine, Phase 5 deploys Baileys, Phase 8 deploys Postiz onto it.

## Anti-Patterns Found

Scanning files modified in this phase for TODO/FIXME/stub patterns.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `services/notion-indexer-backfill/src/handler.ts` | — | Still has `RDS_SECRET_ARN` alongside IAM signer path | ℹ️ Info | Phase 04 SUMMARY §Known Stubs documents this as intentional migration parity; Phase 2 cleanup |
| `scripts/.notion-db-ids.json` | all | `"pending-bootstrap"` placeholder | ℹ️ Info | Intentional per Plan 04 SUMMARY so `cdk synth` works on clean clone before operator runs bootstrap |
| `services/notion-indexer/src/handler.ts` | `command_center` branch | Only writes `event_log kind='notion-indexed-other'` in Phase 1 | ℹ️ Info | Per Plan 04 SUMMARY §Known Stubs — full Command Center processing is Phase 2+ |
| `services/notion-indexer-backfill` Kevin Context path | — | Writes single `BACKFILL-PLACEHOLDER` row | ℹ️ Info | Per Plan 04 SUMMARY — first steady-state 5-min tick replaces; avoids doubling Notion API budget |
| `services/push-telegram/src/handler.ts` | ~95 | Phase-1 `console.log({phase1Stub: true})` stub for actual sendMessage | ℹ️ Info | Per Plan 07 SUMMARY §Known Stubs — Phase 2 (CAP-01) wires real grammY `sendMessage`. Cap + quiet-hours logic is NOT a stub. |
| `packages/cdk/test/integrations-stack-azure.test.ts:29` | — | Call site missing Plan 04-era props | ⚠️ Warning | Pre-existing per `deferred-items.md`; 3 tests fail; production code unaffected |
| `packages/cdk/test/integrations-stack-notion.test.ts:31` | — | Same as above | ⚠️ Warning | 2 tests fail; both files need props-injection helper |

No 🛑 Blockers found. All ℹ️ Info items are intentional per-plan stubs documented in SUMMARY.md `§Known Stubs`, with Phase-N resolution noted. All ⚠️ Warnings are the pre-existing deferred-items.md issue.

## Locked-Decision Fidelity (D-01..D-15)

Honored in code:

- **D-05** (no NAT Phase 1): `network-stack.ts:36` `natGateways: 0`; RDS Proxy used with `allowFromAnyIpv4` + IAM auth as the D-05-compliant bypass.
- **D-06** (S3 Gateway Endpoint only, no interface endpoints Phase 1): `network-stack.ts:48-50` single gateway endpoint; no `InterfaceVpcEndpoint` anywhere.
- **D-08** (2-min overlap, cursor-advance-on-success): `notion-indexer` per SUMMARY 04.
- **D-09** (archive-not-delete): reconciler writes `event_log`, never mutates `entity_index`; azure-search handler Delete=no-op; transcribe-vocab-deploy Delete=no-op.
- **D-11** (4 watched DBs: entities/projects/kevin_context/command_center + legacy_inbox tracked): `bootstrap-notion-dbs.mjs` creates/indexes all 5; `.notion-db-ids.json` schema includes all 5 keys.
- **D-12** (on-demand DynamoDB cap, TTL 48h, pk=`telegram-cap#YYYY-MM-DD`): `safety-stack.ts:56-61` + `cap.ts:62-94`.
- **D-13** (quiet hours 20:00-08:00 Stockholm, queue to `telegram_inbox_queue`): `quiet-hours.ts` + handler Drizzle insert.
- **D-15** (cost alarms: email only, Budgets not CloudWatch): `safety-stack.ts:107-149` CfnBudget → SNS → email, ALARM_EMAIL=`kevin@tale-forge.app`.
- **OWNER_ID canonical UUID** (Locked Decision #13): `env.ts:218` + `owner.ts` + `0001_initial.sql` × 8 SQL DEFAULTs. Owner-sweep test enforces forward.

## Human Verification Required

See `human_verification:` frontmatter above for three items:
1. Execute the full operator runbook and confirm `pnpm run verify:gate-1` exits 0 against live infrastructure.
2. Fix the 5 pre-existing Wave 3 test failures in `integrations-stack-{azure,notion}.test.ts` (non-blocking for deploy).
3. Capture A6 systemd unit names from VPS after SSH access restored on operator workstation.

## Gaps Summary

**No code-level gaps block Phase 1.** The phase achieved its stated goal ("substrate exists… before any agent logic is written"):

1. All 6 roadmap success criteria verified at the code/schema/script level.
2. All 14 required requirement IDs have implementation backing.
3. All 9 Gate 1 criteria have deterministic verifier scripts chained by `verify-gate-1.mjs`.
4. All 15 locked decisions honored in source.
5. All 9 plans committed with matching SUMMARY.md self-checks PASSED.
6. Pre-existing Wave-3 test failures documented in `deferred-items.md` — 5 tests only, zero runtime impact.

**The remaining work is operator deploy, not code.** Every SUMMARY explicitly enumerates its `## Deferred to Operator` steps with exact commands; they compose cleanly into the runbook above.

Phase 1 → Phase 2 crossover is gated on `pnpm run verify:gate-1` exiting 0, which requires (a) operator-authorized AWS spend and (b) 48 hours of VPS freeze observation after VPS SSH deploy. Both are deliberate design choices (cost safety + evidence-based gate), not oversights.

---

_Verified: 2026-04-22T03:15:00Z_
_Verifier: Claude (gsd-verifier)_
