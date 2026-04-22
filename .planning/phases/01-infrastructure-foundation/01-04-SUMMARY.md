---
phase: 01-infrastructure-foundation
plan: 04
subsystem: infrastructure
tags: [notion, indexer, cdk, rds-proxy, iam-auth, eventbridge-scheduler, entity-graph, mem-02]
dependency_graph:
  requires:
    - Plan 01-02 (DataStack.rdsCredentialsSecret, DataStack.notionTokenSecret, Drizzle tables)
    - Plan 01-03 (EventsStack.buses.capture, EventsStack.buses.system, kos-schedules group)
  provides:
    - IntegrationsStack.notionIndexer — the 5-min poller Lambda (Entities/Projects/KevinContext/CommandCenter)
    - IntegrationsStack.notionIndexerBackfill — one-shot full-scan loader
    - IntegrationsStack.notionReconcile — weekly hard-delete detector
    - DataStack.rdsProxy / rdsProxyEndpoint / rdsProxyDbiResourceId — shared by all future RDS-accessing Lambdas
    - integrations-notion.ts helper pattern — Plans 05/06 mirror with integrations-azure.ts / integrations-transcribe.ts
    - 5 EventBridge Scheduler entries (4 indexer + 1 reconcile) in Europe/Stockholm
    - scripts/.notion-db-ids.json as the canonical ID manifest consumed by CDK + future plans
  affects:
    - Every Phase 2+ agent that reads entity_index / project_index / kevin_context reads data that flows via this plan
    - Plan 07 SafetyStack VPS freeze reuses scripts/.notion-db-ids.json legacyInbox id
tech_stack:
  added:
    - "@notionhq/client@2.3.0 (bootstrap + all 3 indexer-family Lambdas)"
    - "@aws-sdk/rds-signer@3.691.0 (IAM auth to RDS Proxy — T-01-PROXY-01 mitigation)"
    - "@aws-sdk/client-secrets-manager@3.691.0"
    - "@aws-sdk/client-eventbridge@3.691.0"
    - "ulid@2.3.0 (capture IDs on notion-write-confirmed events)"
    - "aws-cdk-lib/aws-rds DatabaseProxy + ProxyTarget (new RDS Proxy construct)"
    - "aws-cdk-lib/aws-scheduler CfnSchedule (5 new schedules)"
  patterns:
    - "IntegrationsStack is a thin orchestration class — per-subsystem wiring (Notion, Azure, Transcribe) lives in sibling integrations-*.ts helpers so Waves 3 plans never merge-conflict on a single file"
    - "Indexer Lambdas live OUTSIDE VPC; reach RDS via the Proxy's public endpoint (D-05 no-NAT compliance); password auth is fully gone — IAM token minted per cold-start"
    - "Cursor advances ONLY after full pagination success; mid-pagination failure writes last_error and leaves last_cursor_at untouched (Pitfall 3 guard + idempotent retry)"
    - "Kevin Context page is processed by walking heading_2 + paragraph pairs; each section is upserted into kevin_context keyed on notion_block_id so in-place edits flow through cleanly"
    - "Hard-delete detection split across layers: upsert.ts.handleArchivedOrMissing for anomaly cases, notion-reconcile weekly full-scan for the canonical detection; entity_index / project_index NEVER mutated on delete (archive-not-delete)"
key_files:
  created:
    - scripts/bootstrap-notion-dbs.mjs
    - scripts/.notion-db-ids.json (placeholder)
    - scripts/verify-indexer-roundtrip.mjs (deferred to operator)
    - scripts/backfill-notion.sh (deferred to operator)
    - services/notion-indexer/package.json
    - services/notion-indexer/tsconfig.json
    - services/notion-indexer/src/handler.ts
    - services/notion-indexer/src/upsert.ts
    - services/notion-indexer/src/notion-shapes.ts
    - services/notion-indexer/test/indexer.test.ts
    - services/notion-indexer-backfill/package.json
    - services/notion-indexer-backfill/tsconfig.json
    - services/notion-indexer-backfill/src/handler.ts
    - services/notion-reconcile/package.json
    - services/notion-reconcile/tsconfig.json
    - services/notion-reconcile/src/handler.ts
    - packages/cdk/lib/stacks/integrations-stack.ts
    - packages/cdk/lib/stacks/integrations-notion.ts
    - packages/cdk/test/integrations-stack-notion.test.ts
  modified:
    - packages/cdk/lib/stacks/data-stack.ts (added DatabaseProxy + IAM auth + SG rules)
    - packages/cdk/bin/kos.ts (wired IntegrationsStack)
    - package.json (+ @notionhq/client dep + notion:bootstrap script)
