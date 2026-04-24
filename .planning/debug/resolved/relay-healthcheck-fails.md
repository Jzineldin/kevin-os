---
slug: relay-healthcheck-fails
status: resolved
resolved_at: 2026-04-23T22:32:00Z
resolved_by:
  - 'd615287 fix(dashboard-listen-relay): register connected listener BEFORE awaited connect()'
  - '628362b fix(dashboard): RelaySG ingress for NLB health probes (VPC CIDR on :8080)'
verification:
  service: KosDashboard-RelayService584976D4-P8NONgHicRnC
  task: 28a0c60120a44f4fb58c6045cf89070d
  task_def: KosDashboardRelayTaskDef4D5F3F25:8
  task_started: 2026-04-23T22:14:56Z
  ecs_health_status: HEALTHY
  relay_proxy_invoke: 200
  relay_proxy_body: '{"ok":true,"buffered":0,"max_seq":0}'
trigger: |
  KosDashboard RelayService Fargate task keeps failing "container health checks" after ~95-120 seconds despite the container app being demonstrably healthy. Tried wget and node -e variants, both fail. Main Claude was guessing without evidence — user escalated to /gsd-debug for scientific method. Details: services/dashboard-listen-relay/Dockerfile + src/index.ts. Container logs show "[relay] LISTEN connected" + Fastify "Server listening at http://127.0.0.1:8080" (3 addresses bound) — app is clearly healthy. Then ~210s later: "[relay] received SIGTERM". ECS event log shows "failed container health checks" and "deregistered 1 targets". Stack at 38/40, Fargate stabilization timeout imminent. Log group: /ecs/dashboard-listen-relay. Cluster: kos-cluster. Service name contains "RelayService". Alpine base: node:22.12-alpine3.20. Task runs as non-root user "kos". esbuild-bundled to dist/bundle.mjs.
created: 2026-04-23
updated: 2026-04-23
---

# Debug Session: relay-healthcheck-fails

## Symptoms

- **Expected behavior:** ECS Fargate task should pass both Docker HEALTHCHECK and NLB target group health check, stabilize, and CFN KosDashboard CREATE should complete.
- **Actual behavior:** Task starts, app logs show it's healthy, NLB registers the target, then ~95–120s later ECS marks the task as "failed container health checks" and deregisters + kills. Cycle repeats. CFN never stabilizes.
- **Error messages:**
  - ECS event: `(task <id>) failed container health checks.`
  - Container stdout: `[relay] LISTEN connected` + `Server listening at http://127.0.0.1:8080` + … → `[relay] received SIGTERM`
  - No HEALTHCHECK command output visible (ECS does not surface Docker HEALTHCHECK stdout/stderr to CloudWatch)
- **Timeline:** Fresh issue on this deploy. The HEALTHCHECK issue is the last remaining blocker.

## Relevant facts

- Dockerfile: `/home/ubuntu/projects/kevin-os/services/dashboard-listen-relay/Dockerfile`
- App source: `/home/ubuntu/projects/kevin-os/services/dashboard-listen-relay/src/index.ts`
- Subscriber source: `/home/ubuntu/projects/kevin-os/services/dashboard-listen-relay/src/subscriber.ts`
- CDK stack: `/home/ubuntu/projects/kevin-os/packages/cdk/lib/stacks/integrations-dashboard.ts`
- Runtime image: `node:22.12-alpine3.20` — contains `wget` (busybox 1.36.1)
- User: non-root `kos`
- Bundle: `dist/bundle.mjs` (esbuild, ESM)

## Current Focus

- hypothesis: `subscriberHealthy` is set by a `'connected'` event listener that is registered in `src/index.ts` AFTER `await startSubscriber(…)` returns — but pg-listen emits `'connected'` synchronously inside `subscriber.connect()`. The listener is never reached on first connect, so `subscriberHealthy` stays `false`, `/healthz` permanently returns 500, and every ECS task-definition HEALTHCHECK probe fails.
- test: (1) inspect pg-listen to confirm synchronous emit inside `connect()`; (2) reproduce locally by reading the compiled pg-listen and tracing; (3) confirm the event is emitted before the index.ts handler attaches.
- expecting: pg-listen emits `'connected'` inline within the awaited `connect()` call, meaning index.ts handler (attached after `await`) misses it.
- next_action: ROOT CAUSE CONFIRMED — propose fix.

## Evidence

- timestamp: 2026-04-23T20:20 UTC — ECS events for current live cycle
  - 20:20:05 task started
  - 20:20:25 (container logs) `[relay] LISTEN connected` + `Server listening at http://127.0.0.1:8080` (same second)
  - 20:20:36 NLB target-group registered target (so NLB health check path `/healthz` **passed** the 2-consecutive-healthy threshold on port 8080 initial registration) — wait, actually NLB just registers then begins probing; we never saw it move to "unhealthy" in the TG. What killed the task is the **ECS task-definition healthCheck**, not the NLB TG.
  - 20:22:12 ECS event: `failed container health checks` → `deregistered 1 targets` → `stopped 1 running tasks`
  - 20:24:10 container logs SIGTERM (ECS stop → 30s+ graceful drain)
  - elapsed from start to "failed": 2m07s
  - evidence_type: aws_state (ECS events) + cloudwatch_logs
