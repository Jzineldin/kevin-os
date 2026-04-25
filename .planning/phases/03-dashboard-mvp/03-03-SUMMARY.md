---
phase: 03
plan: 03
subsystem: dashboard-mvp-sse-pipeline
tags: [dashboard, fargate, lambda, listen-notify, pg-listen, eventbridge, sse]
dependency_graph:
  requires:
    - "03-00 (service scaffolds: pg-listen 1.7.0 + fastify 5.1.0 pins; SseEventSchema in @kos/contracts/dashboard)"
    - "03-01 (migration 0009 NOTIFY triggers fire on kos_output; 0007 entity_merge_audit + 0008 inbox_index)"
  provides:
    - "dashboard-listen-relay: Fastify (0.25 vCPU / 0.5 GB Fargate) with LISTEN kos_output, 256-entry ring buffer, long-poll GET /events (25s cap) + GET /healthz"
    - "dashboard-notify: EventBridgeHandler Lambda mapping 5 kos.output detail-types to pg_notify(kos_output, ...) pointer-only under 8KB cap"
    - "Shared SseEventSchema enforcement at emit AND receive — payload shape cannot drift"
  affects:
    - services/dashboard-listen-relay
    - services/dashboard-notify
tech_stack:
  added:
    - "RingBuffer FIFO (256 max, monotonic seq cursor, in-memory)"
    - "pg-listen 1.7.0 paranoidChecking=30s + infinite retryTimeout (node-postgres 967 silent-stall guard)"
    - "Fastify 5.1.0 + disableRequestLogging + inject-based testing"
    - "@aws-sdk/rds-signer 3.691.0 IAM tokens (15min; refreshed on reconnect)"
    - "Dockerfile multi-stage ARM64 (node:22.12-alpine3.20) non-root + wget HEALTHCHECK"
  patterns:
    - "createHandler(deps) factory for dashboard-notify: pg.Client + Signer injection without vi.mock on pg"
    - "ALLOWED_KINDS allowlist: unknown detail-types ignored with warn (idempotent no-op, not throw)"
    - "Pointer-only invariant enforced twice: SseEventSchema.parse + 8000-char guard"
    - "ECS restart-on-fatal via process.exit(1) on subscriber error"
    - "tsconfig rootDir=. with explicit tests include — emits dist/src/ for Dockerfile"
key_files:
  created:
    - services/dashboard-listen-relay/src/buffer.ts
    - services/dashboard-listen-relay/src/subscriber.ts
    - services/dashboard-listen-relay/Dockerfile
    - services/dashboard-listen-relay/vitest.config.ts
    - services/dashboard-listen-relay/tests/buffer.test.ts
    - services/dashboard-listen-relay/tests/subscriber.test.ts
    - services/dashboard-listen-relay/tests/long-poll.test.ts
    - services/dashboard-notify/tests/notify.test.ts
    - services/dashboard-notify/vitest.config.ts
  modified:
    - services/dashboard-listen-relay/src/index.ts
    - services/dashboard-listen-relay/tsconfig.json
    - services/dashboard-notify/src/index.ts
    - services/dashboard-notify/tsconfig.json
  removed:
    - services/dashboard-listen-relay/tests/listen-reconnect.test.ts
    - services/dashboard-notify/tests/notify-payload.test.ts
decisions:
  - "pg-listen not raw pg LISTEN: node-postgres issue 967 silent-stall guard via paranoidChecking + reconnect"
  - "process.exit(1) on subscriber fatal: ECS replaces task cleaner than in-process reconnect"
  - "Long-poll 25s cap: below Vercel maxDuration:300 + API Gateway 30s timeout"
  - "createHandler(deps) factory for dashboard-notify: clean pg + Signer test injection"
  - "Allowlist-reject-silently: avoids retry storms on misconfigured rules"
  - "Poll interval 200ms (not 500ms): faster p95 on happy path at single-user volume"
  - "Owner-id filter deferred to Plan 05+: Phase 3 is single-user"
metrics:
  duration: "~18m"
  tasks_committed: 2
  files_created: 9
  files_modified: 4
  files_removed: 2
  tests_added: 20
  completed_date: "2026-04-23"
requirements_addressed: [UI-06]
---

# Phase 3 Plan 03-03: dashboard-listen-relay + dashboard-notify SSE pipeline

**One-liner:** Implements the two glue services that carry `kos.output` events from EventBridge + RDS triggers to the Vercel SSE handler — a tiny Fargate task (Fastify + pg-listen + 256-entry ring buffer + long-poll `/events`) and a Lambda (EventBridge -> `pg_notify(kos_output, ...)`) — both validating against the single shared `SseEventSchema` so the pointer-only contract (D-25) cannot drift between the two sides.

## What shipped

### Task 1 (commit `1e86c84`) — dashboard-listen-relay Fargate service

