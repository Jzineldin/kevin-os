---
phase: 03-dashboard-mvp
verified: 2026-04-24T00:30:00Z
status: human_needed
score: 9/9 REQs have code backing; 14/14 plans complete; relay live HEALTHY; 0/3 device-level PWA install tests + 1/1 operator deploy run remain
overrides_applied: 0
re_verification:
  previous_status: null
  previous_score: null
  gaps_closed:
    - "Relay Fargate health check (commits d615287 + 628362b) — pg-listen connected listener registered before await; NLB SG ingress for VPC CIDR. Live HEALTHY at 2026-04-23T22:32Z per .planning/debug/resolved/relay-healthcheck-fails.md."
    - "Dashboard Composer dead-letter (audit H1, quick task 260423-vra commit b3a4178) — publishCapture now emits Source='kos.capture' matching the canonical triage rule filter."
  gaps_remaining:
    - "Operator runs `pnpm verify-phase-3` against live deploy — the 6 ROADMAP SCs exercise live Vercel + Lambda + RDS + SSE pipeline; CANNOT run from agent."
    - "Device-level PWA install tests (Android home-screen install, iOS Safari shortcut, desktop Chrome/Edge install) — requires physical device interaction."
    - "Full-flow SSE smoke test: Telegram voice (or synthetic bypass) → Notion row → entity-resolver → dashboard-notify → pg_notify → relay → /api/stream → SseProvider re-render. Relay now healthy, but end-to-end push not yet exercised post-fix."
    - "Gate 4 session-counter starts after operator completes deploy step 10 of 03-DEPLOY-RUNBOOK.md."
  regressions: []
human_verification:
  - test: "Operator executes 13-step deploy runbook + runs `pnpm verify-phase-3`"
    expected: "`pnpm verify-phase-3` exits 0 — all 6 Phase 3 SCs PASS (UI-01 Today, UI-02 Entity, UI-03 Calendar, UI-04 Inbox, UI-05 PWA manifest, UI-06 SSE stream)"
    why_human: "Deploy requires Vercel token, CDK deploy of KosDashboard stack (live AWS spend), Secrets Manager seeding with Bearer token + caller access keys + Sentry DSN, Vercel env sync. Agent runbook authored but execution is operator-authorized."
    runbook: |
      # See 03-DEPLOY-RUNBOOK.md (13 steps). Condensed:
      
      # Steps 1-2: seed Secrets Manager (bearer token, dashboard caller access key, Sentry DSN)
      bash scripts/seed-dashboard-secrets.sh
      
      # Step 3: CDK deploy KosDashboard stack (~8 min; includes DashboardApi Lambda, relay Fargate, notify Lambda, Cloudfront)
      cd packages/cdk && npx cdk deploy KosDashboard --require-approval never && cd ../..
      
      # Steps 4-7: sync Vercel env + deploy dashboard + verify relay healthy
      pnpm sync-vercel   # pulls CFN outputs + secrets, writes 9 env vars into Vercel
      cd apps/dashboard && vercel --prod && cd ../..
      aws ecs describe-services --cluster kos-cluster --services KosDashboardRelayService \
        --query 'services[0].runningCount' --output text   # expect 1
      
      # Step 8-9: smoke-test auth
      curl -s -c /tmp/cook "https://${DASHBOARD_URL}/login" -d "token=${BEARER}"
      curl -s -b /tmp/cook "https://${DASHBOARD_URL}/api/stream" --max-time 3 | head -5
      
      # Step 10: run verifier (exits 1 on any SC fail)
      pnpm verify-phase-3
      
      # Step 11: exercise merge flow on disposable fixtures (manual; writes entity_merge_audit row)
      # Step 12: send Telegram voice → watch /inbox for real-time SSE update within 25s
      # Step 13: install PWA on Android + desktop (manual)
  - test: "Android home-screen PWA install"
    expected: "Navigate to deployed URL in Chrome on Android → menu → 'Install app' option appears → installs → icon on home screen → launches in standalone (no Chrome chrome)"
    why_human: "Install criteria depend on beforeinstallprompt UX + device state; cannot be fully automated"
    runbook: "On physical Android device: Chrome → deployed URL → ⋮ menu → 'Install app' → Install → home screen icon → tap → standalone window"
  - test: "iOS Safari Add-to-Home-Screen shortcut"
    expected: "On iOS 17+: Safari → deployed URL → Share → Add to Home Screen → icon appears → tap launches in Safari with URL bar (NOT standalone — per iOS 17.4 EU DMA)"
    why_human: "Deliberately validates that iOS is a Safari shortcut, not a standalone PWA (locked decision)"
    runbook: "On physical iOS device (17+): Safari → deployed URL → Share → Add to Home Screen → tap icon → confirms URL bar visible"
  - test: "Desktop PWA install (Chrome/Edge)"
    expected: "Navigate to deployed URL in Chrome/Edge on macOS/Windows → address bar install icon appears → click → app installs → standalone window"
    why_human: "UX-dependent install chrome"
    runbook: "macOS/Windows Chrome or Edge: deployed URL → address-bar install icon → Install → standalone window opens"
  - test: "Full-flow SSE smoke test post-relay-fix"
    expected: "Open /inbox in dashboard (with Bearer cookie); send synthetic capture.voice.transcribed EventBridge event; within 2s an inbox-item SSE event fires and the inbox-item card re-renders"
    why_human: "Requires live deploy + a way to inject the event (aws events put-events or Telegram bypass script)"
    runbook: |
      # In one shell: tail dashboard /api/stream with the Bearer cookie
      curl -N -b "kos_session=${COOKIE}" "https://${DASHBOARD_URL}/api/stream"
      
      # In another shell: fire synthetic event
      bash scripts/fire-synthetic-capture.sh kevin-test-001
      
      # Expect: within 2s, the stream receives:
      #   event: capture_ack
      #   data: {"capture_id":"kevin-test-001",...}
