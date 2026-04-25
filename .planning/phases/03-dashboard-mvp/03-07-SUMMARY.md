---
phase: 03-dashboard-mvp
plan: 07
subsystem: dashboard-sse
tags: [sse, eventsource, live-updates, route-handler, react-context, reconnect]
requirements: [UI-06]
requirements_addressed: [UI-06]

dependency_graph:
  requires:
    - 03-05 (callRelay + middleware auth gate covering /api/stream)
    - 03-06 (LiveRegionProvider + authenticated (app)/layout mounting point)
    - packages/contracts SseEventSchema
  provides:
    - /api/stream Route Handler (Node runtime, 300s cap, close-before-280s, heartbeats)
    - SseProvider React Context mounted inside (app)/layout
    - useSseKind<K>(kind, handler) per-kind subscription hook
    - BACKOFF_MIN/BACKOFF_MAX + nextBackoff helpers for reconnect pacing
    - parseMessage JSON+zod guard used by the provider and reusable by any
      future consumer that needs to validate a raw `data:` payload
  affects:
    - 03-08 (Today + Entity dossier will consume useSseKind('timeline_event', ...)
      and useSseKind('entity_merge', ...))
    - 03-09 (Inbox triage will consume useSseKind('inbox_item', h)
      to refresh the queue in-place)
    - 03-10 (Calendar may consume useSseKind('timeline_event', …) for
      meeting changes)
    - 03-12 (end-to-end NOTIFY round-trip test depends on this plumbing)

tech_stack:
  added: []  # no new dependencies — everything built on native Web APIs + existing zod/react
  patterns:
    - Node-runtime Route Handler ReadableStream + TextEncoder for SSE
    - Preamble + `retry: <ms>` hint to override browser default 3s backoff
    - Heartbeat comment (`: heartbeat`) on 15s interval to flush Vercel + nginx buffers
    - Close stream at wall-clock deadline (STREAM_DEADLINE_MS = 280_000ms)
      before Vercel Pro's 300s hard cap — avoids platform-terminated 504
    - SigV4 long-poll against relay-proxy via existing `callRelay`;
      `wait=25` balanced against the relay Lambda's 28s AbortSignal timeout
    - Server-side SseEventSchema.safeParse on every event (T-3-07-03);
      same guard runs a second time in the browser via parseMessage
    - React Context + ref-backed Map<kind, Set<handler>> for O(1) dispatch
    - Stable handler ref inside useSseKind so handlers that close over
      frequently-changing state don't thrash the subscription set
    - 500ms → 60s exponential reconnect (R-12) layered on top of the
      browser's native `retry:` hint

key_files:
  created:
    - apps/dashboard/src/app/api/stream/route.ts
    - apps/dashboard/src/components/system/SseProvider.tsx
    - apps/dashboard/src/lib/sse-client.ts
    - apps/dashboard/tests/unit/sse-route.test.ts
    - apps/dashboard/tests/unit/sse-client.test.ts
    - apps/dashboard/tests/unit/sse-provider.test.tsx
  modified:
    - apps/dashboard/src/app/(app)/layout.tsx  (wrap shell with <SseProvider>)
    - apps/dashboard/tests/e2e/sse-reconnect.spec.ts  (fixme → active, skipped w/o preview URL)