- **`src/buffer.ts`** — pure `RingBuffer` class, configurable max (default 256), FIFO eviction, monotonic `seq` assigned on push. `since(cursor)` returns rows with seq > cursor in FIFO order. 5 unit tests cover eviction math (300 -> 256 evicts first 44), FIFO order, empty-tail boundary, and custom max.
- **`src/subscriber.ts`** — wraps `pg-listen` with `@aws-sdk/rds-signer` IAM tokens (15-minute lifetime; refreshed on each reconnect by pg-listen native loop); `paranoidChecking: 30_000` + `retryInterval: 500` + `retryTimeout: Number.POSITIVE_INFINITY` per RESEARCH §17 P-12 silent-stall guard. `subscriber.notifications.on(kos_output)` parses JSON, validates `SseEventSchema.parse`, pushes to buffer; malformed dropped with `console.warn`; `events.on(error)` calls `process.exit(1)` so ECS replaces the task.
- **`src/index.ts`** — exports `buildApp()` factory (Fastify inject for tests) AND runs a listening server when invoked directly. GET /healthz: 200 `{ok, buffered, max_seq}` when subscriberHealthy is true; 500 otherwise. GET /events?cursor=&wait= returns immediate if events exist or wait=0; else polls every 200ms until `min(wait, 25)` seconds elapse. SIGTERM/SIGINT trigger graceful `onClose` -> `subscriber.close()` -> `exit(0)`.
- **`Dockerfile`** — multi-stage ARM64 (node:22.12-alpine3.20 + libc6-compat + corepack pnpm 9.12.0). Compiles TS; `pnpm deploy --prod /out`. Runtime non-root `kos:kos`, EXPOSE 8080, wget HEALTHCHECK every 30s.
- **`tsconfig.json`** — `rootDir: "."` so tests compile without TS6059; `outDir: "dist"` places JS at `dist/src/index.js`.
- **`vitest.config.ts`** — explicit `include: ["tests/**/*.test.ts"]` + 10s `testTimeout`.
- **Test suite (14 tests, all green in 1.48s):** buffer.test.ts (5): seq monotonicity, eviction at 300, since filtering, empty tail, custom max. subscriber.test.ts (4): mocked pg-listen + Signer; string + object payloads parse + push; missing/unknown kind dropped + warned. long-poll.test.ts (5): wait=0 immediate empty; buffered events returned with correct cursor; wait=1 times out in 900ms-3s; /healthz 200 after connected; /healthz 500 before connected.

### Task 2 (commit `d4ffead`) — dashboard-notify Lambda

- **`src/index.ts`** — exports `createHandler(deps)` factory AND `handler = createHandler()` for Lambda runtime. `ALLOWED_KINDS` = `{inbox_item, entity_merge, capture_ack, draft_ready, timeline_event}` (D-25 verbatim). Unknown `detail-type` -> `warn` + `{ok:true, notified:false}` (idempotent no-op; does NOT throw -> no retry storms). Builds pointer-only SseEvent: `kind`, `id` (`detail.id ?? event.id`), `entity_id` (only when present), `ts` (`detail.ts ?? new Date().toISOString()`); `SseEventSchema.parse` throws on bad shape -> EventBridge retries. 8000-byte assertion (pointer-only invariant). Short-lived `pg.Client` (RDS Proxy + IAM token as user `dashboard_notify`); `SELECT pg_notify($1, $2)`; `client.end()` in `finally`. No connection pool. `deps.makeClient` + `deps.getAuthToken` injection for test isolation.
- **`tests/notify.test.ts` (6 tests, all green):** translates inbox_item event into pg_notify (connect/query/end called once); includes entity_id for timeline_event; ignores unknown detail-type (pg not called, notified:false); throws on invalid ISO 8601 ts (pg not called); payload stays under 8 KB on happy path; event.id fallback when detail.id missing.

## Verification results

| Command | Result |
| --- | --- |
| `pnpm --filter @kos/dashboard-listen-relay typecheck` | clean (TS 5.6.3, strict, noUncheckedIndexedAccess) |
| `pnpm --filter @kos/dashboard-listen-relay test` | 14/14 passed / 3 files / 1.48s |
| `pnpm --filter @kos/dashboard-notify typecheck` | clean |
| `pnpm --filter @kos/dashboard-notify test` | 6/6 passed / 1 file / 0.40s |
| grep `listenTo(kos_output)` in subscriber.ts | match |
| grep `SseEventSchema.parse` in subscriber.ts | match |
| grep `new RingBuffer(256)` in index.ts | match |
| grep `Math.min(..., 25)` in index.ts | match |
| grep `HEALTHCHECK` in Dockerfile | match |
| grep `arm64` in Dockerfile | 2 matches (build + runtime stages) |
| grep `EventBridgeHandler` in notify/src/index.ts | match |
| grep `pg_notify` in notify/src/index.ts | 3 matches |
| 5 D-25 kinds in ALLOWED_KINDS | all 5 present |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Tooling] Added `vitest.config.ts` to both services.** Vitest default include matched 0 files under pnpm filter cwd; added explicit `include: ["tests/**/*.test.ts"]` + 10s `testTimeout`. Files: `services/dashboard-listen-relay/vitest.config.ts`, `services/dashboard-notify/vitest.config.ts`. Commits `1e86c84`, `d4ffead`.