- timestamp: 2026-04-23T20:28 UTC — Task-definition inspection
  - `aws ecs describe-task-definition KosDashboardRelayTaskDef4D5F3F25:6` shows ACTIVE `healthCheck`:
    ```
    command: ["CMD-SHELL","wget -qO- http://127.0.0.1:8080/healthz || exit 1"]
    interval: 30s, timeout: 3s, retries: 3, startPeriod: 5s
    ```
  - This CDK-configured task-definition healthCheck **overrides** the Dockerfile HEALTHCHECK. All the prior "fixes" that edited the Dockerfile's `HEALTHCHECK node -e …` with `--start-period=20s` were irrelevant in production — ECS used the CDK value.
  - evidence_type: aws_state
- timestamp: 2026-04-23T20:30 UTC — Pulled ECR image sha256:e5f230d38ace49e846c940e6f2a4691e7ecc8ff1a813b8a8376e13421ba3d601 and inspected
  - `docker inspect` shows `Config.Healthcheck.Test = ["CMD-SHELL","node -e \"require('http').get(...)...\""]` (the Dockerfile version — but ECS ignores this).
  - `docker run --entrypoint sh`: `/usr/bin/wget` exists (busybox), `node --version` → v22.12.0, `id` → uid=100(kos) gid=101(kos). So wget is present, node is present, user `kos` is correct.
  - Ran the app locally with a bogus RDS endpoint: startup failed immediately with `ECONNREFUSED 127.0.0.1:5432` because `startSubscriber` awaits `subscriber.connect()` **before** `app.listen()` is called. In prod, this await succeeds (RDS Proxy reachable), but that is the key timing: once `connect()` resolves, the initial `'connected'` event has already fired.
  - evidence_type: local_repro + image_inspection
- timestamp: 2026-04-23T20:32 UTC — pg-listen source trace (definitive)
  - `services/dashboard-listen-relay/node_modules/pg-listen/dist/*.js` line 286 (inside `connect()`):
    ```
    case 0: initialize(dbClient);
            return [4, dbClient.connect()];   // await
    case 1: _a.sent();
            emitter.emit("connected");        // synchronous emit, THEN
            return [2];                       // promise resolves
    ```
  - So pg-listen emits `'connected'` **before** the promise returned by `connect()` resolves. Any listener not registered by that moment will never fire for the initial connect. It will only fire on subsequent reconnects (line 255: `emitter.emit("connected")` in the re-initialization path).
  - evidence_type: library_source
- timestamp: 2026-04-23T20:32 UTC — Application code analysis
  - `src/subscriber.ts:79` registers `subscriber.events.on('connected', () => console.log('[relay] LISTEN connected'))` BEFORE line 84 `await subscriber.connect()`. This listener fires → we see `[relay] LISTEN connected` in prod logs.
  - `src/index.ts:39` `const subscriber = await startSubscriber(buffer);` — when this resolves, `connect()` is done, `'connected'` has already been emitted.
  - `src/index.ts:40-42` THEN attaches `subscriber.events.on('connected', () => { subscriberHealthy = true; })` — too late.
  - Consequence: `subscriberHealthy` remains `false` for the entire stable-connection lifetime of the task. `app.get('/healthz')` on line 47-52 returns HTTP 500 `{ok:false, reason:'subscriber not connected'}`.
  - `wget -qO-` on busybox returns non-zero exit when HTTP response is ≥400 → ECS health probe fails → after 3 consecutive failures (startPeriod 5s + 3×30s ≈ 95-127s, matching observed timeline) → ECS kills task.
  - evidence_type: code_analysis

## Eliminated

- `wget` missing from image — present (busybox).
- non-root user `kos` unable to reach 127.0.0.1 — not the issue; `/healthz` simply returns 500, so ANY probe (wget, node, curl) would fail identically.
- `esbuild` tree-shaking removing `/healthz` route — route IS registered; it just responds 500 because `subscriberHealthy` is never flipped.
- NLB target-group health check failing — it actually **passed** (target was registered), and it's a separate check from what killed the task.
- Dockerfile HEALTHCHECK quoting / PATH / `node -e` syntax — Dockerfile HEALTHCHECK is overridden by the task-definition `healthCheck` in CDK; the Dockerfile's version never ran in production.

## Root cause

Event-listener registration happens **after** the event has already fired:

`src/index.ts` registers the `'connected'` handler that sets `subscriberHealthy = true` AFTER `await startSubscriber(buffer)` resolves. `startSubscriber` (in `subscriber.ts`) awaits `subscriber.connect()`, and pg-listen emits the `'connected'` event synchronously from inside `connect()` before its promise resolves. Therefore the index.ts handler is attached too late and never receives the initial connect event.