decisions:
  - "Server-side validation runs via SseEventSchema.safeParse (not .parse) so the stream keeps flowing even if the relay emits one malformed row — malformed events are silently dropped per T-3-07-03. parse would throw and kill the stream for the rest of the connection."
  - "Route emits `: connected at <iso>` + `retry: 500` as the very first bytes. The retry hint overrides EventSource's spec default (3s) so the browser reconnects in 500ms if our stream closes. Our own backoff (BACKOFF_MIN..BACKOFF_MAX) kicks in when we observe onerror, layered on top of the browser's retry."
  - "STREAM_DEADLINE_MS = 280_000 — 20s safety margin below Vercel Pro's 300s hard cap. Platform-terminated 504s would flood Sentry; a clean server-initiated close looks like a normal reconnect to the browser."
  - "Canonicalised response headers to title-case (X-Accel-Buffering, Cache-Control, Connection, Content-Type) to satisfy the plan's literal grep acceptance rules. HTTP header names are case-insensitive so this is purely a style/docs fit — no behaviour change."
  - "useSseKind keeps a ref-latched handler so rerenders of the consuming component don't unsubscribe/resubscribe on every pass. The subscription effect only re-runs when `kind` or `subscribe` changes — neither changes in practice after mount."
  - "No user-facing message on reconnect. Per UI-SPEC Copywriting table entry `Error — SSE stream dropped → silent — auto-reconnect`. The provider exposes a `status` channel for a future ConnectionStatus dot, but mounting one is out of scope for Plan 03-07 (deferred)."
  - "ConnectionStatus dot in Topbar: NOT implemented in this plan. The plan's <tasks> block only specifies `/api/stream` + SseProvider + useSseKind + test — not the Topbar indicator. Deferred to a future polish pass; the `status` + `lastConnectedAt` fields on SseProvider's context are already exposed so any consumer can mount a dot without provider changes."

metrics:
  duration: 00:15
  tasks: 2
  files: 8
  tests_added: 16  # 4 route + 6 client helpers + 6 provider/hook
  tests_passing: 53  # dashboard-wide unit suite (was 37 after 03-06)
  commits:
    - 6b1224f feat(03-07) /api/stream SSE Route Handler (Node runtime, heartbeats, close-before-cap)
    - 6c82da3 feat(03-07) SseProvider + useSseKind + canonical SSE header casing
  completed: 2026-04-23T11:05:00Z
---

# Phase 3 Plan 07: SSE /api/stream + SseProvider + useSseKind Summary

Vercel-side SSE pipeline end-to-end: a Node-runtime `/api/stream` Route Handler that long-polls the relay-proxy Function URL and serialises each schema-validated event into WHATWG-spec SSE frames, plus a client `SseProvider` + `useSseKind<K>` hook that any Wave-3 view component drops into for in-place live updates.

## One-liner

`EventSource('/api/stream')` → Node-runtime SSE Route Handler → SigV4 long-poll to relay-proxy → `SseEventSchema`-validated events dispatched by kind to `useSseKind` subscribers; 15s heartbeats, 280s stream-close-before-Vercel-cap, 500ms→60s client exponential reconnect, zero user-facing noise on disconnect.

## What shipped

### Task 1 — `/api/stream` Route Handler (commit `6b1224f`)

- **`apps/dashboard/src/app/api/stream/route.ts`** — Node runtime (`export const runtime = 'nodejs'`), `maxDuration = 300`, `dynamic = 'force-dynamic'`. Returns a `ReadableStream<Uint8Array>` whose `start(controller)`:
  1. Emits `: connected at <iso>\n\n` + `retry: 500\n\n` as the preamble so the browser's EventSource fires `open` immediately and uses our 500ms backoff floor instead of the default 3s (R-12).
  2. Installs a 15s `setInterval` that enqueues `: heartbeat\n\n` — comment lines that browsers ignore but intermediate proxies treat as bytes, which is what keeps Vercel + any upstream nginx from buffering the connection closed (P-08).
  3. Schedules a 280_000ms timeout that closes the controller gracefully — inside Vercel Pro's 300s hard cap (P-09), so platform-terminated 504s never hit Sentry.
  4. In the long-poll loop, calls `callRelay('/events?cursor=<seq>&wait=25', { signal: req.signal })`. For each event in the JSON response body, runs `SseEventSchema.safeParse` and (on success) enqueues `id: <seq>\ndata: <json>\n\n`. Malformed events are silently dropped (T-3-07-03).
  5. Relay 5xx or fetch error → enqueues `: reconnecting\n\n` comment + 500ms→5s exponential backoff, keeps the stream open so the browser sees the outage as an extended heartbeat gap rather than a disconnect.
  6. `req.signal.abort` (browser tab closed) → clearInterval + clearTimeout + `controller.close()`.
