---
phase: 01-infrastructure-foundation
plan: 02
subsystem: infrastructure
tags: [cdk, rds, pgvector, s3, secrets-manager, drizzle, bastion, entity-graph]
dependency_graph:
  requires:
    - Plan 01-00 (monorepo scaffold + Drizzle package shell)
    - Plan 01-01 (NetworkStack.vpc + s3GatewayEndpoint)
  provides:
    - DataStack.rds (DatabaseInstance) — consumed by IntegrationsStack (Plan 04 notion-indexer, RDS Proxy) + SafetyStack (Plan 07)
    - DataStack.rdsCredentialsSecret (ISecret) — consumed by every Lambda that reads/writes the DB
    - DataStack.rdsSecurityGroup — Lambdas attach via ingress rule in Plan 04
    - DataStack.blobsBucket — consumed by Phase 2+ audio/transcript/doc pipelines
    - 4 Secrets Manager placeholders (kos/notion-token, azure-search-admin, telegram-bot-token, dashboard-bearer)
    - Drizzle schema with `owner_id` convention (8 tables) — consumed by every service in every future phase
    - KosBastion construct — reusable for any in-VPC psql maintenance window
  affects:
    - Every Phase 1 plan downstream (04/05/07/08) needs the live RDS push completed before it can run integration tests against real tables
    - STATE.md Locked Decision #13 is now implemented in SQL DEFAULT form
tech_stack:
  added:
    - pgvector extension 0.8.0 (defined in migration 0001; materialised by operator push)
    - drizzle-orm vector column (@ 0.36.0 built-in `vector()` type — no customType gotcha)
    - aws-cdk-lib/aws-rds (DatabaseInstance + ParameterGroup)
    - aws-cdk-lib/aws-secretsmanager (Secret)
    - aws-cdk-lib/aws-s3 (Bucket + BucketPolicy via PolicyStatement)
    - aws-cdk-lib/aws-ec2 (BastionHostLinux)
  patterns:
    - Every KOS Drizzle table uses `ownerId()` helper with SQL DEFAULT to Kevin's UUID (Locked Decision #13)
    - `vector()` column defined inline at CREATE TABLE (RESEARCH Pitfall 5 — never ALTER TABLE ADD COLUMN vector)
    - Bucket policy uses `aws:SourceVpce` condition (Pitfall 2 — never `aws:SourceIp` for VPCe traffic)
    - `aws:ViaAWSService=false` escape hatch on the deny statement so CloudFormation/AWS-internal paths still work
    - Bastion is opt-in via CDK context (`bastion=true`) to minimise lifetime (T-01-BASTION-01)
    - RDS retrieves credentials from CDK-generated Secrets Manager entry (`Credentials.fromGeneratedSecret`) — never hardcoded
    - ESM `.js` extensions in relative imports to match Plan 01 monorepo style
key_files:
  created:
    - packages/db/src/owner.ts
    - packages/db/src/schema.ts
    - packages/db/test/schema.test.ts
    - packages/db/drizzle/0001_initial.sql
    - packages/db/drizzle/0002_hnsw_index.sql
    - packages/db/drizzle/meta/_journal.json
    - packages/cdk/lib/constructs/kos-rds.ts
    - packages/cdk/lib/constructs/kos-bastion.ts
    - packages/cdk/lib/stacks/data-stack.ts
    - packages/cdk/test/data-stack.test.ts
    - scripts/seed-secrets.sh
    - scripts/db-push.sh
  modified:
    - packages/db/src/index.ts (re-export schema + owner)
    - packages/cdk/bin/kos.ts (wire DataStack after NetworkStack + EventsStack)
    - package.json (add `db:push` root script)
    - .gitignore (remove blanket ignore of packages/db/drizzle/ so migrations are source-controlled)
