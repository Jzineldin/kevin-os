---
phase: 01-infrastructure-foundation
plan: 07
subsystem: safety-rails
tags: [dynamodb, lambda, budgets, sns, vps-freeze, quiet-hours, notification-cap]
requires:
  - 01-00 (preflight)
  - 01-02 (DataStack: RDS Proxy, secrets, telegram_inbox_queue table)
  - 01-03 (EventsStack: 5 kos.* buses — unused by SafetyStack itself but referenced by SafetyStackProps-adjacent consumers in later phases)
  - 01-04 (IntegrationsStack + Legacy Inbox DB id bootstrapped by scripts/bootstrap-notion-dbs.mjs)
provides:
  - DynamoDB cap table (on-demand, TTL 48h, PK pk, retention=RETAIN)
  - push-telegram Lambda (cap + quiet-hours inline enforcement)
  - AWS Budgets kos-monthly → SNS → kevin@tale-forge.app
  - VPS soft-freeze (patched Python scripts + deploy + 2 verifiers)
affects:
  - Phase 2 morning-brief drain (consumes telegram_inbox_queue rows we enqueue)
  - Phase 2+ Telegram senders (MUST import enforceAndIncrement from @kos/service-push-telegram)
  - Phase 10 VPS decommission (full rollback path via /opt/kos-vps/original/)
tech-stack:
  added:
    - "@aws-sdk/client-dynamodb 3.691.0"
    - "@aws-sdk/lib-dynamodb 3.691.0"
    - "aws-cdk-lib/aws-dynamodb Table (PAY_PER_REQUEST)"
    - "aws-cdk-lib/aws-budgets CfnBudget (COST/MONTHLY)"
    - "aws-cdk-lib/aws-sns Topic + EmailSubscription"
    - "python3 requests (VPS-local; no npm package)"
  patterns:
    - "DynamoDB atomic counter via UpdateItem ADD + ConditionExpression"
    - "Stockholm TZ math via Intl toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'}) — no process.env.TZ change"
    - "AWS Budgets over CloudWatch billing alarms (research Don't-Hand-Roll)"
    - "SNS topic policy scoped by aws:SourceArn (Budgets principal)"
    - "[MIGRERAD] / [SKIPPAT-DUP] migration markers on Notion Legacy Inbox writes"
    - "48h observation log file as Gate-1 proof artifact"
key-files:
  created:
    - services/push-telegram/package.json
    - services/push-telegram/tsconfig.json
    - services/push-telegram/src/cap.ts
    - services/push-telegram/src/quiet-hours.ts
    - services/push-telegram/src/handler.ts
    - services/push-telegram/test/cap.test.ts
    - services/push-telegram/test/quiet-hours.test.ts
    - services/vps-freeze-patched/classify_and_save.py
    - services/vps-freeze-patched/morning_briefing.py
    - services/vps-freeze-patched/evening_checkin.py
    - packages/cdk/lib/stacks/safety-stack.ts
    - packages/cdk/test/safety-stack.test.ts
    - scripts/deploy-vps-freeze.sh
    - scripts/verify-cap.mjs
    - scripts/verify-vps-freeze.mjs
    - scripts/verify-vps-freeze-48h.mjs
    - .planning/phases/01-infrastructure-foundation/deferred-items.md
  modified:
    - packages/cdk/bin/kos.ts (added KosSafety as 5th stack)
decisions:
  - "Cap enforcement lives INLINE in push-telegram Lambda (not an upstream EventBridge transformer). Research Anti-Pattern line 607: upstream cap rules can be silently bypassed by any agent that invokes the sender directly."
  - "AWS Budgets (not CloudWatch billing alarms) for cost alerts. Research Don't-Hand-Roll calls Budgets the canonical AWS-native path; Budgets supports monthly COST + forecasted threshold natively."
  - "Quiet-hours check runs BEFORE the DynamoDB increment — quiet-hours rejection does NOT consume a cap slot. Effect: 4 attempts at 22:00 all queue as quiet-hours; count stays at 0."
  - "SNS topic policy scopes budgets.amazonaws.com by aws:SourceArn=budget/kos-monthly. T-01-SNS-01 mitigation: a rogue Budgets configuration elsewhere in the account cannot spam alerts via this topic."
  - "Split verify-vps-freeze into initial + 48h scripts. Initial writes an observation log entry; 48h reads it and fails fast if <48h elapsed. Prevents premature Gate 1 green."
metrics:
  duration-minutes: 8
  tasks-completed: 3
  commits: 3
  tests-added: 27  # 19 push-telegram + 8 SafetyStack
  completed-date: 2026-04-22
---

# Phase 1 Plan 07: SafetyStack Summary