**2. [Rule 1 - Bug] tsconfig rootDir=src rejected tests files.** Latent Wave-0 scaffold bug where `rootDir: "src"` + `include: ["src/**", "tests/**"]` emitted TS6059. Changed `rootDir` to `"."` in both tsconfigs. Commits `1e86c84`, `d4ffead`.

**3. [Rule 2 - Correctness] Signer mock as a class, not `vi.fn().mockImplementation`.** vitest ESM mock hoisting did not bind the mock return correctly; `signer.getAuthToken` came back undefined. Replaced with a real class declaration inside `vi.mock`. Files: subscriber.test.ts, long-poll.test.ts. Commit `1e86c84`.

**4. [Rule 3 - Tooling] Entrypoint guard regex literal stripped by bash heredoc.** Single backslash lost, leaving invalid regex -> TS1002. Rewrote to `.split(String.fromCharCode(92)).join("/")` to avoid regex entirely. File: `services/dashboard-listen-relay/src/index.ts`. Commit `1e86c84`.

### Deferred Issues

**1. Docker build verification not run locally.** Docker daemon not running on the executor (`failed to connect to npipe`). Dockerfile is complete and syntactically valid. Plan 05 (CDK deploy) will run `docker buildx build --platform linux/arm64` in CI/CD during ECR push; acceptance test #8 deferred to Plan 05 Gate.

**2. Live Postgres NOTIFY smoke test.** Tests mock pg-listen entirely; no live RDS Proxy connection from local exec (VPC-private, same concern as Plan 03-01 Deviation 1). Plan 05 will wire + smoke-test end-to-end on kos.output.

**3. Pre-existing zod peer-warning cascade** (carried forward from 03-00/01). Deferred infra bump.

### Auth gates

None encountered. Entirely filesystem + pnpm registry + already-installed deps.

## Ready for Plan 05 (CDK wiring)

Plan 05 can now:
- Build `services/dashboard-listen-relay/Dockerfile` for `linux/arm64`, push to an ECR repo, wire into an ECS Service with `desiredCount: 1`, `cpu: 256`, `memory: 512`, `networkMode: awsvpc`, in a private subnet. IAM role: `rds-db:connect` on `dashboard_relay` user + SSM `GetParameter` for endpoint config.
- Fronting: RESEARCH §13 Option A (API Gateway HTTP API + VPC Link + NLB, ~$31/mo). HEALTHCHECK targets `/healthz` on :8080.
- Deploy `services/dashboard-notify/src/index.ts` as a Lambda (Node 22 ARM64, 256 MB default), EventBridge rule on `kos.output` matching `detail-type in ALLOWED_KINDS`. VPC-attached; IAM `rds-db:connect` on `dashboard_notify` user (EXECUTE pg_notify only — no SELECT/INSERT).
- Both services share the `@kos/contracts/dashboard` `SseEventSchema` — payload contract is typechecked at build time on both sides.

## Known Stubs

None — Plan 03-03 completes both services per spec. Future evolution:

| File | Evolution |
| --- | --- |
| `services/dashboard-listen-relay/src/index.ts` | Plan 05+ may add owner_id filter once multi-tenant arrives |
| `services/dashboard-notify/src/index.ts` | ALLOWED_KINDS grows with new kos.output detail-types (schema update in @kos/contracts/dashboard + set addition) |

## Self-Check

### Files created / exist

- FOUND: `services/dashboard-listen-relay/src/buffer.ts`
- FOUND: `services/dashboard-listen-relay/src/subscriber.ts`
- FOUND: `services/dashboard-listen-relay/src/index.ts`
- FOUND: `services/dashboard-listen-relay/Dockerfile`
- FOUND: `services/dashboard-listen-relay/tsconfig.json`
- FOUND: `services/dashboard-listen-relay/vitest.config.ts`
- FOUND: `services/dashboard-listen-relay/tests/buffer.test.ts`
- FOUND: `services/dashboard-listen-relay/tests/subscriber.test.ts`
- FOUND: `services/dashboard-listen-relay/tests/long-poll.test.ts`
- FOUND: `services/dashboard-notify/src/index.ts`
- FOUND: `services/dashboard-notify/tsconfig.json`
- FOUND: `services/dashboard-notify/vitest.config.ts`
- FOUND: `services/dashboard-notify/tests/notify.test.ts`
- ABSENT (correct): `services/dashboard-listen-relay/tests/listen-reconnect.test.ts` (Wave 0 stub removed)
- ABSENT (correct): `services/dashboard-notify/tests/notify-payload.test.ts` (Wave 0 stub removed)

### Commits exist

- FOUND: `1e86c84` (Task 1 — dashboard-listen-relay Fastify + pg-listen + ring buffer + long-poll)
- FOUND: `d4ffead` (Task 2 — dashboard-notify EventBridgeHandler -> pg_notify)

## Self-Check: PASSED