decisions:
  - "Unignored packages/db/drizzle/ in .gitignore (Rule 3 blocking issue): Plan 00 scaffold blanket-ignored the directory, but SQL migration files + _journal.json are schema history and must be version-controlled. Scoped the fix with a comment directing future drizzle-kit ignorable subpaths to be named explicitly instead of blanket-ignoring."
  - "Task 3 live push is code-complete but NOT executed against real RDS — the worktree guardrail prohibits cdk deploy (real cost/Kevin approval required). Operator runbook in this SUMMARY lists the 5-step sequence for the live push."
  - "KosBastion ingress-rule null-check hardened vs PLAN pseudocode — `this.host.connections.securityGroups[0]` is typed as `ISecurityGroup | undefined` under `noUncheckedIndexedAccess`; threw on empty array rather than silently skip."
  - "RDS credentials secret null-check hardened (`rds.instance.secret!` replaced with `if (!rds.instance.secret) throw`) so typecheck passes under strict settings and the failure mode is explicit."
  - "Vitest test exhaustively enumerates Drizzle PgTable objects via `getTableName` reflection rather than the `'_' in v` heuristic from the PLAN pseudocode — safer against Drizzle internal refactors."
  - "data-stack.test.ts added extra assertions (force_ssl parameter group, 4 named secrets by name, bastion context gate on/off) beyond PLAN minimum — cheap belt-and-suspenders."
metrics:
  completed: 2026-04-22
  duration_minutes: ~18
  tasks_completed: 3
  tasks_total: 3
  files_created: 12
  files_modified: 4
requirements:
  - INF-02
  - INF-07
  - ENT-01
  - ENT-02
---

# Phase 01 Plan 02: DataStack + Drizzle Schema + owner_id Convention Summary

RDS Postgres 16.5 + pgvector 0.8.0 + S3 blobs bucket (VPCe-scoped) + four Secrets Manager placeholders landed as `DataStack`; eight-table Drizzle schema with `owner_id` on every table committed; `scripts/db-push.sh` + `KosBastion` construct ready for the operator's one-shot schema push.

## Objective

Ship the DataStack that every future phase depends on: real RDS + pgvector for the entity graph, S3 blobs bucket locked down to VPC traffic only, and Secrets Manager placeholders for the four keys (Notion, Azure Search, Telegram, Dashboard bearer) that Plans 04/05/07 will consume. Author the complete Drizzle schema so Plan 04's notion-indexer has tables to upsert into, with `owner_id` on every table to forward-compat multi-user at zero cost (STATE.md Locked Decision #13).

## Outcome

- **Drizzle schema:** 8 tables — `entity_index`, `project_index`, `notion_indexer_cursor`, `agent_runs`, `mention_events`, `event_log`, `telegram_inbox_queue`, `kevin_context`. Every table carries `owner_id uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid`. `entity_index.embedding vector(1536)` defined inline in CREATE TABLE.
- **Migrations:** `0001_initial.sql` creates uuid-ossp + vector extensions + all 8 tables + 6 indexes; `0002_hnsw_index.sql` creates the HNSW index (`m=16, ef_construction=64, vector_cosine_ops`).
- **CDK synth:** `npx cdk synth KosData --quiet` exits 0 against the real aws-cdk-lib 2.248.0 pin.
- **Tests:** 4 Drizzle schema tests green (owner_id sweep, UUID shape, no `kevn` substring); 9 DataStack synth assertions green (engine version regex, RETAIN, SourceVpce, 4 named secrets, bastion off-by-default, bastion-on-with-context).
- **Typecheck:** `pnpm --filter @kos/db typecheck` + `pnpm --filter @kos/cdk typecheck` both pass under strict settings (noUncheckedIndexedAccess enabled).
- **Operator-ready scripts:** `scripts/seed-secrets.sh` (executable; interactive, never writes to disk) + `scripts/db-push.sh` (executable; SSM-tunnel aware via `KOS_DB_TUNNEL_PORT`).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Drizzle schema + owner_id + pgvector migrations | `9f644be` | `packages/db/src/{owner,schema,index}.ts`, `packages/db/test/schema.test.ts`, `packages/db/drizzle/{0001_initial,0002_hnsw_index}.sql`, `packages/db/drizzle/meta/_journal.json`, `.gitignore` |
| 2 | DataStack (RDS + blobs + secrets + bastion) | `c50ff0a` | `packages/cdk/lib/constructs/{kos-rds,kos-bastion}.ts`, `packages/cdk/lib/stacks/data-stack.ts`, `packages/cdk/bin/kos.ts`, `packages/cdk/test/data-stack.test.ts`, `scripts/seed-secrets.sh` |
| 3 | BLOCKING db-push script + bastion-tunnel override | `21c3af8` | `scripts/db-push.sh`, `package.json` |

Total: **3 tasks committed, 16 files touched (12 created, 4 modified).**

## Verification Results

### Static (all green in this worktree)

