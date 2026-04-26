# Phase 10 Plan 10-00 — Agent Execution Notes

Wave 0 scaffold for Phase 10 (Migration & Decommission: VPS Python script
ports → Lambda, n8n archive, Brain DB archive, Hetzner power-off). All 3
tasks executed end-to-end. No behaviour for the VPS adapter + Discord
poller (Wave 1+ owns); the n8n archiver ships a real implementation
because Plan 10-00 explicitly mandates a passing 3-case archiver test and
the canonicalize+SHA-256 logic is side-effect free.

## File list (created / modified)

### New service workspaces (3)

```
services/vps-classify-migration/package.json                  21
services/vps-classify-migration/tsconfig.json                 13
services/vps-classify-migration/src/types.ts                   9
services/vps-classify-migration/src/handler.ts                63  (throws NotImplementedYet)
services/vps-classify-migration/test/handler.test.ts          22  (1 real + 1 it.todo)

services/discord-brain-dump/package.json                      24
services/discord-brain-dump/tsconfig.json                     13
services/discord-brain-dump/src/types.ts                       9
services/discord-brain-dump/src/cursor.ts                    111  (real impl)
services/discord-brain-dump/src/handler.ts                    44  (throws NotImplementedYet)
services/discord-brain-dump/test/cursor.test.ts               86  (3 real cases)

services/n8n-workflow-archiver/package.json                   23
services/n8n-workflow-archiver/tsconfig.json                  13
services/n8n-workflow-archiver/src/handler.ts                132  (REAL impl)
services/n8n-workflow-archiver/test/handler.test.ts          113  (3 real cases)
```

### Contracts (Task 2)

```
packages/contracts/src/migration.ts                          122
packages/contracts/test/migration.test.ts                    121  (9 tests, all green)
packages/contracts/src/index.ts                               +1 line  (re-export)
packages/contracts/package.json                               +1 line  (./migration subpath)
```

New exports from `@kos/contracts`:

- `ClassifyPayloadSchema`           (passthrough, accepts arbitrary VPS fields)
- `ClassifyAdapterResultSchema`     (`source: 'vps-classify-migration-adapter'`)
- `DiscordChannelMessageSchema`     (Discord REST shape — id, channel_id, author{}, content, timestamp)
- `VpsServiceEntrySchema` + `VpsServiceInventorySchema`  (freeze-script export)
- `EventLogKindSchema`              (11 enum values per the plan)
- `EventLogRowSchema`               (matches existing 0001 + 0011 column shape + new `actor`)
- Type aliases for each of the above

### Migration (Task 2) — number bumped 0016 → 0021

The plan reserved migration `0016_phase_10_migration_audit.sql`, but at
execution time the `packages/db/drizzle/` directory already contained:

```
0001..0011    (Phase 1 + 2 + 3)
0012          (Phase 6 — dossier cache)
0014, 0015    (Phase 7 — top3 + writer role)
0016, 0017, 0018  (Phase 4 — email + sender + triage roles)
0019              (Phase 5 — messaging)
```

Per the plan's next-number guard, Phase 10 advances past every existing
file. The user's instructions also flagged that Phase 8 plan 08-00 is
likely to land at 0020 before Phase 10 ships, so Phase 10's scaffold
**uses 0021** (skipping 0020 entirely) to leave Phase 8 a clean slot.

The migration ALTERs the existing `event_log` table to add an `actor`
column + a complementary `event_log_owner_at_idx` index for per-owner
audit-timeline reads. The pre-existing column shape (`detail` singular +
`occurred_at`) is preserved so application code stays compatible — the
plan's draft Zod schema has been adjusted to the on-disk column names
(`detail`, `occurred_at`) rather than the plan's prose names (`details`,
`at`). Cf. `packages/contracts/src/migration.ts EventLogRowSchema`.

### CDK (Task 3)

```
packages/cdk/lib/stacks/integrations-migration.ts            246  (NEW MigrationStack)
packages/cdk/bin/kos.ts                                       +25 lines (instantiation)
packages/cdk/test/integrations-migration.test.ts             145  (5 synth tests, all green)
```

`MigrationStack` exposes:

- `KosLambda VpsClassifyMigration`   (512 MB, 30 s) + Lambda Function URL (NONE auth, BUFFERED)
- `KosLambda DiscordBrainDump`       (512 MB, 60 s)
- `KosLambda N8nWorkflowArchiver`    (512 MB, 120 s)
- `Table  DiscordBrainDumpCursor`    (PAY_PER_REQUEST, TTL=`ttl`)
- `Bucket MigrationArchive`          (KMS-encrypted, BlockPublicAccess.BLOCK_ALL)
- `Key    MigrationArchiveKey`       (annual rotation enabled)
- `CfnSchedule discord-brain-dump-poll` (`rate(5 minutes)`, retryPolicy 2/300s)
- `Role  DiscordBrainDumpSchedulerRole` (lambda:InvokeFunction scoped to the poller)
- 2 `Secret` placeholders            (`kos/vps-classify-hmac-secret`, `kos/discord-bot-token`)

CFN outputs:

- `VpsClassifyMigrationUrl`         (Function URL — Plan 10-01 sends to VPS shim)
- `MigrationArchiveBucketName`      (operator + n8n-archiver writer)
- `DiscordBrainDumpCursorTableName` (Plan 10-04 uses for ops dashboards)

`bin/kos.ts` instantiates `MigrationStack` after `DashboardStack`. Wired
deps: `events.buses.capture`, `KEVIN_OWNER_ID` (env / context), and
`DISCORD_BRAIN_DUMP_CHANNEL_IDS` (CSV in env / context). `addDependency`
on `events` keeps `cdk deploy` order correct.

### Test fixtures (Task 3)

```
packages/test-fixtures/phase-10/legacy-inbox-row.json         44
packages/test-fixtures/phase-10/command-center-row.json       45
packages/test-fixtures/phase-10/n8n-workflow.json             49  (cron + telegram nodes — rogue-caller hypothesis fixture)
packages/test-fixtures/phase-10/discord-message.json          21
packages/test-fixtures/phase-10/vps-service-inventory.json    44  (7 services per D-05 enumeration)
```

These ship as raw JSON under `packages/test-fixtures/phase-10/` (NOT
inside `packages/test-fixtures/src/`) per the plan's explicit
`files_modified` paths. Downstream wave plans can read them with
`JSON.parse(readFileSync('packages/test-fixtures/phase-10/X.json',
'utf8'))` or import them via TS resolveJsonModule.

## Verification outputs

### `pnpm install`
```
Done in 16.9s
WARN unmet peer eslint@^10 (pre-existing — not introduced by this plan)
WARN unmet peer zod (pre-existing — Phase 1 / Phase 2 deferred items)
```

### `pnpm --filter @kos/{service-vps-classify-migration,service-discord-brain-dump,service-n8n-workflow-archiver,contracts} test`
```
✓ services/vps-classify-migration   1 passed | 1 todo
✓ services/discord-brain-dump       3 passed
✓ services/n8n-workflow-archiver    3 passed
✓ packages/contracts                45 passed (Phase 4/5 + new 9 migration tests)
```

### `pnpm --filter @kos/{db,cdk,contracts,...new services} typecheck`
All clean.

### `pnpm -r typecheck`
All workspaces typecheck clean — no regressions introduced. (Repo had a
known pre-existing unmet-peer-zod warning + ESLint v10 peer warning; both
unchanged.)

### `pnpm --filter @kos/cdk test -- --run integrations-migration`
```
✓ test/integrations-migration.test.ts (5 tests) — all green
```

### `npx cdk synth KosMigration --quiet`
Stack composes; 3 Lambda asset bundles emit cleanly (502 b / 498 b / 1.6
kb minified for the Wave-0 stubs); deprecation warnings on
`logRetention` are pre-existing (KosLambda construct).

### Fixture + migration counts
```
ls services/{vps-classify-migration,discord-brain-dump,n8n-workflow-archiver}/package.json | wc -l   →  3
ls packages/test-fixtures/phase-10/*.json | wc -l                                                    →  5
grep -c 'event_log' packages/db/drizzle/0021_phase_10_migration_audit.sql                            → 11
grep -c 'EventLogKindSchema' packages/contracts/src/migration.ts                                     →  4
```

## Deviations from the plan

1. **Migration number bumped 0016 → 0021.** Plan's draft was 0016, but
   migrations 0016-0019 are already on disk (Phase 4 + 5) and the user's
   plan-10 dispatch instruction reserved 0020 for Phase 8 plan 08-00.
   Phase 10 starts at 0021 to leave Phase 8 a clean slot.