decisions:
  - "RDS Proxy with IAM auth is the chosen D-05-compliant path for out-of-VPC Lambdas reaching RDS. Password auth removed from the steady-state indexer; notion-indexer-backfill still has RDS_SECRET_ARN wired but also uses IAM signer — it carries both for Phase 2 migration symmetry."
  - "Proxy SG rule allowFromAnyIpv4(5432) is intentional. Lambda egress IPs are non-deterministic; IAM auth (rds-db:connect resource-scoped to prx-<id>/kos_admin) is the authorization gate. The alternative — placing the Lambda in VPC + NAT Gateway — violates D-05."
  - "IntegrationsStack split into a thin class + per-subsystem helper file (integrations-notion.ts). Coordination with parallel Wave 3 Plans 05/06: each adds its own integrations-*.ts file plus a call from the main class constructor, minimising diff overlap."
  - "scripts/.notion-db-ids.json committed with placeholder IDs so CDK synth + tests run without a live Notion bootstrap. Operator MUST run `pnpm notion:bootstrap` post-deploy and commit the resulting real IDs — CDK synth reads them at deploy time."
  - "Notion hard-delete detection is split: upsert.ts.handleArchivedOrMissing remains a unit-testable helper for anomaly cases (manual page retrieves); notion-reconcile weekly Lambda is the canonical detector (databases.query does not surface deleted pages). Both paths write event_log kind='notion-hard-delete'; neither mutates entity_index — archive-not-delete holds."
  - "Kevin Context (MEM-02) handled inline in the indexer rather than as a separate Lambda. Walks heading_2 + paragraph blocks via notion.blocks.children.list and upserts sections keyed on notion_block_id. Makes prompt-cache-ready context reads trivial for Phase 2+."
metrics:
  completed: 2026-04-22
  duration_minutes: ~45
  tasks_completed: 3
  tasks_total: 3
  files_created: 19
  files_modified: 3
requirements:
  - ENT-01
  - ENT-02
  - MEM-01
  - MEM-02
---

# Phase 01 Plan 04: Notion Indexer + RDS Proxy + IntegrationsStack Summary

The 5-min Notion → RDS poller, the one-shot full-scan backfill, and the weekly hard-delete reconciler all ship alongside an RDS Proxy that gates Lambda access via IAM auth — staying D-05-compliant (no NAT Gateway) while giving every out-of-VPC Lambda a production-grade path to Postgres.

## Objective

Close the Phase 1 entity-graph loop: a human edits a Notion page → within 5 min the edit is visible in `entity_index` / `project_index` / `kevin_context` → downstream agents can load context from Postgres. Hard-deletes are detected via a separate weekly reconciler, never mutate the local row (archive-not-delete per D-09).

## Outcome

- **Notion bootstrap:** `scripts/bootstrap-notion-dbs.mjs` idempotently creates 4 DBs (Entities 13 fields, Projects 6 fields, Kevin Context page 6 sections, Legacy Inbox for Plan 07), plus pins the pre-existing Command Center DB ID — all five land in `scripts/.notion-db-ids.json` (D-11 watched DBs = 4).
- **Three Lambdas** (TypeScript, Node 22, ARM64, esbuild-bundled via KosLambda):
  - `notion-indexer` — D-08 poller with 2-min overlap, idempotent upsert keyed on `(notion_page_id, last_edited_time)`, archive-not-delete, cursor advance only on full-pagination success, publishes `kos.capture notion-write-confirmed` per successful upsert.
  - `notion-indexer-backfill` — D-10 one-shot full scan, 350 ms leaky-bucket between Notion calls, same upsert helpers (second run reports `rows_inserted=0`).
  - `notion-reconcile` — T-01-INDEX-02 weekly Sun 04:00 Stockholm full scan vs RDS, writes `event_log kind='notion-hard-delete'` + publishes `kos.system notion-hard-delete-detected` for dashboards.
