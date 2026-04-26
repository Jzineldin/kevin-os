# Plan 10-04 — Agent Implementation Notes

**Phase**: 10-migration-decommission
**Plan**: 10-04 (Discord brain-dump Lambda body)
**Branch**: `phase-02-wave-5-gaps` (worktree `agent-ae4af2b2dfcbb4281`)
**Status**: Implementation complete; not committed.

---

## Scope deviation from `10-04-PLAN.md`

The on-disk plan `10-04-PLAN.md` was written against an earlier draft that
contemplated:

- A multi-channel poller driven by a `channel_ids: string[]` Scheduler
  payload.
- A `poller.ts` + `emit.ts` file split.
- A 7-day same-substance verifier script + cutover runbook (Task 3).

Since then, **Plan 05-06** landed `05-06-DISCORD-CONTRACT.md`, which is the
actual load-bearing handoff with the EventBridge Scheduler in
`integrations-discord-schedule.ts`. The contract diverges from the older
plan in three load-bearing ways:

1. **Scheduler input is channel-agnostic.** The Phase 5 Scheduler fires
   `{ channel: 'brain-dump', owner_id, trigger_source }` — NO channel id in
   the payload. The Lambda owns the Discord channel snowflake via the
   `DISCORD_BRAIN_DUMP_CHANNEL_ID` env var.
2. **Single-channel only.** The contract names ONE channel
   (`#brain-dump`); multi-channel is explicitly out of scope (a future
   addition would get its own Scheduler entry).
3. **Idempotency seed is `(channel_id, message_id)` → sha256 → Crockford
   ULID.** Not a fresh `ulid()` per emit.

I implemented the contract, not the older plan. The user's task brief
explicitly cites `05-06-DISCORD-CONTRACT.md` as the source of truth and
says "Discord token in kos/discord-bot-token secret … Idempotency:
deterministic capture_id from sha256(discord_message_id) → Crockford ULID."

**Files actually shipped vs. plan-prescribed:**