2. **`event_log` already exists.** The table was created in migration
   0001 with columns `(id, owner_id, kind, detail, occurred_at)`. Plan
   10-00's draft introduced the table fresh with renamed columns
   (`details`, `at`). To preserve compatibility with all existing
   readers (Phase 4 dead-letter logs, future Phase 7 audit reads), the
   Phase 10 migration only **adds** an `actor` column + a complementary
   `(owner_id, occurred_at DESC)` index. Zod schemas in
   `EventLogRowSchema` track the on-disk column names.

3. **`vps-classify-migration` — `it.todo` instead of `describe.skip`.**
   The plan asked for a `it.todo` for the Wave-1 HMAC test; that's
   honoured. The "real" test in the file confirms `import('../src/handler')
   `resolves and `handler` is a function.

4. **`n8n-workflow-archiver` ships a real handler body.** Plan's `done`
   gate explicitly requires "archiver test passes 3/3"; the canonicalize
   + SHA-256 + S3 PutObject flow is side-effect free + cleanly testable
   with `aws-sdk-client-mock`, so it ships fully implemented in Wave 0.
   `aws-sdk-client-mock@4` has a typing-mismatch with
   `@aws-sdk/client-s3@3.691.0`; resolved with a single `as any` at the
   `mockClient(S3Client)` boundary (documented inline in the test).

5. **`MigrationStack` Secrets are placeholders, not pre-existing
   imports.** Plan's draft mentioned `notionSecretArn` /
   `telegramHmacSecretArn` / `kmsKeyArn` as inputs. Phase 10's scaffold
   creates new Secret + KMS Key resources with `RemovalPolicy.RETAIN` —
   Plans 10-01 / 10-04 / 10-05 will swap to operator-pre-seeded ARNs via
   the `props.{vpsClassifyHmacSecret,discordBotTokenSecret,archiveKey}`
   override surface. Equivalent to how `wireBaileysSidecar` ships its
   own placeholder webhook secret in Phase 5.

6. **No `VPC` requirement on the Migration Lambdas.** The 3 Lambdas
   reach Discord / VPS / S3 / EventBridge / DynamoDB only — all via
   public AWS endpoints + Secrets Manager. None hits RDS, so following
   D-05 they live OUTSIDE the VPC (no NAT cost, no cold-start tax).

## Downstream plans unblocked

With Wave 0 in place, these Phase 10 plans can now execute in parallel:

- **Plan 10-01** (VPS classify_and_save adapter — Wave 1 fills handler body)
- **Plan 10-02** (n8n archive — wire the archiver Lambda + flip n8n into
  STOPPED state)
- **Plan 10-03** (Brain DB archive — uses the same archive bucket +
  emits `brain-db-archived` event_log rows)
- **Plan 10-04** (Discord brain-dump Lambda body — the cursor module is
  already done; Wave 4 only writes the polling loop)
- **Plan 10-05** (operator IAM role + per-prefix bucket ACL)
- **Plan 10-06** (verifier scripts — diff legacy vs new pipelines pre
  power-down)

Plan 10-07 (Hetzner power-off) stays `autonomous: false` — Wave 0 has
NOT touched the VPS itself.

## What was NOT done (per plan instructions)

- No `git add`, `git commit`, `git push`.
- No CDK / Terraform / cloud touches (synth-test only).
- No real n8n export / Discord token / KMS key written; placeholders only.
- No deployment of `MigrationStack` (kept synth-only until Plans 10-01+
  approve operator-readiness).

## Risks logged for downstream plans

1. **Migration 0021 hard-codes the column shape.** If Phase 8 (which the
   user said may land at 0020 between this scaffold + Phase-10 Wave 1)
   touches `event_log`, the index name `event_log_owner_at_idx` could
   collide. CREATE INDEX IF NOT EXISTS protects the runtime path; downstream
   should re-verify before deploy.

2. **`MigrationStack` is added to `bin/kos.ts` but NOT to the integration
   test app harness.** This is intentional (Wave 0 ships behind a synth-
   only contract) — Phase 10 Plan 10-01 must add `MigrationStack`
   instantiation to any new e2e test apps it adds.

3. **`DISCORD_BRAIN_DUMP_CHANNEL_IDS` env var is empty by default.** A
   Wave-0 deploy would result in a Scheduler firing every 5 min with an
   empty channel list. The Wave-4 handler must treat empty input as a
   no-op + emit a CloudWatch metric so the empty-config state is
   observable.

End of agent notes.