- **DataStack.rdsProxy:** DatabaseProxy with `iamAuth=true`, `requireTLS=true`, `allowFromAnyIpv4(5432)` + IAM-auth-only credential path. Exposed endpoint + DbiResourceId for downstream plans.
- **IntegrationsStack:** thin orchestrator; Notion wiring lives in sibling `integrations-notion.ts` so Plans 05/06 land their helpers without conflict. Installs 5 EventBridge Scheduler entries (4 indexer × 5-min + 1 weekly reconcile), all in Europe/Stockholm.
- **Tests:** 5 indexer unit tests (2-min overlap, skip-when-older, hard-delete logs event_log without mutation, Status='Archived' flows through normal upsert, cursor does not advance on mid-pagination error) + 7 synth-level CDK tests (schedule count, rate + timezone, reconcile cron, nodejs22.x/arm64, RDS Proxy RequireTLS + IAMAuth, rds-db:connect policy present). All green.
- **Typecheck + CDK synth:** `pnpm --filter @kos/service-notion-indexer typecheck` = 0, `pnpm --filter @kos/service-notion-indexer-backfill typecheck` = 0, `pnpm --filter @kos/service-notion-reconcile typecheck` = 0, `pnpm --filter @kos/cdk typecheck` = 0, `cdk synth KosIntegrations --quiet` = 0. All 29 CDK tests pass.

## Tasks Completed

| Task | Name                                                         | Commit    | Files                                                                                                                                         |
| ---- | ------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Notion bootstrap (Entities/Projects/Kevin Context/Legacy Inbox) | `ee5925b` | `scripts/bootstrap-notion-dbs.mjs`, `package.json`, `pnpm-lock.yaml`                                                                          |
| 2    | notion-indexer + backfill + reconcile Lambdas (+ 5 tests)    | `ebe2a87` | `services/notion-indexer/**`, `services/notion-indexer-backfill/**`, `services/notion-reconcile/**`                                           |
| 3    | IntegrationsStack + RDS Proxy + roundtrip + backfill scripts | `8f37893` | `packages/cdk/lib/stacks/{data-stack.ts,integrations-stack.ts,integrations-notion.ts}`, `packages/cdk/bin/kos.ts`, `packages/cdk/test/integrations-stack-notion.test.ts`, `scripts/.notion-db-ids.json`, `scripts/verify-indexer-roundtrip.mjs`, `scripts/backfill-notion.sh` |

Total: **3 tasks committed, 22 files touched (19 created, 3 modified).**

## Verification Results

### Static (all green in this worktree)

| Check                              | Command                                                       | Result                                     |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| Notion bootstrap grep sweep        | 13 Entity + 6 Project + 6 Kevin Context section + Legacy Inbox + `EXISTING_COMMAND_CENTER_DB_ID` + `databases.create` greps | all pass                                   |
| Node syntax check                  | `node -c scripts/bootstrap-notion-dbs.mjs`                    | 0                                          |
| notion-indexer typecheck           | `pnpm --filter @kos/service-notion-indexer typecheck`         | 0                                          |
| notion-indexer tests               | `pnpm --filter @kos/service-notion-indexer test -- --run`     | 5/5 passed                                 |
| backfill typecheck                 | `pnpm --filter @kos/service-notion-indexer-backfill typecheck`| 0                                          |
| reconcile typecheck                | `pnpm --filter @kos/service-notion-reconcile typecheck`       | 0                                          |
| CDK typecheck                      | `pnpm --filter @kos/cdk typecheck`                            | 0                                          |
| CDK tests                          | `pnpm --filter @kos/cdk test -- --run`                        | 29/29 passed                               |
| CDK synth KosIntegrations          | `cd packages/cdk && npx cdk synth KosIntegrations --quiet`    | 0 (all 3 Lambdas bundle in <600 ms each)   |
| `integrations-notion.ts` has rate(5m) + Europe/Stockholm | grep                                                          | present                                    |
| `data-stack.ts` has DatabaseProxy + rdsProxyEndpoint | grep                                                          | present                                    |
| `kos.ts` wires IntegrationsStack   | grep                                                          | present                                    |
| Scripts executable                 | `test -x scripts/verify-indexer-roundtrip.mjs && test -x scripts/backfill-notion.sh` | 0                                          |

### Deferred to Operator (real AWS / real Notion required)

These **cannot** run from the worktree per environment_guardrails. All code + scripts are complete; operator runs them with live credentials.

1. **Notion bootstrap**
   ```bash
   export NOTION_TOKEN=secret_...
   export NOTION_PARENT_PAGE_ID=<uuid-of-kos-parent-page>
   export EXISTING_COMMAND_CENTER_DB_ID=<existing-command-center-uuid>
   pnpm notion:bootstrap
   # commit the updated scripts/.notion-db-ids.json (git-tracked)
   ```
   Expected: 4 new DBs created on first run, 0 new DBs on second run, all IDs in `scripts/.notion-db-ids.json`.