---

# Phase 3: Dashboard MVP Verification Report

**Phase Goal:** Kevin has a calm visual interface that owns one workflow the dashboard does better than anything else: per-entity dossier review and editing. Today view, per-entity timeline, calendar view, and the Inbox approval queue are usable on desktop and as installed PWA on Android/desktop. Real-time updates push without polling.

**Verified:** 2026-04-24T00:30:00Z
**Status:** `human_needed`
**Re-verification:** No — initial verification.

## Executive Summary

Phase 3 is **code-complete** (14/14 plans landed) and the last operational blocker — the Fargate relay Fargate container healthcheck — is **fixed and live HEALTHY** as of 2026-04-23T22:32Z (commits `d615287` register pg-listen connected listener before awaited `connect()`, `628362b` NLB security-group ingress for VPC CIDR on :8080). The dashboard-Composer dead-letter drift (audit H1) is also fixed (commit `b3a4178`, quick task 260423-vra).

Phase 3 is **awaiting operator deploy execution.** The 13-step runbook authored in Plan 03-13 (`03-DEPLOY-RUNBOOK.md`) is the definitive path: seed secrets → `cdk deploy KosDashboard` → `pnpm sync-vercel` → `vercel --prod` → `pnpm verify-phase-3`. Only `pnpm verify-phase-3` exits 0 against live infrastructure will promote Phase 3 to `passed`.

**Decision:** `human_needed`. The code layer is 100% done; the infrastructure layer is gated on Kevin-authorized AWS + Vercel execution.

## Goal Achievement — Roadmap Success Criteria

All six criteria verified at the code/schema/script level. Live verification deferred to operator.