| Check | Command | Result |
|-------|---------|--------|
| Drizzle typecheck | `pnpm --filter @kos/db typecheck` | 0 |
| Drizzle tests | `pnpm --filter @kos/db test` | 4/4 passed |
| CDK typecheck | `pnpm --filter @kos/cdk typecheck` | 0 |
| CDK synth KosData | `cd packages/cdk && npx cdk synth KosData --quiet` | exit 0 |
| DataStack tests | `pnpm --filter @kos/cdk test -- --run data-stack` | 9/9 passed |
| ownerId() sweep | `grep -c 'ownerId(),' packages/db/src/schema.ts` | 8 (>= 7 required) |
| kevn regression | `grep -ri 'kevn' packages/ scripts/` | absent (only match is the guard test itself) |
| seed-secrets executable | `test -x scripts/seed-secrets.sh` | 0 |
| db-push executable | `test -x scripts/db-push.sh` | 0 |

### Deferred to Operator (real AWS spend required; Kevin approval gate)

Task 3's `<automated>` verify (`bash scripts/db-push.sh` against live RDS) is **code-complete but not executed** — the live RDS does not exist yet, and the worktree guardrail prohibits `cdk deploy` for cost reasons.

**Operator runbook for completing Task 3** (from a workstation with AWS credentials for account 239541130189):

1. Deploy network + data stacks with bastion flag:
   ```bash
   cd packages/cdk
   npx cdk deploy KosNetwork KosData --context bastion=true --require-approval never
   ```
   Expect ~12 min (RDS provisioning dominates).

2. Find the bastion instance ID and the RDS endpoint, then open an SSM port-forward (leave running):
   ```bash
   BASTION_ID=$(aws ec2 describe-instances --region eu-north-1 \
     --filters "Name=tag:aws-cdk:bastion-id,Values=*" \
     --query "Reservations[0].Instances[0].InstanceId" --output text)
   RDS_ENDPOINT=$(aws rds describe-db-instances --region eu-north-1 \
     --query "DBInstances[?DBName=='kos'].Endpoint.Address | [0]" --output text)
   aws ssm start-session --target "$BASTION_ID" \
     --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters "host=$RDS_ENDPOINT,portNumber=5432,localPortNumber=15432" \
     --region eu-north-1
   ```

3. In a second terminal, run the push:
   ```bash
   KOS_DB_TUNNEL_PORT=15432 bash scripts/db-push.sh
   ```
   Expect `pgvector version: 0.8.0`, `KOS tables present: 8 / 8`, and HNSW index present.

4. Seed the four placeholder secrets:
   ```bash
   bash scripts/seed-secrets.sh
   # type NOTION_TOKEN_KOS + AZURE_SEARCH_ADMIN_KEY; "PLACEHOLDER" for Telegram/Dashboard until later phases
   ```

5. Redeploy without the bastion flag to destroy it (T-01-BASTION-01 cleanup):
   ```bash
   cd packages/cdk && npx cdk deploy KosData --require-approval never
   ```

The Gate 1 verifier (`scripts/verify-gate-1.mjs`, created in Plan 08) will re-assert live RDS, pgvector version, table count, HNSW index presence, and 4 secrets existence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Unignored `packages/db/drizzle/` in `.gitignore`**
- **Found during:** Task 1 `git add` of migration files.
- **Issue:** Plan 00's scaffold blanket-ignored `packages/db/drizzle/`, which would have prevented committing `0001_initial.sql`, `0002_hnsw_index.sql`, and `meta/_journal.json` — all of which are schema source-of-truth consumed by `scripts/db-push.sh` at operator run-time.
- **Fix:** Removed the line; added a comment directing future drizzle-kit ignorable subpaths to be named explicitly.
- **Files modified:** `.gitignore`
- **Commit:** `9f644be`

### Design hardening (beyond PLAN pseudocode)

- **Null-check on bastion SG and RDS secret:** plan pseudocode indexed `connections.securityGroups[0]` and `instance.secret!` directly; both are typed as possibly-undefined under `noUncheckedIndexedAccess`. Hardened to throw explicit errors so a future CDK internal change can't produce a silent runtime `undefined`.
- **Schema test table-discovery:** used `getTableName` reflection rather than the `'_' in v` heuristic from the PLAN. More robust to Drizzle internal refactors.
- **DataStack tests +3 assertions:** pinned `rds.force_ssl=1` parameter, asserted 4 named secrets by SecretName, and asserted bastion on/off based on CDK context. All cheap belt-and-suspenders.

### No architectural Rule 4 items