2. **CDK deploy**
   ```bash
   cd packages/cdk
   # Re-synth to capture the real Notion IDs into the Lambda env (CDK reads
   # .notion-db-ids.json at synth time):
   npx cdk deploy KosIntegrations --require-approval never
   ```
   Expected: KosIntegrations + updated DataStack (with RDS Proxy) deploy clean. After deploy, `aws scheduler list-schedules --group-name kos-schedules --region eu-north-1 --query "length(Schedules[?starts_with(Name, 'notion-indexer-')])"` returns `4`.

3. **Round-trip canary**
   ```bash
   KOS_DB_TUNNEL_PORT=15432 node scripts/verify-indexer-roundtrip.mjs
   ```
   Expected: exit 0 within 7 min; canary row present in `entity_index` with matching name.

4. **Backfill idempotency**
   ```bash
   AWS_REGION=eu-north-1 bash scripts/backfill-notion.sh
   ```
   Expected: second invocation per DB returns `rows_inserted=0`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] TypeScript `rootDir` fight in backfill tsconfig**
- **Found during:** Task 2 typecheck of `@kos/service-notion-indexer-backfill`.
- **Issue:** The backfill service imports `upsertEntity / upsertProject / upsertKevinContextSection` from `../notion-indexer/src/upsert.ts` to guarantee the idempotent contract is literally the same code. tsc rejected this with TS6059 (outside rootDir).
- **Fix:** dropped `rootDir` from `services/notion-indexer-backfill/tsconfig.json` and added the two cross-service source files to `include`. This keeps a single source of truth for the upsert logic.
- **Files modified:** `services/notion-indexer-backfill/tsconfig.json`
- **Commit:** `ebe2a87`

**2. [Rule 1 — Bug] Indexer handler's `indexKevinContextPage` return type mismatch**
- **Found during:** Task 2 typecheck.
- **Issue:** `upsertKevinContextSection` returns `UpsertResult` (includes `'hard-delete-logged'`), but `indexKevinContextPage` declared `'inserted' | 'updated' | 'skipped'`. tsc correctly flagged the union assignment.
- **Fix:** narrowed the branch condition from `outcome.action !== 'skipped'` to `outcome.action === 'inserted' || outcome.action === 'updated'` so only the two valid variants flow through.
- **Files modified:** `services/notion-indexer/src/handler.ts`
- **Commit:** `ebe2a87`

**3. [Rule 3 — Blocking] CDK synth-time dependency on `.notion-db-ids.json`**
- **Found during:** Task 3 first `cdk synth` attempt.
- **Issue:** `integrations-notion.ts` reads `.notion-db-ids.json` at synth time (CDK bundling phase). Without a committed placeholder, synth fails in any clean checkout — breaking CI + future fresh clones.
- **Fix:** committed `scripts/.notion-db-ids.json` with `"pending-bootstrap"` placeholder values. Operator re-runs `pnpm notion:bootstrap` → JSON file is overwritten with real IDs → next `cdk deploy` reads them. This isn't a security leak (no secrets) and the git-tracked file is the canonical source of truth per Task 1 acceptance criteria.
- **Files created:** `scripts/.notion-db-ids.json`
- **Commit:** `8f37893`

**4. [Rule 1 — Bug] CDK test "all Lambdas arm64" false-positive on log-retention helper**
- **Found during:** Task 3 integrations-stack-notion.test.ts first run.
- **Issue:** The assertion iterated ALL `AWS::Lambda::Function` resources in the template. CDK's log-retention helper is a managed Lambda with no explicit Architectures attribute, causing the test to fail with `expected undefined to deeply equal ['arm64']`.
- **Fix:** scoped the assertion to KOS Lambdas by filtering logical IDs matching `^Notion(Indexer|IndexerBackfill|Reconcile)`. The three KOS Lambdas are the ones the test is about; CDK-managed helpers are out of scope.
- **Files modified:** `packages/cdk/test/integrations-stack-notion.test.ts`
- **Commit:** `8f37893`

### Design hardening (beyond PLAN pseudocode)