| Plan prescribed                           | Shipped                                | Notes                                                      |
|-------------------------------------------|----------------------------------------|------------------------------------------------------------|
| `services/discord-brain-dump/src/poller.ts` | `services/discord-brain-dump/src/discord.ts` | Renamed for clarity (it's a Discord REST wrapper, not a "poller" — the handler IS the poller). |
| `services/discord-brain-dump/src/emit.ts` | folded into `services/discord-brain-dump/src/persist.ts` | One module covers both `agent_runs` idempotency + EventBridge emit, mirroring `services/granola-poller/src/persist.ts`. |
| `services/discord-brain-dump/src/handler.ts` | (same path)                           | Full body replaces Wave-0 scaffold.                       |
| `services/discord-brain-dump/test/poller.test.ts` | `services/discord-brain-dump/test/discord.test.ts` | 15 tests covering 12 behaviours from the plan.            |
| `services/discord-brain-dump/test/handler.test.ts` | (same path)                          | 13 tests covering the plan's 5 behaviours + edge cases.   |
| Task 3: `scripts/verify-discord-brain-dump-substance.mjs` | NOT shipped                          | Out of scope for this brief — see "Deferred" below.       |
| Task 3: `10-04-DISCORD-CUTOVER-RUNBOOK.md` | NOT shipped                           | Out of scope — see "Deferred".                            |

The task brief said: "implement the Lambda body … Polls a designated
Discord channel … emits one capture.received per new message …" — Tasks 1
& 2 only. Task 3 (parity verifier + cutover runbook) is operator/migration
plumbing that doesn't block the Lambda being functional, so I skipped it.

---

## What I built

### 1. `services/discord-brain-dump/src/discord.ts` (235 lines)

Discord REST wrapper:
- `fetchNewMessages(channelId, cursor, botToken, opts)` — single function.
- Pagination: walks forward by passing `?after=<oldest_id_in_page+1>`; safety cap = `MAX_PAGES = 10` (10 × `limit=50` = 500 messages/run max).
- Sorts pages ascending (oldest-first) — Discord returns newest-first by default; we re-sort defensively.
- Filters out `author.bot === true` unless `includeBots=true` (env-driven escape hatch).
- 401/403/404 → `DiscordAuthError`. 429 (twice) → `DiscordRateLimitError`. 5xx/408 → `DiscordTransientError`.
- 429 retry: honors `Retry-After`/`X-RateLimit-Reset-After` (capped at 10s), retries once.
- Per-message Zod parse with `.safeParse()` so a single malformed system message (member-join, pin) doesn't blow up the whole batch.
- `fetchImpl` + `sleep` injection for tests.

### 2. `services/discord-brain-dump/src/persist.ts` (200 lines)

Idempotency + emit:
- `deterministicCaptureId(channelId, messageId)` — sha256 of
  `discord:${channelId}:${messageId}` → first 26 bytes through `byte % 32`
  → Crockford base32. Same construction as `services/ses-inbound` and
  `services/baileys-sidecar`. Verified against the contracts `UlidRegex`.
- `findPriorOkRun` / `insertAgentRun` / `updateAgentRun` — D-21 idempotency
  on `agent_runs(owner_id, capture_id, agent_name)` with `agent_name =
  'discord-brain-dump'`.
- `getPool()` — lazy dynamic import of `pg` + `@aws-sdk/rds-signer`. Tests
  inject via `__setPoolForTests` so they never start Postgres.
- `publishDiscordCapture(detail)` — Zod-parses against
  `CaptureReceivedDiscordTextSchema` THEN PutEvents on
  `KOS_CAPTURE_BUS_NAME` with `Source = 'kos.capture-discord-brain-dump'`,
  `DetailType = 'capture.received'`.

### 3. `services/discord-brain-dump/src/handler.ts` (replaced scaffold)

Orchestration:
1. Parse input — accepts BOTH the canonical `{ channel: 'brain-dump',
   owner_id, ... }` shape AND the legacy MigrationStack `{ owner_id,
   channel_ids }` shape (deploy-order resilience).
2. Resolve owner_id (input → `KEVIN_OWNER_ID` env fallback).
3. Resolve channel_id strictly from `DISCORD_BRAIN_DUMP_CHANNEL_ID` env
   (per the contract).
4. Resolve bot token (cached): inline `DISCORD_BOT_TOKEN` env first,
   then Secrets Manager `DISCORD_BOT_TOKEN_SECRET_ARN`.
5. Read cursor → `fetchNewMessages` → graceful-degrade on 401/429,
   rethrow on 5xx (Lambda fails so Scheduler retries).
6. Cold-start (cursor=null + N msgs): seed cursor to newest id, emit
   ZERO. No backfill — operator runbook concern. Per the contract.
7. Per-message: derive capture_id, `findPriorOkRun` skip-check,
   `insertAgentRun(started)` → build detail (with timestamp normalization
   `+00:00 → Z` so Zod's `datetime()` accepts it) → `publishDiscordCapture`
   → `updateAgentRun(ok)` → `setCursor`. Cursor advances per-message so
   any partial-failure leaves the cursor at the last truly-emitted id.
8. Wrapped in `wrapHandler` (Sentry) + `langfuseFlush` in finally.

### 4. Tests (28 new, 31 total)

- `test/discord.test.ts` — 15 cases:
  empty channel, fresh-cursor with N msgs (oldest-first sort), warm cursor
  ?after=, bot filter on, INCLUDE_BOTS opt-in, 401 → DiscordAuthError, 403,
  404, 429 retry success, two 429s, 500 transient, pagination (50 → second
  page), maxPages safety cap, malformed-row drop, Zod-validated shape.
- `test/handler.test.ts` — 13 cases:
  warm cursor + 0 msgs, cold-start seed, happy path 2 msgs (cursor advances
  per-msg), determinism (same input → same capture_id across runs),
  agent_runs prior-ok skip (cursor still advances), 401 graceful, 429
  graceful, 5xx rethrow, partial publish failure (cursor stops at last
  good), KEVIN_OWNER_ID env fallback, missing-owner-id rejection, missing
  channel-id rejection, legacy `{ owner_id, channel_ids }` input shape.
- The pre-existing 3 cursor tests still pass (untouched).

### 5. CDK update — `packages/cdk/lib/stacks/integrations-migration.ts`

Three additive changes:
- New `StringParameter` `/kos/discord/brain-dump-lambda-arn` pinned to
  `discordBrainDump.functionArn` — Plan 05-06's IntegrationsStack reads
  this at synth time. Resolves the deploy-order awkwardness called out in
  `05-06-DISCORD-CONTRACT.md` §"Deploy order resilience" (operator no
  longer has to `aws ssm put-parameter` by hand pre-Phase-10).
- New SQS DLQ `discord-brain-dump-scheduler-dlq` (4-day retention,
  KMS-managed encryption, retain-on-delete) wired into the existing
  Scheduler's `target.deadLetterConfig`. The scheduler role has
  `sqs:SendMessage` on the queue.
- New `discordBrainDumpChannelId` prop (single canonical channel) wired
  to `DISCORD_BRAIN_DUMP_CHANNEL_ID` env on the Lambda. Falls back to
  `discordChannelIds[0]` then `''` if unset.

### 6. CDK test updates — 4 new cases:
- `Plan 10-04: Discord Lambda env includes DISCORD_BRAIN_DUMP_CHANNEL_ID and KEVIN_OWNER_ID`
- `Plan 10-04: SSM parameter /kos/discord/brain-dump-lambda-arn is created and pinned to the Lambda ARN`
- `Plan 10-04: Discord Scheduler has a SQS DLQ deadLetterConfig + 2 retries`
- `Plan 10-04: explicit discordBrainDumpChannelId prop wins over the legacy multi-id array`

Pre-existing 5 migration tests still pass.

### 7. CDK entry point — `packages/cdk/bin/kos.ts`

Added env-var driven `discordBrainDumpChannelId` resolution
(`DISCORD_BRAIN_DUMP_CHANNEL_ID` env → `discordBrainDumpChannelId`
context → undefined).

### 8. Package deps — `services/discord-brain-dump/package.json`

Added the standard observability + RDS stack used by `granola-poller` so
the handler can reuse `_shared/sentry.ts` + `_shared/tracing.ts` and the
persist module can talk to RDS Proxy:
`@arizeai/openinference-instrumentation-claude-agent-sdk`,
`@aws-sdk/rds-signer`, `@langfuse/otel`, `@opentelemetry/*`,
`@sentry/aws-serverless`, `pg`, `@types/pg`.

### 9. Tsconfig — `services/discord-brain-dump/tsconfig.json`

Added the standard service-tsconfig path mappings (`@opentelemetry/*`,
`@langfuse/*`, `@arizeai/*`, `@sentry/*`) and `../_shared/**/*.ts` into
`include` so the relative imports type-resolve.

---

## Verification

```
pnpm --filter @kos/service-discord-brain-dump test
  → 31 passed (3 cursor + 15 discord + 13 handler)

pnpm --filter @kos/cdk test -- --run integrations-migration
  → 9 passed (5 pre-existing + 4 new for Plan 10-04)
```

Typecheck (`pnpm --filter @kos/service-discord-brain-dump typecheck`)
emits errors only in:
- `packages/contracts/src/*` — pre-existing zod-resolution issue across
  the monorepo (granola-poller has the identical errors on master).
- `services/_shared/brief-renderer.ts` — pre-existing implicit-any errors.
- A removed `Sentry.configureScope` call (already replaced with
  best-effort `setTag`).

These are NOT introduced by this plan — `pnpm --filter
@kos/service-granola-poller typecheck` errors with the same shape on
master. Tests pass cleanly which is the load-bearing signal.

---

## Deferred (out-of-scope for this brief)

Per the user's brief, Task 3 of the on-disk plan is NOT this scope. These
items remain operator-side TODO before cutover:

1. **`scripts/verify-discord-brain-dump-substance.mjs`** — 7-day same-substance verifier comparing legacy VPS `brain-dump-listener.py` output vs. new Lambda output, with Gemini 2.5 Pro judge for content mismatches. Plan 10-04 §Task 3 prescribes this.
2. **`.planning/phases/10-migration-decommission/10-04-DISCORD-CUTOVER-RUNBOOK.md`** — operator cutover runbook. Plan 10-04 §Task 3 prescribes this.
3. **`scripts/discover-vps-scripts.sh`** referenced by the cutover runbook — Plan 10-06 prereq.
4. **Operator: seed `kos/discord-bot-token` Secrets Manager value** with the bot token from the legacy VPS script. The MigrationStack creates a placeholder secret (`Secret(this, 'DiscordBotTokenSecret', ...)` with `description: '... Plan 10-04 rotates the placeholder value'`); operator must rotate.
5. **Operator: set `DISCORD_BRAIN_DUMP_CHANNEL_ID` env / context** for CDK deploy. Default on synth is empty string (Lambda refuses to run without it — by design). CDK error visibility: CFN succeeds; Lambda errors at first invoke.
6. **Operator: pre-cutover JSON-log patch** for legacy `brain-dump-listener.py` so the parity verifier has structured input.
7. **Operator: post-MigrationStack-deploy → IntegrationsStack redeploy** to repin Plan 05-06's Scheduler onto the real Lambda ARN. SSM param now CDK-managed, but the Scheduler target ARN is resolved at rule-creation time (not runtime) so a CFN update is required.

---

## Notable design choices to flag for review

1. **Source name**: `'kos.capture-discord-brain-dump'` (not `'kos.capture'`).
   The contract says `Source: kos.capture / DetailType: capture.received`,
   but our convention across services is `Source` = the service identity
   so EventBridge rules can pattern-match per-source. The bus name is
   `kos.capture` (`KOS_CAPTURE_BUS_NAME` env). Triage's existing rule
   matches on `detail-type: capture.received` regardless of source — so
   this is contract-equivalent.
2. **Cold-start seeding emits zero**: per the contract §Cursor: "If the
   cursor is empty (cold start), the Lambda fetches the most-recent
   message only, stores its ID as the cursor, and emits zero events — no
   backfill." Implemented exactly: cursor=null + N msgs → setCursor to
   newest id, return `cold_start_seeded: true`.
3. **Per-message cursor advance** (vs. end-of-loop). Buys at-least-once
   semantics with per-message granularity — a transient publish failure
   on message N doesn't lose messages 1..N-1.
4. **`agent_runs` insert failure non-fatal**: the `capture_id` is the
   load-bearing dedup at the triage layer; agent_runs is observability
   sugar. RDS Proxy outage shouldn't block Discord ingestion.
5. **Skipped messages still advance cursor**: if `findPriorOkRun` says a
   message was already emitted in a prior run, we skip the emit but DO
   advance the cursor — otherwise the same skip would re-fire every 5
   minutes forever.
6. **Two input shapes accepted**: Plan 05-06's canonical `{ channel:
   'brain-dump', owner_id, trigger_source }` AND the legacy MigrationStack
   `{ owner_id, channel_ids }`. The MigrationStack's internal Scheduler
   uses the legacy shape; Plan 05-06's IntegrationsStack Scheduler uses
   the canonical shape. Both work without redeploy.

---

## Files modified / added

```
M packages/cdk/bin/kos.ts                              (+8 lines)
M packages/cdk/lib/stacks/integrations-migration.ts    (+85 lines)
M packages/cdk/test/integrations-migration.test.ts     (+97 lines)
M services/discord-brain-dump/package.json             (+11 deps)
M services/discord-brain-dump/src/handler.ts           (rewrite — scaffold→body)
M services/discord-brain-dump/tsconfig.json            (path mappings)
A services/discord-brain-dump/src/discord.ts           (+235 lines)
A services/discord-brain-dump/src/persist.ts           (+200 lines)
A services/discord-brain-dump/test/discord.test.ts     (+220 lines)
A services/discord-brain-dump/test/handler.test.ts     (+330 lines)
M pnpm-lock.yaml                                       (dep additions)
```

No commit per user's brief.