| # | Success Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Kevin opens dashboard at prod URL (Vercel, Bearer-token auth from Secrets Manager), sees Today view with calendar (today+tomorrow), Top 3, Drafts, Dropped threads, voice/text dump zone (UI-01) | ✓ VERIFIED (code) | `apps/dashboard/src/app/(app)/today/page.tsx` RSC assembled from 5 components + Composer; `/api/today` route handler; auth middleware rejects without `kos_session` cookie; `scripts/sync-vercel-env.ts` seeds Bearer from Secrets Manager; **Live deploy deferred.** |
| 2 | Click any entity name → per-entity page in <500ms for 50 timeline rows (UI-02) with AI "What you need to know" block + timeline + linked tasks/projects/documents | ✓ VERIFIED (code) · ⚠ live latency unmeasured | `apps/dashboard/src/app/(app)/entity/[id]/page.tsx` + `/api/entities/:id` + `/api/entities/:id/timeline` (paginated 50 rows); server-rendered timeline MV read path; materialized view wiring verified in 03-10 SUMMARY. |
| 3 | Manual entity edit + merge works (ENT-07); merges archive never delete, copy relations to canonical, write audit table; partial-failure → "Resume?" card in Inbox | ✓ VERIFIED (code) | 4-step state machine in `services/dashboard-api/src/merge.ts` (draft → preview → confirm → complete); transactional handler with rollback on partial failure; `ResumeMergeCard` component + `/api/merge-resume` action; `entity_merge_audit` table migration + `trg_entity_merge_notify` SQL trigger. |
| 4 | Real-time push works: event to `kos.output` → Postgres NOTIFY → SSE streams to open tab → card re-renders <2s (UI-06) | ✓ VERIFIED (code+relay-live) · ⚠ full-flow unmeasured | `dashboard-notify` Lambda converts EventBridge → `pg_notify('kos_output',...)`; `dashboard-listen-relay` Fargate LISTEN + Server-Sent Events proxy to `/api/stream` route; `SseProvider` + `useSseKind` hook. Relay live HEALTHY per 2026-04-23T22:32Z debug resolution. |
| 5 | PWA install works on Android + desktop (UI-05); iOS is Safari shortcut (not standalone); offline mode renders last Today state from 24h service-worker cache | ✓ VERIFIED (code) · ⚠ device install untested | `@serwist/next` PWA manifest + service worker + `/offline` fallback + `OfflineBanner` (Plan 03-12); Lighthouse CI budget gate active; device-level install requires manual test (see `human_verification` above). |
| 6 | Inbox view (UI-04) shows drafts awaiting approval, ambiguous entity routings, new entities to confirm with Approve/Edit/Skip; Calendar view (UI-03) renders events from Command Center Deadline field | ✓ VERIFIED (code) | Two-pane Inbox with J/K/Enter/E/S keyboard nav + `useOptimistic` (Plan 03-09); Calendar week view + `/api/calendar/week` route (Plan 03-10); integrates with notion-indexer Command Center Deadline field sync. |

**Score: 6/6 roadmap SCs verified at code level. 0/6 verified as live-deployed (gated on operator runbook execution).**

## Required Artifacts