- **`handleArchivedOrMissing` hardened to re-throw non-404s:** the PLAN implied a try/catch that swallows everything as a hard-delete. Restricted to `error.code === 'object_not_found'`; any other error (503, 429, network) re-throws so the caller's pagination retry logic kicks in.
- **`pg.Pool` returns no row when WHERE clause excludes conflict update:** upsert helpers defensively return `{ action: 'skipped' }` when `RETURNING` produces zero rows (older row already wins). Without this, the UpsertResult type would widen to include undefined at runtime.
- **Notion number percent conversion:** Notion's `number.format: percent` returns values in 0.0-1.0 range; stored as 0-100 integers in `entity_index.confidence` (int column). Guard converts only if value <= 1 to stay idempotent across re-imports.

### No architectural Rule 4 items

No Rule 4 architectural pauses were needed. The RDS-Proxy-with-IAM-auth decision was already in the PLAN's Step 1-2 architectural section, not a runtime discovery.

## Threat Register Status

| Threat ID      | Component                                                     | Mitigation Status | Notes                                                                                                                     |
| -------------- | ------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| T-01-04        | Notion page body treated as trusted                           | **mitigated (code)** | `notion-shapes.ts` extracts only structured property values (title, select.name, rich_text.plain_text, number, date, multi_select[].name). Block content for all DBs except Kevin Context is ignored. Kevin Context walks only heading_2 + paragraph plain_text — no attribute/href extraction. |
| T-01-04b       | NOTION_TOKEN in Lambda logs                                   | **mitigated (code)** | Token fetched via Secrets Manager once per cold start; held in module scope; never passed to `console.log`. CloudWatch retention 30d (KosLambda default).                                   |
| T-01-INDEX-01  | Notion 429 rate limits                                        | **mitigated (code)** | `@notionhq/client` has internal retry on 429. Backfill additionally sleeps 350 ms between pages (~3 req/s leaky-bucket). Cursor advances only on full pagination success — mid-429 failures are automatically retried next tick with full idempotency. |
| T-01-INDEX-02  | Notion hard-delete wipes local row                            | **mitigated (code)** | 5-min poller's `handleArchivedOrMissing` logs `event_log kind='notion-hard-delete'` on object_not_found without mutating the row. Weekly `notion-reconcile` (Sun 04:00 Europe/Stockholm) is the canonical full-scan detector. `entity_index` / `project_index` are NEVER mutated on delete (D-09 archive-not-delete). |
| T-01-PROXY-01  | RDS Proxy open to 0.0.0.0/0 on port 5432 (password auth bypass) | **mitigated (code)** | `DatabaseProxy` has `iamAuth: true`, `requireTLS: true`; the `kos_admin` password path is no longer on any trusted code path (the steady-state indexer + reconcile mint IAM tokens via `@aws-sdk/rds-signer`). `rds-db:connect` on `prx-<id>/kos_admin` is the ONLY accepted credential. TLS mandatory. `allowFromAnyIpv4` is documented as an intentional tradeoff: Lambda egress IPs are non-deterministic; IAM auth is the authorization gate. The alternative (Lambda-in-VPC + NAT Gateway) violates D-05. |

## Known Stubs

- **`scripts/.notion-db-ids.json` holds `"pending-bootstrap"` placeholder values.** Intentional: it's the synth-time dependency that must exist before `cdk synth` for CI / fresh-clone bootstrapping. The operator runbook (step 1) replaces them with real IDs; the file is git-tracked so the real IDs land in version control.
- **`notion-indexer-backfill` Lambda still has `RDS_SECRET_ARN` wired for parity with migration plans.** The handler itself uses the IAM signer path (identical to steady-state indexer); the secret is read-only-granted because Phase 2 may regress temporarily while we migrate. Documented as "known gap" in the plan — full IAM-only path lands when Phase 2 touches this Lambda next.
- **`command_center` dbKind writes only `event_log kind='notion-indexed-other'` rows in Phase 1.** Full Command Center processing (per-row upsert into a yet-unmodelled table) is Phase 2+ scope; the indexer still runs every 5 min so the counts accumulate, surfacing Command Center activity on the dashboard when the frontend lands in Phase 3.
- **Kevin Context backfill writes a `BACKFILL-PLACEHOLDER` row.** The steady-state indexer walks heading_2 + paragraph pairs on every 5-min poll — so the first steady-state tick replaces the placeholder with real section rows. Documented as intentional because running the full block-walk inside the backfill Lambda would double the Notion API budget for negligible benefit.

## Threat Flags

None. All new surface is within the plan's `<threat_model>`. The RDS Proxy introduces a new public network surface (the proxy endpoint), but it's gated by IAM auth + TLS and covered by T-01-PROXY-01.

## Follow-ups for Downstream Plans