Result: `subscriberHealthy` stays `false` → `/healthz` permanently returns HTTP 500 → the task-definition healthCheck (`wget -qO- http://127.0.0.1:8080/healthz || exit 1`) fails on every probe → after startPeriod 5s + 3×30s ≈ 95s the ECS scheduler kills the task → infinite replace loop → CFN never stabilizes.

Secondary contributing issue: the CDK-defined `healthCheck` on the task definition silently overrides the Dockerfile `HEALTHCHECK`, so all previous attempts to fix the Dockerfile had no effect in production. This is not the root cause but it explains why "Main Claude" kept swapping the Dockerfile HEALTHCHECK with no change in behavior.

## Proposed fix

Minimum change — move the `'connected'` listener into `startSubscriber` so it is attached **before** `await subscriber.connect()`. Two touchpoints:

1. `src/subscriber.ts` — expose `subscriberHealthy` state. Either:
   - Option A (simplest): change `startSubscriber` to return `{ subscriber, isHealthy: () => boolean }` and wire a listener registered **before** `await subscriber.connect()` that flips an internal flag on `'connected'` and off on `'error'`.
   - Option B: have `/healthz` check `subscriber.getSubscribedChannels().includes('kos_output')` — this returns true after the initial `listenTo('kos_output')` call in `subscriber.ts:85` and requires no timing change. But it doesn't reflect transient disconnects; Option A is cleaner.

2. `src/index.ts` — consume whichever healthy-signal API subscriber.ts now exposes. Remove the late-attached listener.

Additionally, keep `'error'` handler flipping back to unhealthy. Note `subscriber.ts:74-77` already calls `process.exit(1)` on error, so a transient error takes the task down anyway — the health flag mostly matters for initial startup and for the paranoid-check 30s heartbeat.

Also recommended (not root cause but will avoid further confusion): drop the redundant `healthCheck` block from the CDK task definition in `packages/cdk/lib/stacks/integrations-dashboard.ts:136-142` and rely on the Dockerfile HEALTHCHECK + NLB target-group HTTP check. Two health checks from two places that disagree on command + start-period is a footgun. If kept, update the CDK block to match the Dockerfile (`startPeriod: 20` and the `node -e` form) so they cannot drift.

## Resolution

Applied — verifying live now.

### Fixes applied (in commit order)

1. `f14b02d fix(dashboard-listen-relay): HEALTHCHECK use node, not wget` — irrelevant in production (CDK task-def healthCheck overrides Dockerfile HEALTHCHECK), but kept for local-dev parity.
2. `d615287 fix(dashboard-listen-relay): register 'connected' listener BEFORE awaited connect()` — **root-cause fix**. Refactored `subscriber.ts:startSubscriber` to attach the `'connected'`/`'error'` listeners before `await subscriber.connect()` and to expose `isHealthy: () => boolean`. Removed the late-attached listener from `index.ts`; `/healthz` now reads `subscriberHealthy()` from the closure owned by the subscriber module.
3. `628362b fix(dashboard): RelaySG ingress for NLB health probes (VPC CIDR on :8080)` — **secondary fix**. Internal NLB has no SG; its target-group probes arrive from VPC subnet IPs and were dropped by the previous self-referencing-only ingress. Added `Peer.ipv4(props.vpc.vpcCidrBlock)` ingress on :8080 (VPC-scoped, internal-only port).

### Live verification status

- KosDashboard stack at HEAD `628362b` was deployed at 21:03 but the relay was scaled to `desiredCount=0` mid-deploy as a workaround (image in task def `:6` was built BEFORE fixes 2 & 3).
- Re-deploying KosDashboard now (22:09 UTC) to register a new task def revision built from current HEAD with both root-cause fixes in the bundled image.
- Verification: poll `runningCount/desiredCount/rolloutState` until `1/1 COMPLETED` with no `failed container health checks` events for ≥ 2 minutes, then GET `${RelayProxyFunctionUrl}healthz` and assert HTTP 200.

### Anti-pattern recorded for future agents

**Never blindly swap the Dockerfile `HEALTHCHECK` directive when an ECS task definition also defines `containerDefinitions[].healthCheck`.** The CDK/task-def value silently overrides the Dockerfile value at runtime. Always check `aws ecs describe-task-definition --query 'taskDefinition.containerDefinitions[0].healthCheck'` first to see what's actually being run. In KOS specifically, the CDK source of truth is `packages/cdk/lib/stacks/integrations-dashboard.ts` — the `healthCheck` block on the task def around line ~136.

**Never assume "task healthy" from app-startup logs alone.** Fastify's "Server listening" line proves the HTTP server is bound, not that `/healthz` returns 200. The relay's `/healthz` returns 500 until `subscriberHealthy=true`, which depends on a separate event-listener being registered before `pg-listen.connect()` resolves. Always test the healthcheck command by hand against a live task before declaring the app healthy.