**One-liner:** Phase 1 safety rails — DynamoDB notification cap + push-telegram Lambda with inline cap+quiet-hours enforcement, AWS Budgets $50/$100 → SNS email to kevin@tale-forge.app, and VPS soft-freeze via patched Python scripts writing to Notion Legacy Inbox with [MIGRERAD] markers.

## What Was Built

### Task 1 — push-telegram cap + quiet-hours library (commit `7f9503a`)

- **`services/push-telegram/`** new workspace package `@kos/service-push-telegram`.
- **`src/cap.ts`** — `enforceAndIncrement(deps)`:
  - Quiet-hours check FIRST (via `isQuietHour`) — rejection does not consume a slot.
  - DynamoDB `UpdateItem` with `ADD #c :one SET #t = if_not_exists(#t, :ttl)` + `ConditionExpression: attribute_not_exists(#c) OR #c < :max`.
  - Partition key `telegram-cap#YYYY-MM-DD` (Stockholm-local date).
  - TTL = 48h ahead (epoch seconds).
  - Maps `ConditionalCheckFailedException` → `{ allowed: false, reason: 'cap-exceeded' }`; re-throws all other errors.
- **`src/quiet-hours.ts`** — Stockholm quiet-hours (20:00 ≤ h < 08:00) via `toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', hour12: false })`. DST-safe via Intl ICU.
- **`src/handler.ts`** — Lambda handler:
  - On denial: `drizzle(pool).insert(telegramInboxQueue).values({ body, reason })` so Phase 2 morning-brief can drain.
  - On allow: Phase 1 stub log (Phase 2 will wire real `sendMessage`).
- **27 vitest cases total** covering cap gate, DynamoDB UpdateCommand shape, quiet-hours boundaries (07:59/08:00/19:59/20:00), DST transitions (CET winter / CEST summer, spring-forward + fall-back), stockholmDateKey midnight crossings.

### Task 2 — SafetyStack CDK (commit `0efa282`)

- **`packages/cdk/lib/stacks/safety-stack.ts`**:
  - DynamoDB `TelegramCap` table: `BillingMode.PAY_PER_REQUEST`, `timeToLiveAttribute: 'ttl'`, `partitionKey: { name: 'pk', type: STRING }`, `RemovalPolicy.RETAIN`.
  - `KosLambda` `PushTelegram` outside VPC (Telegram API is public). Env: `CAP_TABLE_NAME`, `RDS_SECRET_ARN`, `RDS_ENDPOINT` (proxy endpoint), `TELEGRAM_BOT_TOKEN_SECRET_ARN`. Grants: cap table R/W, RDS secret read, Telegram token read.
  - SNS `CostAlarmTopic` + `EmailSubscription(ALARM_EMAIL)` (ALARM_EMAIL = `kevin@tale-forge.app`).
  - `CfnBudget` `kos-monthly` (COST / MONTHLY / $100) with 3 notifications:
    - 50 USD ACTUAL > threshold → SNS
    - 100 USD ACTUAL > threshold → SNS
    - 100 USD FORECASTED > threshold → SNS
  - SNS topic resource policy binding `budgets.amazonaws.com` service principal with `ArnLike: aws:SourceArn = arn:aws:budgets::<account>:budget/kos-monthly` (T-01-SNS-01 mitigation).
- **`packages/cdk/bin/kos.ts`** — added `KosSafety` as 5th stack (`SafetyStack` after `IntegrationsStack`).
- **`packages/cdk/test/safety-stack.test.ts`** — 8 synth-level assertions: DynamoDB billing+TTL+key shape, RETAIN policy, Lambda runtime+arch+no-VPC, env var wiring, SNS subscription endpoint, Budgets COST/MONTHLY, 3 notifications (50+100 ACTUAL, 100 FORECASTED), SNS policy SourceArn binding.
- **`scripts/verify-cap.mjs`** — Gate 1 verifier. Invokes push-telegram Lambda 4 times; asserts 4th returns `cap-exceeded`. Detects quiet-hours-shadow (all 4 reject with `quiet-hours`) and fails fast — must be run during Stockholm 08:00-20:00.

### Task 3 — VPS freeze (commit `27b4738`)

- **`services/vps-freeze-patched/{classify_and_save,morning_briefing,evening_checkin}.py`** — each:
  - Reads `NOTION_TOKEN` (existing VPS env) + `LEGACY_INBOX_DB_ID` (from `/etc/kos-freeze.env`).
  - POSTs to `https://api.notion.com/v1/pages` with `parent.database_id = LEGACY_INBOX_DB_ID` and properties `{Name, Source, OriginalPayload, CreatedAt, Marker}`.
  - Title prefixed `[MIGRERAD]` by default; `[SKIPPAT-DUP]` when payload carries `is_duplicate` / `already_processed` flag.
  - Zero references to `COMMAND_CENTER` / `KONTAKTER` / `DAILY_BRIEF_LOG` identifiers (grep-verified).