- **Plans 05 (Azure Search bootstrap) and 06 (Transcribe vocab deploy):** mirror the `integrations-notion.ts` helper pattern — add `integrations-azure.ts` / `integrations-transcribe.ts` and call them from `IntegrationsStack`'s constructor. This plan's class deliberately accepts optional wiring through helpers so those plans land additively.
- **Plan 07 (SafetyStack):** consume `scripts/.notion-db-ids.json .legacyInbox` for the VPS freeze redirect. The bootstrap created the Legacy Inbox DB with the `[MIGRERAD]` marker field ready per PROJECT.md convention.
- **Plan 08 (Gate 1 verifier):** add assertions for (a) 4 `notion-indexer-*` schedules under `kos-schedules`, (b) 1 `notion-reconcile-weekly` schedule, (c) RDS Proxy with IAM auth present, (d) round-trip script exits 0.
- **Phase 2 (indexer + backfill IAM-auth parity):** remove `RDS_SECRET_ARN` from `notion-indexer-backfill` once Phase 2 stops needing it as an escape hatch. One-line Env change + IAM policy cleanup.

## Operator Runbook Summary

```bash
# 1. Seed NOTION_TOKEN into Secrets Manager (already scaffolded by Plan 02).
bash scripts/seed-secrets.sh

# 2. Bootstrap Notion DBs (once — idempotent if re-run).
export NOTION_TOKEN=secret_...
export NOTION_PARENT_PAGE_ID=...
export EXISTING_COMMAND_CENTER_DB_ID=...
pnpm notion:bootstrap
# commit the updated scripts/.notion-db-ids.json

# 3. Deploy the infra.
cd packages/cdk && npx cdk deploy KosIntegrations --require-approval never

# 4. Verify round-trip (needs bastion tunnel OR Proxy password creds).
KOS_DB_TUNNEL_PORT=15432 node scripts/verify-indexer-roundtrip.mjs

# 5. Prove backfill idempotency.
AWS_REGION=eu-north-1 bash scripts/backfill-notion.sh
```

## Self-Check: PASSED

### Files verified on disk

- FOUND: `scripts/bootstrap-notion-dbs.mjs`
- FOUND: `scripts/.notion-db-ids.json`
- FOUND: `scripts/verify-indexer-roundtrip.mjs`
- FOUND: `scripts/backfill-notion.sh`
- FOUND: `services/notion-indexer/package.json`
- FOUND: `services/notion-indexer/tsconfig.json`
- FOUND: `services/notion-indexer/src/handler.ts`
- FOUND: `services/notion-indexer/src/upsert.ts`
- FOUND: `services/notion-indexer/src/notion-shapes.ts`
- FOUND: `services/notion-indexer/test/indexer.test.ts`
- FOUND: `services/notion-indexer-backfill/package.json`
- FOUND: `services/notion-indexer-backfill/tsconfig.json`
- FOUND: `services/notion-indexer-backfill/src/handler.ts`
- FOUND: `services/notion-reconcile/package.json`
- FOUND: `services/notion-reconcile/tsconfig.json`
- FOUND: `services/notion-reconcile/src/handler.ts`
- FOUND: `packages/cdk/lib/stacks/integrations-stack.ts`
- FOUND: `packages/cdk/lib/stacks/integrations-notion.ts`
- FOUND: `packages/cdk/lib/stacks/data-stack.ts` (modified — adds DatabaseProxy)
- FOUND: `packages/cdk/bin/kos.ts` (modified — wires IntegrationsStack)
- FOUND: `packages/cdk/test/integrations-stack-notion.test.ts`

### Commits verified in git log

- FOUND: `ee5925b` — feat(01-04): notion bootstrap script for 4 DBs + Kevin Context page
- FOUND: `ebe2a87` — feat(01-04): notion-indexer + backfill + reconcile lambdas
- FOUND: `8f37893` — feat(01-04): IntegrationsStack + RDS Proxy (IAM auth) + roundtrip scripts

### Deferred-but-tracked tasks

- **Live Notion bootstrap** — operator runs `pnpm notion:bootstrap` with `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID` + `EXISTING_COMMAND_CENTER_DB_ID` set.
- **Live CDK deploy** — operator runs `cdk deploy KosIntegrations` after re-synth with real IDs in `.notion-db-ids.json`.
- **Live round-trip verify** — operator runs `scripts/verify-indexer-roundtrip.mjs` against the real Proxy endpoint.
- **Live backfill idempotency** — operator runs `scripts/backfill-notion.sh` after deploy.