14 plans, 14 SUMMARYs, full Next.js app + 3 Fargate services + DashboardStack CDK.

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/dashboard/` | Next.js 15 + React 19 + Tailwind 4 + shadcn/ui workspace | ✓ VERIFIED | Plan 03-00; `package.json` lists exact versions; `tsconfig.json` extends `../../tsconfig.base.json` |
| `apps/dashboard/src/middleware.ts` | Bearer-token auth middleware, constant-time compare, kos_session cookie | ✓ VERIFIED | Plan 03-05; HttpOnly + Secure + SameSite=Lax cookie |
| `apps/dashboard/src/app/(app)/today/page.tsx` | Today RSC with 5 sections + Composer | ✓ VERIFIED | Plan 03-08; captureText Server Action; useSseKind('capture_ack') PulseDot |
| `apps/dashboard/src/app/(app)/inbox/page.tsx` | Two-pane Inbox with J/K keyboard + useOptimistic | ✓ VERIFIED | Plan 03-09 |
| `apps/dashboard/src/app/(app)/entity/[id]/page.tsx` | Entity dossier with timeline | ✓ VERIFIED | Plan 03-10; timeline MV + live 10-min overlay |
| `apps/dashboard/src/app/(app)/merge/page.tsx` | Merge review page | ✓ VERIFIED | Plan 03-11; 4-step state machine + MergeConfirmDialog |
| `apps/dashboard/src/components/SseProvider.tsx` | SSE client with auto-reconnect ≤1s | ✓ VERIFIED | Plan 03-07; `useSseKind` per-kind subscribe |
| `apps/dashboard/public/manifest.webmanifest` + `sw.js` | PWA manifest + service worker | ✓ VERIFIED | Plan 03-12; @serwist/next generates sw.js |
| `services/dashboard-api/src/{events,merge,today,calendar,entities,inbox,timeline}.ts` | Lambda routes for dashboard read + write operations | ✓ VERIFIED | Plans 03-02, 03-10, 03-11; post-audit-H1 `publishCapture` emits canonical `kos.capture` source |
| `services/dashboard-listen-relay/src/{index,subscriber}.ts` | Fargate pg-listen → SSE proxy | ✓ VERIFIED + LIVE HEALTHY | Plan 03-03; fixed in commits d615287 + 628362b |
| `services/dashboard-notify/src/handler.ts` | EventBridge kos.output → pg_notify Lambda | ✓ VERIFIED | Plan 03-03 |
| `packages/cdk/lib/stacks/integrations-dashboard.ts` | DashboardStack: DashboardApi Lambda + relay Fargate + notify Lambda + 3 IAM users + 3 Secrets + NLB | ✓ VERIFIED | Plan 03-04; `cdk synth` green |
| `packages/db/drizzle/0009_listen_notify_triggers.sql` | SQL triggers: `agent_runs` → `capture_ack`/`draft_ready`; `entity_merge_audit` → `entity_merge` | ✓ VERIFIED | Plan 03-03 |
| `packages/contracts/src/dashboard.ts` | Zod schemas for every dashboard-api route (single source of truth for client + server) | ✓ VERIFIED | Plan 03-00 Wave 0 |
| `apps/dashboard/lighthouserc.json` | Perf budgets TTI < 1.5s, TBT < 300ms, CLS < 0.1 on Today | ✓ VERIFIED | Plan 03-12 |
| `apps/dashboard/playwright.config.ts` + `tests/e2e/*.spec.ts` | E2E harness: auth, SSE reconnect, merge audit, inbox keyboard, PWA install | ✓ VERIFIED | Plan 03-00 Wave 0; 5 spec files; stub-then-fill pattern |
| `scripts/sync-vercel-env.ts` | 9 env vars Vercel sync from CFN + Secrets | ✓ VERIFIED | Plan 03-13; placeholder-sentinel guard + never-log-secret-value |
| `scripts/verify-phase-3.ts` | Goal-backward 6-SC verifier | ✓ VERIFIED | Plan 03-13; exits 1 on any SC FAIL |
| `03-DEPLOY-RUNBOOK.md` | 13-step Kevin-driven deploy sequence | ✓ VERIFIED | Plan 03-13 |

## Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| `bin/kos.ts` | DashboardStack | `new DashboardStack(app, 'KosDashboard', {...})` | ✓ WIRED |
| DashboardStack | DashboardApi Lambda | NodejsFunction + Function URL + IAM role | ✓ WIRED |
| DashboardStack | relay Fargate service | TaskDef + Service + NLB + TargetGroup + SG | ✓ WIRED |
| relay → RDS | pg-listen via RDS Proxy IAM | `@aws-sdk/rds-signer` IAM token flow | ✓ WIRED |
| notify Lambda ← EventBridge | kos.output rule targets notify Lambda | EventBridge rule source=['kos.capture','kos.agent','kos.output'] | ✓ WIRED |
| notify Lambda → RDS | `pg_notify('kos_output', payload)` | Pool + IAM signer | ✓ WIRED |
| relay → browser | SSE stream via NLB URL | Fastify + eventsource protocol | ✓ WIRED + LIVE |
| dashboard-api `publishCapture` | kos.capture bus | `Source: 'kos.capture'` (post-H1 fix) | ✓ WIRED |
| Middleware → Secrets Manager | Bearer token lookup + constant-time compare | `GetSecretValue(kos/dashboard-bearer-token)` | ✓ WIRED |
| Vercel env sync | 9 vars from CFN + Secrets | `scripts/sync-vercel-env.ts` | ✓ WIRED |

## Data-Flow Trace (Level 4)

Phase 3 owns the "read-side" of the entity graph and the real-time push-to-browser channel.

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `/api/today` RSC fetch | today JSON | Postgres + Notion Command Center via dashboard-api | Yes post-deploy | ⚠ HOLLOW (deploy pending) |
| `/api/entities/:id` | entity dossier + timeline rows | Postgres `entity_index` + `entity_timeline` MV | Yes post-deploy | ⚠ HOLLOW |
| `/api/merge` | merge state machine | Postgres `entity_merge_audit` table | Yes post-deploy | ⚠ HOLLOW |
| `/api/stream` SSE | live events | Fargate relay → NLB → CloudFront or direct Vercel Edge | ✓ WIRED + live relay HEALTHY; no full-flow event yet pushed post-relay-fix | ⚠ PARTIAL |
| `/api/auth/login` | Bearer token → kos_session cookie | Middleware + Secrets Manager constant-time | ✓ VERIFIED (code); ⚠ live untested | ⚠ HOLLOW |

All five are HOLLOW in the sense that infrastructure exists, wiring is correct, but no live production deploy has happened yet. The relay is the exception: it's healthy in prod post-fix.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Dashboard typecheck | `pnpm --filter @kos/dashboard typecheck` | Green per 03-12/03-13 SUMMARYs | ✓ PASS |
| Dashboard unit tests | `pnpm --filter @kos/dashboard test --run` | Green (~30s) | ✓ PASS |
| Dashboard Playwright e2e (against deployed preview) | `pnpm --filter @kos/dashboard e2e` | Not run against deployed preview yet | ? SKIP (operator) |
| Lighthouse CI budget gate | `pnpm --filter @kos/dashboard lhci autorun` | Green pre-deploy (against `next dev`) | ✓ PASS |
| Relay healthcheck live | `aws ecs describe-services --cluster kos-cluster --services KosDashboardRelayService` | runningCount=1, status HEALTHY at 2026-04-23T22:32Z | ✓ PASS |
| Live Vercel deploy | `cd apps/dashboard && vercel --prod` | Not run | ? SKIP (operator) |
| `pnpm verify-phase-3` live | `pnpm verify-phase-3` | Not run against deployed infra | ? SKIP (operator) |
| Full SSE flow post-relay-fix | synthetic capture → SSE | Not run | ? SKIP (operator) |

## Requirements Coverage

All 9 Phase 3 requirement IDs have implementation backing.

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| INF-12 | 03-04, 03-05, 03-13 | Vercel project with env secrets synced from AWS Secrets Manager | ✓ SATISFIED (code) | `vercel.json` pins regions=arn1, maxDuration=300 on /api/stream; sync script with placeholder-sentinel guard |
| UI-01 | 03-02, 03-06, 03-08, 03-13 | Today view: calendar, Top 3, Drafts, Dropped, voice/text dump | ✓ SATISFIED (code) | Composer captureText now routes correctly (post-H1 fix) |
| UI-02 | 03-02, 03-06, 03-10, 03-13 | Per-entity pages with AI block + timeline + linked tasks | ✓ SATISFIED (code) | Full dossier + 50-row timeline + linked projects |
| UI-03 | 03-02, 03-06, 03-10, 03-13 | Calendar view | ✓ SATISFIED (code) | Week view via `/api/calendar/week` |
| UI-04 | 03-01, 03-02, 03-06, 03-09, 03-13 | Inbox with Approve/Edit/Skip | ✓ SATISFIED (code) | J/K/Enter/E/S keyboard nav; `useOptimistic` |
| UI-05 | 03-01, 03-06, 03-12, 03-13 | PWA install (Android + desktop); iOS Safari shortcut; offline cache | ✓ SATISFIED (code) · ⚠ device install manual | `@serwist/next` + manifest + sw.js + /offline fallback |
| UI-06 | 03-03, 03-04, 03-07, 03-13 | SSE real-time via Postgres LISTEN/NOTIFY | ✓ SATISFIED (code+live-relay) · ⚠ full-flow untested | relay HEALTHY; SseProvider + useSseKind; no synthetic flow test post-fix |
| ENT-07 | 03-01, 03-11, 03-13 | Manual entity edit/merge; archive-never-delete; audit table | ✓ SATISFIED (code) | 4-step state machine + transactional merge + ResumeMergeCard for partial failure |
| ENT-08 | 03-01, 03-02, 03-10, 03-13 | Per-entity timeline chronological aggregation | ✓ SATISFIED (code) · ⚠ <500ms budget unmeasured live | Materialized view + 10-min live overlay |

**No orphaned requirements.** All 9 IDs mapped to Phase 3 in ROADMAP.md are claimed by plans in this phase.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `services/dashboard-listen-relay/Dockerfile` | HEALTHCHECK | overridden by ECS task-definition healthCheck (per debug ticket) | ℹ Info | Intentional — ECS precedence documented in resolved debug ticket |
| `apps/dashboard/vercel.json` | maxDuration: 300 | only on /api/stream; Pro tier required for > 10s | ℹ Info | Documented in VALIDATION.md Vercel Hobby-vs-Pro note |
| dashboard draft_ready / inbox_item / timeline_event SSE kinds | No producers in Phases 1-3 | dormant forward-compat wiring | ℹ Info | L2 from audit; intentional — Phase 4 (email drafts), Phase 6 (timeline events) become producers |

No 🛑 Blockers. All ℹ Info items are documented design choices.

## Nyquist Coverage

| Phase | VALIDATION.md | Compliant | Next Action |
|---|---|---|---|
| 03 | Exists | `nyquist_compliant: false` (wave_0_complete: true) | Per-task matrix not populated; run `/gsd-validate-phase 3` to flip flag after Kevin runs `pnpm verify-phase-3` live |

## Locked-Decision Fidelity

| Decision | Phase 3 Application | Status |
|---|---|---|
| SSE via Postgres LISTEN/NOTIFY (not AppSync/Pusher) | relay Fargate + pg-listen + /api/stream Route Handler | ✓ HONORED |
| Static Bearer token in Secrets Manager (no Cognito/Clerk) | middleware.ts + /api/auth/login constant-time compare | ✓ HONORED |
| Desktop primary + Android PWA + iOS Safari shortcut (iOS 17.4 EU DMA accepted) | Manifest scoped appropriately; `/offline` fallback; Lighthouse budgets | ✓ HONORED |
| Vercel (not AWS Amplify) for Next.js hosting | `vercel.json`, `sync-vercel-env.ts`, `03-DEPLOY-RUNBOOK.md` | ✓ HONORED |
| Canonical `kos.capture` source for all capture events (post-H1) | dashboard-api publishCapture emits Source:'kos.capture' | ✓ HONORED |

## Human Verification Required

See `human_verification:` frontmatter above for five items:
1. Execute 13-step deploy runbook + `pnpm verify-phase-3` green → promotes Phase 3 from `human_needed` to `passed`.
2. Android home-screen PWA install.
3. iOS Safari Add-to-Home-Screen shortcut.
4. Desktop Chrome/Edge PWA install.
5. Full-flow SSE smoke test post-relay-fix.

## Gaps Summary

**No code-level gaps block Phase 3.** All 14 plans shipped, all 9 requirements have implementation backing, the relay (last operational blocker) is live healthy, and the dashboard Composer dead-letter (audit H1) is closed.

The phase is in the same posture as Phase 1 on 2026-04-22: code complete, infrastructure layer pending Kevin-authorized AWS + Vercel deploy. The Plan 03-13 runbook (`03-DEPLOY-RUNBOOK.md`) has been rehearsed at the script level; all that remains is execution.

Gate 4 session-counter for the V2-Agent acceptance gate begins after step 10 of the runbook (first successful `pnpm verify-phase-3` run).

---

_Verified: 2026-04-24T00:30:00Z_
_Verifier: Claude (direct file authoring)_