- **`scripts/deploy-vps-freeze.sh`** (operator-run, requires SSH):
  1. Back originals to `/opt/kos-vps/original/` (first-time only, reversibility).
  2. `rsync` patched scripts → `/opt/kos-vps/`.
  3. Write `/etc/kos-freeze.env` (mode 600, root:root) with `LEGACY_INBOX_DB_ID`; existing `NOTION_TOKEN` on VPS preserved.
  4. `systemctl daemon-reload` + restart with dual-candidate unit names (`kos-classify kos-morning kos-evening` or `classify-and-save morning-briefing evening-checkin` — A6 resolution happens during the SSH reachability check in the deploy step).
- **`scripts/verify-vps-freeze.mjs`** — initial freeze check:
  - **Fails fast** if `COMMAND_CENTER_DB_ID` unset (reverse-check is the Gate 1 guarantee).
  - Triggers VPS scripts via `systemctl restart` (not start — start is a no-op on active units) AND direct `python3 /opt/kos-vps/<name>.py` invocation.
  - Waits 30s for Notion writes to settle.
  - Asserts Legacy Inbox received ≥1 `[MIGRERAD]`/`[SKIPPAT-DUP]` row since trigger time.
  - Asserts Command Center received ZERO rows referencing `classify_and_save`/`morning_briefing`/`evening_checkin` since trigger time.
  - Appends `freeze-start` entry to `.planning/phases/01-infrastructure-foundation/vps-freeze-observation.log`.
- **`scripts/verify-vps-freeze-48h.mjs`** — Gate 1 close:
  - Reads the observation log; fails with "wait until <ts>" if elapsed <48h.
  - Asserts Command Center ZERO rows from patched scripts over the full 48h window.

## Known Stubs

| Stub | File | Line | Reason | Resolved in |
|------|------|------|--------|-------------|
| Phase 1 Telegram-send stub | services/push-telegram/src/handler.ts | 95 | Phase 1 has no real bot token; the stub keeps the cap gate exercisable via `verify-cap.mjs` end-to-end | Phase 2 (CAP-01): real `sendMessage` call via `grammy` replaces the `console.log({phase1Stub: true, ...})` block. Cap + quiet-hours enforcement logic itself is NOT a stub. |

## Deviations from Plan

None of Rules 1-4 triggered. Plan executed as written with the following minor refinements (all consistent with research + threat model):

- **Added 2 bonus cap tests** beyond the 5 called out in the plan (re-throw of unknown DynamoDB errors; explicit stockholmDateKey midnight cross) — both cheap to write, reduce the surface of future regressions.
- **`deferred-items.md` created** — Wave 3 pre-existing typecheck errors in `integrations-stack-azure.test.ts` and `integrations-stack-notion.test.ts` documented as out-of-scope. Reproduced at base `ba7f3636` before any Plan 01-07 changes; not caused by this plan. SafetyStack + its test are type-clean in isolation.

## Authentication Gates

None encountered. All work was local (file writes, vitest, cdk synth). The operator-facing pieces (AWS Secrets Manager, SSH key to VPS, SNS email confirmation click) are explicit **Deferred to Operator** steps — they cannot be auto-executed from this agent environment.

## Deferred to Operator

The following steps require live AWS infrastructure, operator SSH keys, or manual email interaction. Each is documented with the exact command:

1. **Deploy SafetyStack:**
   ```bash
   cd packages/cdk && npx cdk deploy KosSafety --require-approval never
   ```
   Provisions DynamoDB `TelegramCap`, push-telegram Lambda, SNS `CostAlarmTopic`, Budgets `kos-monthly`.

2. **Confirm SNS email subscription (T-01-BUDGET-01 mitigation — Pitfall 1):**
   - AWS will email `kevin@tale-forge.app` with a confirmation link.
   - Kevin clicks the link.
   - Verify confirmed:
     ```bash
     TOPIC_ARN=$(aws sns list-topics --query 'Topics[?contains(TopicArn, `CostAlarm`)] | [0].TopicArn' --output text)
     aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
       --query "Subscriptions[?SubscriptionArn=='PendingConfirmation'] | length(@)" --output text
     ```
     Must return `0` (no pending confirmations).

3. **Verify cap (during Stockholm 08:00-20:00):**
   ```bash
   PUSH_TELEGRAM_FN_NAME=<lambda-name-from-cdk-outputs> node scripts/verify-cap.mjs
   ```
   Must log `[OK] cap enforced. sent=3, cap-exceeded=1`.