No Rule 4 (architectural) pauses were needed.

## Threat Register Status

| Threat ID | Component | Mitigation Status | Notes |
|-----------|-----------|------------------|-------|
| T-01-02 | RDS credentials | **mitigated (code)** | Secrets Manager + `rds.force_ssl=1`; `scripts/db-push.sh` reads credentials at runtime from Secrets Manager, never persists. Live assertion pending operator deploy. |
| T-01-S3-01 | Public S3 access | **mitigated (code)** | `BlockPublicAccess.BLOCK_ALL` + bucket policy denies non-VPCe traffic + `enforceSSL: true`. Asserted in data-stack.test.ts. |
| T-01-PGVEC-01 | Raw SQL migration with elevated privileges | **accepted** | Bootstrap uses RDS admin user by design. Phase 2+ will introduce a limited app role. |
| T-01-SECRET-01 | Real secrets in git | **mitigated (code)** | `seed-secrets.sh` reads from TTY with `-s`, never writes files. CDK only creates empty shells. |
| T-01-BASTION-01 | Bastion left running | **mitigated (code)** | Gated by CDK context; data-stack.test.ts asserts `AWS::EC2::Instance` count is 0 by default and 1 with the flag. Plan 08 Gate-1 verifier checks no bastion remains post-phase. |

## Known Stubs

None. `telegram_inbox_queue` and `mention_events` are tables that future phases populate, but that's by design (per PLAN `<tasks>` notes) — no code renders an "N/A" placeholder in the UI that would imply a missing wire-up.

## Threat Flags

None. All new surface is within the plan's `<threat_model>`:
- RDS endpoint is in PRIVATE_ISOLATED, not public.
- S3 bucket is VPCe-scoped.
- Bastion is opt-in and in PRIVATE_ISOLATED (SSM-only, no public IP / no SSH key).
- Secrets Manager entries are named per PLAN and hold no initial values.

## Follow-ups for Downstream Plans

- **Plan 04 (IntegrationsStack/notion-indexer):** Read `DataStack.rdsCredentialsSecret` ARN + `DataStack.rdsSecurityGroup` from `bin/kos.ts` props; attach Lambda to VPC + add SG ingress rule. Consume Drizzle `notionIndexerCursor`, `entityIndex`, `projectIndex`, `kevinContext` tables.
- **Plan 07 (SafetyStack):** Read `DataStack.dashboardBearerSecret`. The `telegram_inbox_queue` table is ready for D-13 quiet-hours suppression.
- **Plan 08 (Gate 1 verifier):** Assertions already scaffolded in `db-push.sh` live-verify block can be lifted into `scripts/verify-gate-1.mjs` (pgvector version, table count, HNSW index, 4 secret presence).
- **Future phases:** When multi-user is ever needed, the migration is: add a `users` table, drop the `owner_id` SQL DEFAULT, enforce Postgres RLS. Zero schema-reshape work.

## Self-Check: PASSED

### Files verified on disk

- FOUND: `packages/db/src/owner.ts`
- FOUND: `packages/db/src/schema.ts`
- FOUND: `packages/db/src/index.ts`
- FOUND: `packages/db/test/schema.test.ts`
- FOUND: `packages/db/drizzle/0001_initial.sql`
- FOUND: `packages/db/drizzle/0002_hnsw_index.sql`
- FOUND: `packages/db/drizzle/meta/_journal.json`
- FOUND: `packages/cdk/lib/constructs/kos-rds.ts`
- FOUND: `packages/cdk/lib/constructs/kos-bastion.ts`
- FOUND: `packages/cdk/lib/stacks/data-stack.ts`
- FOUND: `packages/cdk/test/data-stack.test.ts`
- FOUND: `scripts/seed-secrets.sh`
- FOUND: `scripts/db-push.sh`

### Commits verified in git log

- FOUND: `9f644be` — feat(01-02): Drizzle schema + owner_id on every table + pgvector migrations
- FOUND: `c50ff0a` — feat(01-02): DataStack (RDS 16.5 + pgvector, blobs bucket, secrets, bastion)
- FOUND: `21c3af8` — feat(01-02): BLOCKING db-push script + bastion-tunnel override

### Deferred but tracked

- **Task 3 live-run**: BLOCKED on operator `cdk deploy KosData --context bastion=true`. All code, tests, and runbook in place; the live assertions inside `db-push.sh` will verify pgvector 0.8.0+, 8 tables, and HNSW index on first run.