- Response headers (canonical title-case):
  - `Content-Type: text/event-stream; charset=utf-8`
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no` — the critical one for Vercel (P-08).
- Middleware gate: `src/middleware.ts` matcher `'/((?!_next/static|_next/image|favicon.ico|sw.js|manifest\\.webmanifest|icons/).*)'` already catches `/api/stream`; no per-route auth needed inside the handler.
- **`tests/unit/sse-route.test.ts`** (4 cases, all via a `@/lib/dashboard-api` mock so no SigV4 traffic):
  1. Preamble + SSE headers: first bytes contain `: connected` + `retry: <ms>`; response headers match spec.
  2. Upstream events: mocked relay returns `{events:[{seq:1,kind:'inbox_item',id:'inb_abc',ts}, {seq:2,kind:'capture_ack',id:'cap_def',ts}], cursor:2}`. Assertion: stream contains `id: 1\ndata: {…"id":"inb_abc"…}` and `id: 2\ndata: {…"id":"cap_def"…}`.
  3. Abort: after `req.abort()`, reader drains to `done: true` within 1.5s.
  4. Schema rejection: malformed upstream event (missing `ts`) is dropped; the valid sibling event is still emitted.

### Task 2 — SseProvider + useSseKind + E2E (commit `6c82da3`)

- **`apps/dashboard/src/lib/sse-client.ts`** — pure testable helpers:
  - `BACKOFF_MIN = 500`, `BACKOFF_MAX = 60_000` (60s cap per R-12).
  - `nextBackoff(prev)` — doubles then caps; handles non-finite / zero prev defensively.
  - `parseMessage(raw)` — `JSON.parse` wrapped in try/catch, then `SseEventSchema.safeParse`; returns `null` on any failure so the provider drops garbage silently.
- **`apps/dashboard/src/components/system/SseProvider.tsx`** — `'use client'` Context provider:
  - On mount: `new EventSource('/api/stream')`. `onopen` → reset backoff + update status + record `lastConnectedAt`. `onmessage` → `parseMessage(e.data)` → lookup the kind's subscriber set → iterate a copy so a handler that unsubscribes mid-dispatch doesn't mutate the iteration. Handler throws are caught + `console.warn`'d — one bad subscriber never kills the others.
  - `onerror` → `setStatus('closed')` + `es.close()` + schedule reconnect with `nextBackoff`. Reconnect runs inside the same `useEffect` via `setTimeout` so unmount clears it.
  - On unmount: cancel pending reconnect timer, close the current EventSource, null out ref.
  - Exposes `{ subscribe, status, lastConnectedAt }` — enough surface for a future Topbar `ConnectionStatus` dot without provider changes.
  - `useSseKind<K extends SseEventKind>(kind, handler)` — type-narrowed subscriber hook. Keeps the caller's handler in a ref so rerenders don't thrash the subscription set; the effect re-runs only when `kind` or `subscribe` changes (neither changes in practice after mount).
- **`apps/dashboard/src/app/(app)/layout.tsx`** — wraps shell in `<SseProvider>` inside `<CommandPaletteProvider>`, above `<Sidebar>/<Topbar>/<main>`. Provider lives inside `<LiveRegionProvider>` so `useSseKind` handlers can call `useLiveRegion().announce(...)` without re-wiring.
- **`tests/unit/sse-client.test.ts`** (6 cases): `nextBackoff` cap invariant (sequence doubles + caps at 60_000), `nextBackoff(BACKOFF_MAX)` returns the cap, `parseMessage` happy path, `parseMessage` invalid JSON, `parseMessage` wrong shape, `parseMessage` wrong kind enum.
- **`tests/unit/sse-provider.test.tsx`** (6 cases): installs a `FakeEventSource` on `globalThis` that records every instance and exposes `_open() / _message() / _raw() / _error()` drivers. Asserts: opens exactly one ES on `/api/stream`; closes on unmount; per-kind dispatch (inbox vs draft probes each fire exactly once); auto-unsubscribe on consumer unmount (second event not delivered); `onerror` + fake-timer advance past 500ms → new ES instance created; malformed data (broken JSON, wrong shape, missing `ts`) all silently dropped.
- **`tests/e2e/sse-reconnect.spec.ts`** — promoted from `test.fixme`. Adds an `addInitScript` that subclasses `window.EventSource` to track instances on `window.__kosSseInstances`. Visits `/today`, polls for up to 5s, asserts an `EventSource` was opened against `/api/stream`. Skipped unless `PLAYWRIGHT_BASE_URL` is set (need a deployed preview or `next dev` + reachable relay to exercise the whole path). Full NOTIFY round-trip lives in Plan 03-12.

## Lifecycle timings (binding)

| Layer | Timing | Source |
|-------|--------|--------|
| Client `retry:` hint | 500 ms | `/api/stream/route.ts:CLIENT_RETRY_MS` |
| Client exponential backoff floor | 500 ms | `sse-client.ts:BACKOFF_MIN` |
| Client exponential backoff cap | 60 s | `sse-client.ts:BACKOFF_MAX` (R-12) |
| Server heartbeat interval | 15 s | `/api/stream/route.ts:HEARTBEAT_MS` |
| Relay long-poll wait | 25 s | `/api/stream/route.ts:LONG_POLL_WAIT_S` |
| Server stream deadline | 280 s | `/api/stream/route.ts:STREAM_DEADLINE_MS` |
| Vercel Pro hard cap | 300 s | platform constant (P-09) |
| Server relay-error backoff min | 500 ms | `BACKOFF_MIN_MS` (in route) |
| Server relay-error backoff max | 5 s | `BACKOFF_MAX_MS` (in route) |

Gap between server close (280s) and hard cap (300s) = **20s margin** for the browser to start its reconnect before the platform would have killed the function.

## Event kinds handled

All five kinds from D-25 flow through the pipeline transparently — the route handler doesn't special-case any; it emits whatever the relay returns after schema validation. The client provider dispatches each to the matching `useSseKind` subscriber(s):

| Kind | Consumer plan | Subscription pattern |
|------|---------------|---------------------|
| `inbox_item` | 03-09 Inbox | `useSseKind('inbox_item', () => router.refresh())` — triage queue re-fetches on push |
| `entity_merge` | 03-08 Entity dossier | `useSseKind('entity_merge', (ev) => ev.entity_id === id && refetch())` |
| `capture_ack` | 03-Wave3 capture UI | toast confirmation + clear composer |
| `draft_ready` | 03-09 Inbox | refresh draft count + optionally announce via `useLiveRegion()` |
| `timeline_event` | 03-08 Entity dossier, 03-10 Calendar | refetch timeline first page / meeting grid |

## Handler contract for downstream plans

**Every handler passed to `useSseKind` MUST be idempotent.** A client that reconnects after a network blip will receive the same event again if the relay's buffer still holds it (T-3-07-05 accept). Use the event `id` as a dedup key (Plan 03-08 wires the dedup Set; Plan 03-09 relies on `router.refresh()` which is idempotent by construction).

Example for Plan 03-08/09:

```tsx
const seenRef = useRef<Set<string>>(new Set());
useSseKind('timeline_event', (ev) => {
  if (seenRef.current.has(ev.id)) return;
  seenRef.current.add(ev.id);
  if (ev.entity_id === currentEntityId) refetchTimeline();
});
```

## Security posture — threat register dispositions

| Threat | Status | How |
|--------|--------|-----|
| T-3-07-01 DoS (stream hold-open) | mitigated | 280s stream cap + 25s upstream wait cap; no infinite waits |
| T-3-07-02 Info disclosure | mitigated | Payload pointer-only per D-25; middleware cookie gate on `/api/stream`; callRelay is SigV4-signed |
| T-3-07-03 Tampering (malformed events) | mitigated | `SseEventSchema.safeParse` on the server AND `parseMessage` on the client — both silently drop on failure |
| T-3-07-04 CSRF | mitigated | EventSource is same-origin; cookie is SameSite=Lax; no state-changing verbs on `/api/stream` |
| T-3-07-05 Replay on reconnect | accepted | Handlers are required to be idempotent (documented above + enforced by each downstream plan's dedup set) |

## Verification

- `pnpm --filter @kos/dashboard typecheck` → clean
- `pnpm --filter @kos/dashboard lint` → 0 errors, 2 pre-existing warnings (eslint.config.mjs + postcss.config.mjs — out of scope baseline)
- `pnpm --filter @kos/dashboard exec vitest run` → **53 tests pass across 10 files** (was 37 after Plan 03-06; +16 new SSE tests — 4 route + 6 client helpers + 6 provider/hook)
- `pnpm --filter @kos/dashboard build` → succeeds with `/api/stream` listed as a dynamic function, same bundle sizes as post-03-06 (SseProvider adds no new deps — pure React/zod).

## Acceptance criteria

**Task 1:**

- [x] `grep -F "export const runtime = 'nodejs'"` matches (P-01).
- [x] `grep -F "export const maxDuration = 300"` matches (P-09).
- [x] `grep -F "X-Accel-Buffering"` matches (P-08).
- [x] `grep -F "Cache-Control"` matches.
- [x] `grep -F "'keep-alive'"` matches.
- [x] `grep -F "heartbeat"` matches.
- [x] `grep -F "SseEventSchema"` matches (validation on the wire — `safeParse` preferred over `parse` per decisions above).
- [x] `grep -E "280_000|280000"` matches.
- [x] `tests/unit/sse-route.test.ts` passes 4 cases (≥3 required).

**Task 2:**

- [x] `grep -F "new EventSource('/api/stream')"` matches.
- [x] `grep -F "BACKOFF_MAX"` matches in sse-client.ts.
- [x] `grep -E "60_000|60000"` matches in sse-client.ts.
- [x] `grep -F "useSseKind"` matches in SseProvider.tsx.
- [x] `grep -F "<SseProvider>"` matches in (app)/layout.tsx (mounted).
- [x] `tests/unit/sse-client.test.ts` passes 6 cases (≥5 required).
- [x] `tests/unit/sse-provider.test.tsx` passes 6 cases (bonus coverage for hook + reconnect).
- [x] E2E spec exists, gracefully skips without PLAYWRIGHT_BASE_URL.

## Deviations from Plan

### Rule 1 — Auto-fix bugs

**1. `SseEventSchema.parse` → `SseEventSchema.safeParse` on the server side**
- **Found during:** Task 1 test `skips malformed upstream events`.
- **Issue:** Plan's pseudocode used `SseEventSchema.parse(rawEv)` inside a try/catch. That works, but throwing for control flow adds an unwinding cost to every received event and couples the drop behaviour to exception semantics. `safeParse` is the idiomatic zod API for this — returns a discriminated union, no exception overhead, reads clearer.
- **Fix:** Used `SseEventSchema.safeParse` + `if (!parsed.success) continue;`. Same security posture (malformed events dropped), cleaner hot path.
- **Files modified:** `apps/dashboard/src/app/api/stream/route.ts`
- **Commit:** 6b1224f

**2. Canonicalised SSE response headers to title-case**
- **Found during:** Task 1 acceptance-criteria grep (`grep -F "X-Accel-Buffering"` / `grep -F "Cache-Control"`).
- **Issue:** My initial implementation used lowercase header names (`'x-accel-buffering': 'no'`) which HTTP treats as equivalent but the plan's acceptance greps are literal text matches.
- **Fix:** Rewrote header object to title-case (`'X-Accel-Buffering'`, `'Cache-Control'`, `Connection`, `'Content-Type'`). No behavioural change; HTTP headers are case-insensitive on the wire.
- **Files modified:** `apps/dashboard/src/app/api/stream/route.ts`
- **Commit:** 6c82da3

### Rule 3 — Auto-fix blocking issues

**3. useSseKind generic type cast needed `unknown` intermediate**
- **Found during:** Task 2 `pnpm typecheck` (error TS2352).
- **Issue:** Casting `Handler<K>` directly to `Handler<SseEventKind>` inside the trampoline fails TS's overlap check on a narrowed discriminated union. Plan's pseudocode `(handler as Handler)` would've hit the same error.
- **Fix:** Used `(handlerRef.current as unknown as (ev: SseEvent) => void)(ev)` — standard double-cast pattern when the narrowed variance isn't provable to TS. Runtime behaviour is identical; the narrowing guarantee comes from the `ev.kind !== kind` guard one line above.
- **Files modified:** `apps/dashboard/src/components/system/SseProvider.tsx`
- **Commit:** 6c82da3

No Rule 2 / Rule 4 triggered — threat register dispositions all implemented as planned; no architectural changes.

## Threat Flags

None. This plan's network surface is exactly `/api/stream` (gated by existing middleware + cookie) and SigV4 traffic to the already-enumerated relay-proxy Function URL. No new endpoints, no new auth paths, no schema changes at trust boundaries.

## Known Stubs

None. Plan 03-07 doesn't render any UI — it ships only the pipeline and the `useSseKind` primitive. Stub view pages under `/today` etc. are inherited from Plan 03-06 and are out of scope for this plan.

One intentional deferral: the Topbar **ConnectionStatus dot** mentioned in the additional_guidance block is NOT shipped in this plan. The plan's `<tasks>` block only specifies route + provider + hook + tests. The provider's Context already exposes `status` + `lastConnectedAt` so a future polish pass can mount a dot without provider changes. Documented in the decisions block.

## Ready-for handoffs

- **Plan 03-08 (Today + Entity dossier):** `useSseKind('entity_merge', (ev) => ev.entity_id === id && refetch())` and `useSseKind('timeline_event', ...)`. Handlers must be idempotent; use event `id` as a dedup key.
- **Plan 03-09 (Inbox):** `useSseKind('inbox_item', () => router.refresh())`. Optionally announce via `useLiveRegion().announce(`New inbox item: ${ev.id}`)` for a11y rule 12 (title not in the pointer-only payload — would need a follow-up fetch; deferred to Plan 09's discretion).
- **Plan 03-10 (Calendar):** `useSseKind('timeline_event', ...)` for meeting updates if needed.
- **Plan 03-12 (end-to-end NOTIFY test):** the whole pipeline is now wired — Plan 12 can publish on the relay's Postgres LISTEN channel and assert a browser event fires within the <2s SLO.

## Self-Check: PASSED

- FOUND: apps/dashboard/src/app/api/stream/route.ts
- FOUND: apps/dashboard/src/components/system/SseProvider.tsx
- FOUND: apps/dashboard/src/lib/sse-client.ts
- FOUND: apps/dashboard/tests/unit/sse-route.test.ts
- FOUND: apps/dashboard/tests/unit/sse-client.test.ts
- FOUND: apps/dashboard/tests/unit/sse-provider.test.tsx
- FOUND: apps/dashboard/src/app/(app)/layout.tsx (modified — now wraps with <SseProvider>)
- FOUND: apps/dashboard/tests/e2e/sse-reconnect.spec.ts (modified — fixme -> active-skipped)
- FOUND: commit 6b1224f (feat(03-07): /api/stream SSE Route Handler)
- FOUND: commit 6c82da3 (feat(03-07): SseProvider + useSseKind + canonical SSE header casing)