4. **Bootstrap Notion DBs (if not already done in Plan 01-04):**
   ```bash
   node scripts/bootstrap-notion-dbs.mjs
   ```
   Populates `scripts/.notion-db-ids.json` with real `legacyInbox` and `commandCenter` UUIDs.

5. **Deploy VPS freeze (requires SSH key to kevin@98.91.6.66):**
   ```bash
   bash scripts/deploy-vps-freeze.sh
   ```
   Must log `[OK] VPS freeze deployed`. SSH permission denied during Plan 01-07 execution (no key on this agent host) — this is a hard prerequisite operator step.

6. **Initial freeze verification:**
   ```bash
   NOTION_TOKEN=xxx COMMAND_CENTER_DB_ID=xxx node scripts/verify-vps-freeze.mjs
   ```
   Writes `freeze-start` to `.planning/phases/01-infrastructure-foundation/vps-freeze-observation.log`.

7. **48h freeze verification (Gate 1 close):**
   ```bash
   NOTION_TOKEN=xxx COMMAND_CENTER_DB_ID=xxx node scripts/verify-vps-freeze-48h.mjs
   ```
   Fails fast with "wait until X" if elapsed <48h. Must log `[OK] 48h observation clean`.

## Threat Flags

None introduced. All network surfaces (DynamoDB API, SNS Publish, Notion API from VPS) were in the plan's `<threat_model>` section. Mitigations applied:
- T-01-06 (cap bypass): cap enforcement inline in sender Lambda. Phase 2+ telegram senders MUST import `enforceAndIncrement`.
- T-01-07 (VPS data leak): patched scripts write exclusively to Legacy Inbox; zero reads flow back into KOS; originals backed up.
- T-01-BUDGET-01 (SNS pending confirmation): documented as operator step 2 above.
- T-01-SNS-01 (rogue Budgets publish): SNS topic policy binds service principal with `aws:SourceArn=budget/kos-monthly`.

## VPS Systemd Unit Name Resolution (A6)

Assumption A6 (VPS systemd unit names) could not be resolved in this execution because SSH from the agent host to `kevin@98.91.6.66` returned permission denied. The deploy script handles both candidate sets (`kos-classify kos-morning kos-evening` OR `classify-and-save morning-briefing evening-checkin`) and logs which succeeded. Operator should record the successful name set when running `bash scripts/deploy-vps-freeze.sh` (SUMMARY can be updated post-deploy with the confirmed names).

## Verification Results

| Check | Status | Notes |
|-------|--------|-------|
| `pnpm --filter @kos/service-push-telegram typecheck` | PASS | Zero errors |
| `pnpm --filter @kos/service-push-telegram test -- --run` | PASS | 19/19 tests |
| `pnpm --filter @kos/cdk test -- --run safety-stack` | PASS | 8/8 tests |
| `cd packages/cdk && npx cdk synth KosSafety --quiet` | PASS | CloudFormation emitted |
| No `require(` in SafetyStack ESM | PASS | grep negative |
| `grep -q "aws:SourceArn" safety-stack.ts` | PASS | |
| `grep -q "budget/kos-monthly" safety-stack.ts` | PASS | |
| Patched VPS scripts: `LEGACY_INBOX_DB_ID` + `[MIGRERAD]` | PASS | All 3 scripts |
| Patched VPS scripts: no COMMAND_CENTER/KONTAKTER/DAILY_BRIEF_LOG | PASS | grep negative |
| `scripts/verify-vps-freeze.mjs` has `systemctl restart`, `python3 /opt/kos-vps`, `COMMAND_CENTER_DB_ID required` | PASS | |
| `pnpm --filter @kos/cdk typecheck` (full) | FAIL — pre-existing Wave 3 issue in integrations-stack-{azure,notion}.test.ts; NOT from this plan. Logged in deferred-items.md. | |

## Commits

- `7f9503a` feat(01-07): push-telegram cap + quiet-hours + handler
- `0efa282` feat(01-07): SafetyStack (DynamoDB cap + push-telegram + Budgets + SNS)
- `27b4738` feat(01-07): VPS freeze — patched scripts + deploy + verifiers

## Self-Check: PASSED

- All 3 commits exist in `git log --oneline`.
- All 17 files referenced in `frontmatter.key-files.created` exist on disk.
- Modified file `packages/cdk/bin/kos.ts` contains `new SafetyStack(app, 'KosSafety',`.
- `scripts/{deploy-vps-freeze.sh,verify-cap.mjs,verify-vps-freeze.mjs,verify-vps-freeze-48h.mjs}` all executable (+x bit).
- `services/vps-freeze-patched/*.py` all executable.
- SafetyStack test 8/8 green; push-telegram tests 19/19 green; `cdk synth KosSafety` green.
