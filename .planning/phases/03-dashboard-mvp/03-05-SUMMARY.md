---
phase: 03-dashboard-mvp
plan: 05
subsystem: dashboard-auth
tags: [auth, middleware, sigv4, cookie, edge-runtime]
requirements: [INF-12]
requirements_addressed: [INF-12]

dependency_graph:
  requires:
    - 03-00 (monorepo scaffold + @kos/dashboard package)
    - 03-01 (Tailwind tokens + shadcn primitives + ESLint middleware guard)
    - 03-02 (dashboard-api contract shapes)
    - 03-04 (DashboardStack CDK — Lambda Function URL exists to point at)
  provides:
    - kos_session httpOnly cookie (90-day, httpOnly + Secure + SameSite=Lax)
    - constantTimeEqual Edge-safe string compare
    - middleware.ts gate on all non-public paths
    - /api/auth/login + /api/auth/logout route handlers
    - callApi<T>(path, init, schema): SigV4-signed JSON fetch against dashboard-api
    - callRelay(path, init): SigV4-signed raw Response fetch against listen-relay
  affects:
    - 03-06 (app shell will layer sidebar/topbar on top of the auth gate)
    - 03-07 (SSE client consumes callRelay)
    - 03-08..03-13 (every (app)/* Server Component consumes callApi)

tech_stack:
  added:
    - aws4fetch@1.0.20 (SigV4 via Web Crypto, ~1 KB cold-start cost)
    - zod@3.23.8 (already root-contract pin — added as direct dashboard dep so Vitest resolves it through transitive import of @kos/contracts/dashboard)
  patterns:
    - Edge-runtime middleware + pure-JS constant-time compare (P-01 compliance)
    - Node-runtime route handlers for cookies() (consistent with contracts import surface)
    - Memoised AwsClient singleton per warm Vercel Node lane

key_files:
  created:
    - apps/dashboard/src/middleware.ts
    - apps/dashboard/src/lib/constant-time.ts
    - apps/dashboard/src/lib/dashboard-api.ts
    - apps/dashboard/src/app/api/auth/login/route.ts
    - apps/dashboard/src/app/api/auth/logout/route.ts
    - apps/dashboard/src/app/(auth)/login/page.tsx
    - apps/dashboard/src/app/(auth)/login/LoginForm.tsx
    - apps/dashboard/tests/unit/constant-time.test.ts
    - apps/dashboard/tests/unit/login-route.test.ts
    - apps/dashboard/tests/unit/dashboard-api.test.ts
  modified:
    - apps/dashboard/package.json (added aws4fetch + zod)
    - apps/dashboard/tests/e2e/auth-middleware.spec.ts (fixme → real cases)
    - pnpm-lock.yaml

decisions:
  - "Cookie value holds the submitted Bearer token verbatim — middleware recomputes constant-time equality against KOS_DASHBOARD_BEARER_TOKEN on every request. Rotation = bump the env var; existing sessions invalidate on next request."
  - "Middleware declares PUBLIC_PATHS (/login, /api/auth/login, /api/auth/logout) in both matcher regex + in-handler early-return for defence-in-depth against matcher regex drift."
  - "/api/auth/logout is POST-only (not GET). SameSite=Lax cookies protect against cross-site logout CSRF; the LoginForm/topbar are responsible for navigation post-logout. Plan allowed GET-with-302 but POST+router.push preserves the documented CSRF threat disposition (T-3-05-02)."
  - "Body parsing in /api/auth/login manually calls req.text() + JSON.parse so zero-length and malformed bodies both land on 400 rather than surfacing a native Next parser error — keeps T-3-05-06 deterministic."
  - "callApi surfaces the raw HTTP error body verbatim in thrown Error messages. Safe because dashboard-api never echoes caller credentials and all calls are server-to-server (not surfaced to clients)."

metrics:
  duration: 00:15
  tasks: 2
  files: 10
  tests_added: 17
  tests_passing: 25 (all dashboard unit tests)
  commits:
    - a248327 feat(03-05): auth middleware + login/logout routes + constant-time compare
    - ba74265 feat(03-05): /login page + LoginForm + callApi SigV4 library
  completed: 2026-04-23T10:30:00Z
---

# Phase 3 Plan 05: Bearer Auth + Middleware + callApi SigV4 Library Summary

JWT-free Bearer session: httpOnly cookie gate via Edge middleware + Node-runtime login/logout handlers + `aws4fetch`-signed `callApi<T>` wrapper validated through `@kos/contracts` zod schemas — the auth primitives that Plan 06's app shell and Plan 07's SSE client will consume.

## One-liner

Bearer token → httpOnly `kos_session` cookie; Edge middleware gates all non-public paths with constant-time compare; `callApi`/`callRelay` provide SigV4-signed typed access to `dashboard-api` + `dashboard-listen-relay` Lambda Function URLs.

## What shipped

### Task 1 — Middleware + auth routes (commit a248327)

- **`src/middleware.ts`** (Edge runtime): reads `kos_session` cookie, constant-time-compares against `KOS_DASHBOARD_BEARER_TOKEN`. Non-matching cookies redirect to `/login?return=<path>`. Matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `sw.js`, `manifest.webmanifest`, `/icons/*`, plus in-handler early-return for defence-in-depth on `/login`, `/api/auth/*`.
- **`src/lib/constant-time.ts`**: pure-JS `constantTimeEqual(a, b)` — O(n) iteration across all same-length chars. Used by both middleware (Edge — no Node crypto per P-01) and the login handler (Node).
- **`src/app/api/auth/login/route.ts`** (`runtime='nodejs'`): zod-validates body via `LoginRequestSchema` (400 on malformed), constant-time-compares against env secret (401 on mismatch), sets cookie: `httpOnly + Secure + SameSite=Lax + path=/ + maxAge=7_776_000` (90 days per D-19). Returns zod-validated `{ ok: true }`.
- **`src/app/api/auth/logout/route.ts`** (`runtime='nodejs'`): clears `kos_session` via `maxAge=0` + matching attributes.
- **`tests/unit/constant-time.test.ts`** (6 cases): identical, length-mismatch, first-char-mismatch, last-char-mismatch, empty-empty, non-string inputs.
- **`tests/unit/login-route.test.ts`** (6 cases): correct-token → 200 + cookie, wrong-token → 401 + no cookie, malformed body → 400, empty body → 400, unset env secret → 401, logout → cookie cleared.
- **`tests/e2e/auth-middleware.spec.ts`**: migrated from `fixme` to real Playwright — redirect, 401 on bad token, 400 on malformed, full login → access → logout round-trip (skipped when `KOS_TEST_BEARER_TOKEN` absent).

### Task 2 — `/login` page + `callApi` SigV4 library (commit ba74265)

- **`src/lib/dashboard-api.ts`**: memoised `AwsClient` (service=lambda, region=`eu-north-1`); exports:
  - `callApi<T>(path, init, schema)` — SigV4-signs against `KOS_DASHBOARD_API_URL`, merges default `content-type: application/json`, parses response via the caller's zod schema, throws `dashboard-api <path> → <status>: <body>` on non-2xx.
  - `callRelay(path, init)` — same client against `KOS_DASHBOARD_RELAY_URL`, returns raw `Response` for streaming bodies (Plan 07's SSE proxy consumer).
  - `_resetClientForTests()` — test helper.
  - Re-exports `AwsClient`.
- **`src/app/(auth)/login/page.tsx`** — Server Component, `dynamic = 'force-dynamic'`. Renders 420px card on `--color-bg`, brand mark + "Kevin OS" wordmark, `<Suspense><LoginForm /></Suspense>`, iOS/Chrome install help verbatim per UI-SPEC §Copywriting (D-32).
- **`src/app/(auth)/login/LoginForm.tsx`** — `'use client'`. Visible label "Paste session token", `<Input type="password">`, "Sign in" button, `useTransition` for pending state, inline `role="alert"` error text "Token rejected. Check it and try again." (verbatim). POSTs to `/api/auth/login`; on success clears token from local state before `router.push(returnTo as Route)` + `router.refresh()`.
- **`tests/unit/dashboard-api.test.ts`** (5 cases): URL base concatenation, header merge (caller headers + default content-type), schema validation on response, non-2xx throws with status + body, `callRelay` hits relay base + returns raw Response.

## Vercel env vars required at this point

| Variable | Scope | Source | Used by |
|----------|-------|--------|---------|
| `KOS_DASHBOARD_BEARER_TOKEN` | Production + Preview + Development | rotate via `scripts/sync-vercel-env.ts` (Plan 11) | middleware.ts, /api/auth/login |
| `KOS_DASHBOARD_API_URL` | Production + Preview | CDK DashboardStack output (Plan 03-04) | dashboard-api.ts callApi |
| `KOS_DASHBOARD_RELAY_URL` | Production + Preview | CDK DashboardStack output (Plan 03-04 + 03-03) | dashboard-api.ts callRelay (Plan 07 wires) |
| `AWS_ACCESS_KEY_ID_DASHBOARD` | Production + Preview + Development | static IAM user `kos-dashboard-caller` | dashboard-api.ts AwsClient |
| `AWS_SECRET_ACCESS_KEY_DASHBOARD` | Production + Preview + Development | static IAM user `kos-dashboard-caller` | dashboard-api.ts AwsClient |
| `AWS_REGION` | Production + Preview + Development (optional, default `eu-north-1`) | constant | dashboard-api.ts AwsClient |
| `KOS_TEST_BEARER_TOKEN` | Playwright runner only (CI or local .env.test) | mirrors KOS_DASHBOARD_BEARER_TOKEN | auth-middleware.spec.ts, fixtures.ts |

None of these are prefixed `NEXT_PUBLIC_*` — verified by grep over `apps/dashboard/src/`. The ESLint guard added in Plan 01 still catches any future prefix regression.

## Cookie policy (binding)

- **Name:** `kos_session`
- **Value:** submitted Bearer token (validated against env secret before setting)
- **Attributes:** `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000` (90 days — D-19)
- **Rotation:** bump `KOS_DASHBOARD_BEARER_TOKEN` in Vercel → all existing sessions invalidate on next request (next middleware check → constantTimeEqual mismatch → 302 to /login).

## Middleware matcher scope

```
matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest\\.webmanifest|icons/).*)']
```

Covers every route except Next static output + favicon + PWA assets. In-handler early-return adds `/login`, `/api/auth/login`, `/api/auth/logout`.

## Sentry — NOT yet wired (Plan 06 adds it)

Per plan `<output>` spec: Sentry integration is deferred to Plan 06 which lands the app shell. This plan focuses purely on auth primitives; Sentry's cookie/authorization scrubber list belongs to the observability wiring task in Plan 06.

## Build result

- `pnpm --filter @kos/dashboard typecheck` → clean
- `pnpm --filter @kos/dashboard lint` → 0 errors, 2 pre-existing warnings in config files (out of scope)
- `pnpm --filter @kos/dashboard test --run tests/unit/` → **25 tests pass across 5 files** (constant-time 6 + login-route 6 + dashboard-api 5 + pre-existing bolag 7 + sentinel 1)
- `pnpm --filter @kos/dashboard build` → succeeds:
  - `/login` — 11.2 kB (dynamic)
  - `/api/auth/login` — dynamic function
  - `/api/auth/logout` — dynamic function
  - Middleware bundle — 32.6 kB (Edge)

## Deviations from Plan

### Rule 3 — Auto-fix blocking issues

**1. Added `zod@3.23.8` as direct `@kos/dashboard` dependency**
- **Found during:** Task 1 login-route tests
- **Issue:** Vitest could not resolve `zod` from `packages/contracts/src/dashboard.ts` because pnpm had never populated `packages/contracts/node_modules/` (workspace install had skipped transitive deps for unlinked sub-packages).
- **Fix:** Ran `pnpm --filter @kos/dashboard add zod@3.23.8` + `pnpm --filter @kos/contracts install`. Dashboard now has `zod` hoisted; contracts has its own node_modules populated.
- **Files modified:** `apps/dashboard/package.json`, `pnpm-lock.yaml`
- **Commit:** a248327

### Rule 1 — Auto-fix bugs

**2. Removed unused `_responses` export from login/route.ts**
- **Found during:** Task 2 `pnpm build`
- **Issue:** Next 15 App Router's route-export type check (`.next/types/app/api/auth/login/route.ts`) rejects non-standard exports alongside `POST`. My draft had a helper const `_responses` for lint-appeasement; build-time type check refused it.
- **Fix:** Deleted the unused const + associated `const INVALID = ...` / `const MALFORMED = ...` lines (they were never referenced by `POST`). Body parse path already returns inline `NextResponse.json(...)` responses.
- **Files modified:** `apps/dashboard/src/app/api/auth/login/route.ts`
- **Commit:** ba74265

### Rule 1 — Auto-fix bugs

**3. Cast `returnTo` param to `Route` in LoginForm.tsx**
- **Found during:** Task 2 `pnpm build`
- **Issue:** `typedRoutes: true` in `next.config.ts` means `router.push(string)` fails the typecheck at build time.
- **Fix:** `import type { Route } from 'next'` + `router.push(returnTo as Route)`. Middleware still enforces auth on whatever path is supplied — the runtime invariant is preserved.
- **Files modified:** `apps/dashboard/src/app/(auth)/login/LoginForm.tsx`
- **Commit:** ba74265

No Rule 2 / Rule 4 triggered — threat model dispositions (T-3-05-01..06) are all implemented as planned.

## Threat Flags

None — this plan does not introduce new network surface beyond what the `<threat_model>` block already enumerates.

## Known Stubs

None. The one forward-reference in `dashboard-api.ts` is `callRelay` which Plan 07 will consume; it is already wired as a real SigV4 call against `KOS_DASHBOARD_RELAY_URL`, not a placeholder.

## Ready-for handoffs

- **Plan 03-06 (app shell):** can now `import { callApi } from '@/lib/dashboard-api'` inside `(app)/**/page.tsx` Server Components; middleware guarantees `kos_session` is present. Plan 06 should wire Sentry with a cookie+authorization scrubber on top of this auth surface.
- **Plan 03-07 (SSE client):** `callRelay('/stream/...')` returns a raw `Response` whose body is a stream — pipe through to the browser via Next's `Response` passthrough in a Node-runtime route handler.

## Self-Check: PASSED

- FOUND: apps/dashboard/src/middleware.ts
- FOUND: apps/dashboard/src/lib/constant-time.ts
- FOUND: apps/dashboard/src/lib/dashboard-api.ts
- FOUND: apps/dashboard/src/app/api/auth/login/route.ts
- FOUND: apps/dashboard/src/app/api/auth/logout/route.ts
- FOUND: apps/dashboard/src/app/(auth)/login/page.tsx
- FOUND: apps/dashboard/src/app/(auth)/login/LoginForm.tsx
- FOUND: apps/dashboard/tests/unit/constant-time.test.ts
- FOUND: apps/dashboard/tests/unit/login-route.test.ts
- FOUND: apps/dashboard/tests/unit/dashboard-api.test.ts
- FOUND: commit a248327 (feat(03-05): auth middleware + login/logout routes + constant-time compare)
- FOUND: commit ba74265 (feat(03-05): /login page + LoginForm + callApi SigV4 library)
