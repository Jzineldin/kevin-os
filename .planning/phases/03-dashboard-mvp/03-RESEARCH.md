# Phase 3: Dashboard MVP — Research

**Researched:** 2026-04-23
**Domain:** Next.js 15 App Router dashboard + SSE real-time + Vercel → in-VPC AWS bridge + transactional entity merge (Notion + RDS)
**Confidence:** HIGH on Next.js / Tailwind v4 / shadcn / SigV4 / Serwist / react-window. MEDIUM on the `dashboard-listen-relay` architecture (two viable variants survive — choice is the planner's).

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**View scope (D-01..D-06)**
- D-01: Ship Today, Per-entity (Person + Project), Inbox, Calendar, global Command Palette.
- D-02: Capture chat view DEFERRED to Phase 3.5 / Phase 4.
- D-03: Per-entity Company + Document variants deferred.
- D-04: Calendar = Command Center `Deadline` + `Idag` rows only (no Google Calendar until Phase 8).
- D-05: Today "Morning brief" slot renders whatever Phase 7 AUTO-01 writes to the 🏠 Today Notion page; stub copy until then.
- D-06: Every entity link routes to `/entities/[id]`.

**Visual system (D-07..D-12)**
- D-07: `TFOS-ui.html` at repo root is the binding visual spec.
- D-08: Tokens ported to Tailwind v4 `@theme` in `apps/dashboard/src/app/globals.css`, 1:1 with `:root` variables.
- D-09: shadcn/ui primitives; initial components = `button, card, dialog, command, input, tabs, separator, scroll-area, toast, avatar, tooltip, kbd`.
- D-10: cmdk command palette; `⌘K` / `Ctrl+K` open; Phase 3 = string-contains only (NL routing is Phase 6+).
- D-11: Geist + Geist Mono via `next/font/google`.
- D-12: No skeletons. Single 6×6 pulsing dot. Fade-in only on inserts.

**App shell & routing (D-13..D-15)**
- D-13: Next.js 15 App Router only. Route groups `(auth)` and `(app)`. Sidebar per mockup.
- D-14: RSC for initial loads; client components + SSE + `useOptimistic` for updates. No SWR / React Query.
- D-15: Server Actions for every mutation; Server Actions call the in-VPC API layer, not Notion directly.

**Data access (D-16..D-18)**
- D-16: Vercel does NOT connect to RDS directly. New `dashboard-api` Lambda (in-VPC) with Lambda Function URL + AWS_IAM auth.
- D-17: `dashboard-api` = Node 22 Lambda inside VPC, uses existing RDS Proxy + RDS IAM auth. Routes: `GET /today`, `GET /entities/:id`, `GET /inbox`, `POST /inbox/:id/approve|edit|skip`, `POST /entities/:id/merge`, `POST /capture`. zod at boundary.
- D-18: Dashboard reads never bypass the API layer; no `pg` connection string in Vercel.

**Auth (D-19..D-21)**
- D-19: `/login` → POSTs to `/api/auth/login` → validates against `kos/dashboard-bearer-token` Secrets Manager entry → sets httpOnly+Secure+SameSite=Lax cookie `kos_session`, 90-day expiry.
- D-20: Root `middleware.ts` gates every route outside `(auth)`. Missing/invalid cookie → 302 to `/login?return=...`. Bearer token IS the session.
- D-21: IAM access keys for `dashboard-api` Function URL in Vercel env vars: `AWS_ACCESS_KEY_ID_DASHBOARD`, `AWS_SECRET_ACCESS_KEY_DASHBOARD`. Scoped to `lambda:InvokeFunctionUrl` on that one URL.

**Real-time (D-22..D-26)**
- D-22: Pipeline: `kos.output` EventBridge → `dashboard-notify` Lambda → Postgres `NOTIFY kos_output, jsonb_payload` → SSE Route Handler LISTENs → browser.
- D-23: SSE endpoint `/api/stream` in `apps/dashboard`, Node runtime, `export const maxDuration = 300`. Client auto-reconnects 500ms → 60s backoff.
- D-24: `dashboard-listen-relay` Fargate task (0.25 vCPU / 0.5 GB, single instance in `kos-cluster`) holds the LISTEN; exposes long-polling HTTP endpoint `GET /events?cursor=...` protected by IAM auth. Vercel long-polls this and streams to browser.
- D-25: Payload contract = `{ kind, id, entity_id?, ts }`; pointer-only (8 KB NOTIFY cap). Full rows re-fetched via API layer.
- D-26: Quiet hours do not apply to SSE pushes. Web Push out of scope.

**Merge + manual edit (D-27..D-29)**
- D-27: Merge UI at dedicated route `/entities/[id]/merge`. Two-column: canonical (left) / source (right).
- D-28: Transactional in `dashboard-api`: copy Notion relations → archive source Notion page → update `entity_index` + FK tables under one RDS txn → write `agent_runs` row with `action='entity_merge_manual'`, `source_id`, `target_id`, `initiated_by='kevin'`, `merge_id` ULID. On partial failure, write `partial_merge_state` row and surface "Resume?" Inbox card keyed to `merge_id`.
- D-29: Manual entity edit = shadcn Dialog; writes to Notion; indexer sync propagates to RDS within ≤ 5 min.

**PWA (D-30..D-33)**
- D-30: `@serwist/next`. Manifest at `apps/dashboard/public/manifest.webmanifest`; icons 192/512.
- D-31: SW caches: (a) static via Workbox default, (b) `/today` HTML + API response via 24h SWR. Offline banner on cached render.
- D-32: iOS = Safari Add-to-Home-Screen only. Documented at `/login`.
- D-33: No proactive `beforeinstallprompt` banner. Install via address-bar icon or `/settings` page later.

**Performance (D-34..D-36)**
- D-34: Today TTFB + LCP < 1.5 s Stockholm edge. Entity page interactive < 500 ms.
- D-35: Timeline = 50 rows SSR + react-window virtualization thereafter. Infinite scroll paginated.
- D-36: Phase 3 queries live `mention_events + agent_runs` JOIN (not MV — MEM-04 MV lands Phase 6).

**Deploy & ops (D-37..D-40)**
- D-37: Vercel account `kevin-elzarka`, project `kos-dashboard`, root `apps/dashboard`, **Pro tier** ($20/mo — unlocks `maxDuration: 300`).
- D-38: Env-var sync script `scripts/sync-vercel-env.ts`. Keys: `KOS_DASHBOARD_API_URL`, `AWS_ACCESS_KEY_ID_DASHBOARD`, `AWS_SECRET_ACCESS_KEY_DASHBOARD`, `AWS_REGION=eu-north-1`, `KOS_DASHBOARD_BEARER_TOKEN`, `SENTRY_DSN`, `LANGFUSE_PUBLIC_KEY`.
- D-39: Custom domain deferred. Default `*.vercel.app` OK.
- D-40: `@sentry/nextjs` + Vercel Analytics (Pro-included; Gate 4 session count source).

**Language (D-41)**
- D-41: UI chrome English. Data passes through in whatever language it was written. No i18n library.

### Claude's Discretion

- Exact shadcn/ui subcomponent composition per view (mockup HTML is the target; assembly open).
- Layout grid specifics (~1280px max-width per mockup).
- Sentry sample rate, Langfuse correlation depth, error-boundary placement.
- Loading indicator placements subject to D-12.
- Exact Postgres NOTIFY channel name beyond `kos_output` (may split per-kind if performance warrants).
- Icon set beyond Geist Mono kbd badges — lucide-react default.
- `/settings` page content (stub acceptable).
- Keyboard shortcut help overlay (`?`) — nice-to-have.

### Deferred Ideas (OUT OF SCOPE)

- Capture chat view — Phase 3.5 / Phase 4.
- Command palette natural-language routing — Phase 6+ (needs AGT-04).
- Google Calendar merge — Phase 8 (CAP-09).
- Web Push desktop notifications.
- Company + Document entity dossier templates — no live data yet.
- Morning brief generation (AUTO-01) — Phase 7.
- Voice/text dump zone backend wiring (composer renders; pipeline wire-up may slip).
- Custom domain (`kos.tale-forge.app`).
- Upstash Redis pub/sub as SSE fan-out (alternative to Fargate relay).
- RDS Proxy exposed to Vercel via VPC peering.
- Multi-entity merge (>2 selections).
- Dashboard i18n library.
- Keyboard shortcut help overlay.
- `/settings` full UI.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **UI-01** | Today view — calendar, Top 3 priorities, Drafts to review, Dropped threads, voice/text dump zone | §6 (Today composition), §4 (shadcn components), §8 (RSC + Server Action capture) |
| **UI-02** | Per-entity pages (Person/Project) — dossier + AI "what you need to know" + chronological timeline + linked tasks/projects/documents | §7 (per-entity composition), §10 (react-window virtualization), §11 (live 10-min overlay) |
| **UI-03** | Calendar view — meetings, deadlines from Command Center | §6 (Today/Calendar data flow), §7 (entity linking) |
| **UI-04** | Inbox view — drafts, ambiguous routings, new entities; Approve/Edit/Skip | §8 (Server Actions + useOptimistic), §4 (J/K keyboard nav) |
| **UI-05** | Desktop-primary responsive PWA; Android + desktop install; iOS Safari shortcut | §9 (@serwist/next), §15 (PWA pitfalls) |
| **UI-06** | Real-time via SSE from Next.js backed by Postgres LISTEN/NOTIFY; Telegram = mobile push | §11 (NOTIFY trigger design), §12 (Vercel SSE), §13 (Fargate relay) |
| **ENT-07** | Manual entity edit/merge UI; audit table | §14 (transactional merge); new `entity_merge_audit` table + partial-failure resume |
| **ENT-08** | Per-entity timeline — chronological aggregation | §7, §10 (RSC + virtualization); queries `mention_events + agent_runs` in Phase 3 (MV is Phase 6) |
| **INF-12** | Vercel project with env secrets synced from Secrets Manager | §2 (monorepo), §5 (auth), §16 (env sync) |
</phase_requirements>

---

## Phase Summary

Phase 3 Dashboard MVP is a calm visual surface over the entity graph Phase 2 populates. It is the first TypeScript-UI work in the monorepo: a brand-new `apps/dashboard` workspace (Next.js 15 App Router, Tailwind v4, shadcn/ui, Geist) deployed to Vercel Pro. The hard architectural problems are (1) never giving Vercel a Postgres connection string — Vercel calls an in-VPC `dashboard-api` Lambda Function URL via SigV4; (2) getting Postgres `LISTEN/NOTIFY` events from an RDS instance in a private VPC out to a Vercel SSE Route Handler — which requires the `dashboard-listen-relay` Fargate task plus a public IAM-authed ingress; (3) implementing the `entity_merge` transaction across Notion + RDS with a "Resume?" recovery card on partial failure; and (4) hitting the < 1.5 s Today TTFB budget without skeletons while still layering real-time SSE updates onto RSC-rendered views.

**Primary recommendation:** Build in a strict order that honours the longest unblocking chain — (a) apps/dashboard bootstrap + design tokens + auth, (b) `dashboard-api` Lambda in the VPC + migrations `0007_entity_merge_audit` and `0008_listen_notify_triggers`, (c) Today + Inbox views wired to `dashboard-api` via Server Actions, (d) SSE chain end-to-end (Fargate relay → Vercel Route Handler → EventSource client), (e) entity dossier + merge flow + audit, (f) PWA + Sentry + Vercel Analytics. Every step independently deploys; gate is "Today renders < 1.5 s and SSE reflects a `kos.output` event in ≤ 2 s on the live deployment".

---

## Stack Versions (verified April 2026)

All versions verified via `npm view <pkg> version` on 2026-04-23.

### Dashboard runtime (new workspace `apps/dashboard`)

| Package | Version | Notes | Source |
|---------|---------|-------|--------|
| `next` | **16.2.4** | ⚠️ Next 16 is now latest on npm, but **CONTEXT.md D-13 pins Next 15**. CLAUDE.md also says "Next.js 15.x". **Research recommendation: pin `next@^15.5.0`** (last stable 15.x) — this is a conservative choice; 15 is still actively maintained with security patches, and Next 16 removed some APIs (notably Turbopack-in-dev is default, which breaks Serwist per search above). [VERIFIED: npm view next@15 versions] [CITED: vercel.com/docs/next] | HIGH |
| `react` | 19.2.5 | React 19 stable; `useOptimistic` is the Phase 3 hook. shadcn components already compatible. | HIGH |
| `react-dom` | 19.2.5 | Match React. | HIGH |
| `tailwindcss` | **4.2.4** | Tailwind v4 stable. `@theme` directive; no `tailwind.config.ts` needed for tokens — live in CSS. | HIGH |
| `@tailwindcss/postcss` | 4.2.4 | PostCSS plugin; replaces the old `tailwindcss` plugin usage. | HIGH |
| `shadcn` (CLI) | latest (`npx shadcn@latest init`) | CLI auto-detects Tailwind v4 + React 19 in April 2026. Components pulled individually. | HIGH [CITED: ui.shadcn.com/docs/tailwind-v4] |
| `cmdk` | 1.1.1 | Underlying command palette; shadcn's `command` component wraps it. | HIGH |
| `lucide-react` | 1.8.0 | Default icon set for shadcn. | HIGH |
| `vaul` | 1.1.2 | Drawer primitive (shadcn `drawer` dependency; not required for Phase 3 but install if mockup drawers surface). | HIGH |
| `class-variance-authority` | 0.7.1 | `cva` — shadcn dependency. | HIGH |
| `framer-motion` | 12.38.0 | `AnimatePresence` for fade-in-only insert animations per D-12. | HIGH |
| `react-window` | 2.2.7 | Virtualization for entity timeline; **note v2.x is breaking change vs 1.x** — API is `List` / `Grid`, drop-in simpler. | HIGH |
| `@vercel/analytics` | 2.0.1 | Gate 4 session count source per D-40. | HIGH |
| `@vercel/speed-insights` | 2.0.0 | Optional but cheap — include for Core Web Vitals dashboard. | HIGH |
| `@sentry/nextjs` | 10.49.0 | Error tracking; D-40. | HIGH |
| `zod` | 4.3.6 | Request/response validation at the API boundary. **zod v4 has breaking changes from v3** — confirm drizzle-zod compatibility if used. | HIGH |
| `@serwist/next` | **9.5.7 (stable)** / 10.0.0-preview.14 | Use stable 9.5.7. Preview 10 is for Next 16. | HIGH [CITED: serwist.pages.dev/docs/next] |
| `serwist` | 9.5.7 | Match `@serwist/next`. | HIGH |
| `aws4fetch` | 1.0.20 | Minimal fetch-wrapper SigV4 signer. ~1 KB gzipped. Works on Vercel Node runtime (not needed on Edge — SSE is Node). **Recommended over `@aws-sdk/signature-v4` to avoid pulling ~4 MB of SDK into the Vercel build.** | HIGH |
| `@aws-sdk/credential-providers` | 3.1035.0 | If SigV4 credentials need to come from STS or role assumption. For Phase 3, static keys from env are simpler (D-21) — SDK not needed. | HIGH |
| `date-fns` | 4.1.0 | Date formatting for timeline + calendar + relative-time offline banner. Smaller than moment. | HIGH |
| `ulid` | 3.0.2 | Generate `merge_id` ULIDs client-side in dashboard-api; sortable audit rows per specifics. | HIGH |

### Shared monorepo packages (reused)

| Package | Version | Notes | Source |
|---------|---------|-------|--------|
| `drizzle-orm` | 0.36.0 (currently pinned in `@kos/db`) | Latest is 0.45.2 but phase must match existing `@kos/db` pin. **Do not bump in Phase 3.** | HIGH |
| `pg` | 8.13.1 | Latest 8.20.0; match monorepo pin. Used by `dashboard-api` Lambda and `dashboard-listen-relay` Fargate task. **Edge runtime cannot use `pg` — Node runtime only.** | HIGH |
| `@notionhq/client` | 2.3.0 (monorepo pin) | Used by `dashboard-api` merge path. | HIGH |

### CDK / infra (reused)

| Package | Version | Notes |
|---------|---------|-------|
| `aws-cdk-lib` | current monorepo pin | Add `aws-ecs` construct for `dashboard-listen-relay` task + `aws-apigatewayv2-alpha` if API Gateway HTTP API chosen for Fargate ingress. |
| `@aws-sdk/client-secrets-manager` | 3.691.0 | Monorepo pin — used by `/api/auth/login` route if we opt to read Secrets Manager from Vercel (**do not** — store copy in env at deploy time per D-38). |

### Vercel configuration

- Project linked to `kos-dashboard`, root directory `apps/dashboard`.
- Pro tier — `maxDuration: 300` required for `/api/stream` per D-37.
- Default region `arn1` (Stockholm / eu-north-1 parity).

---

## Project Constraints (from CLAUDE.md)

**Binding directives from the project CLAUDE.md that Phase 3 plans MUST honour:**

1. **Stack table is binding.** Next.js 15, Tailwind v4, shadcn/ui, Drizzle 0.30+, Sentry NextJS 8.x (now bump to 10.x current), grammY v1.38+ for any Telegram wiring.
2. **"What NOT to Use" list is binding.** Specifically for Phase 3:
   - **AppSync / Pusher / Supabase Realtime** → use SSE via LISTEN/NOTIFY (D-22).
   - **Cognito / Clerk** → static Bearer token (D-19).
   - **Prisma** → Drizzle only.
   - **AWS Amplify hosting for Next.js** → Vercel (per "Amplify Gen 2 adds AWS-specific config overhead you don't need for a single-user dashboard").
3. **GSD workflow enforcement.** All file edits start via a GSD command.
4. **ADHD-friendly tone.** One-line success/error copy; no stack traces in UI.
5. **Archive-never-delete.** Merge archives the source Notion page; never deletes (D-28).
6. **Single-user.** `owner_id` column required on every new RDS table.
7. **Bilingual SE/EN.** Data passes through unchanged (D-41).
8. **GDPR-first.** `/api/auth/login` must not leak the bearer token to browser console; httpOnly cookie only (D-19).

---

## Technical Decisions to Lock

Items in CONTEXT.md's "Claude's Discretion" that this research can now resolve. The planner treats these as defaults; deviation must be justified.

| # | Decision | Research verdict |
|---|----------|------------------|
| R-01 | Next.js major version | **Next 15.5.x (latest patch in 15.x line)**. Next 16 moved to Turbopack-by-default in dev, which `@serwist/next` 9.x does not support without `--webpack`. Next 15 avoids this friction. CLAUDE.md + CONTEXT D-13 both pin 15. |
| R-02 | SigV4 signer | **`aws4fetch`** (1 KB, works on Vercel Node runtime) over `@aws-sdk/signature-v4` (pulls ~4 MB of SDK + protocol-http). Both work; aws4fetch is faster cold-start. |
| R-03 | pg LISTEN client in Fargate | **`pg-listen`** (wrapper over `pg`) — adds auto-reconnect + `notification` event dedupe; official recommendation per node-postgres issue #967. Raw `pg.Client.query('LISTEN …')` is known to silently stop after connection timeouts in long-running tasks. |
| R-04 | Fargate relay ingress | **Public ALB with AWS WAF + IAM-authed HTTP API Gateway in front**. Three candidates evaluated; see §13. Lambda-proxy variant (R-04-alt) is planner's call if Fargate feels heavy. |
| R-05 | Notion channel payload | **Single channel `kos_output`** in Phase 3. Splitting per-kind is premature — at Kevin's 1-user volume one channel carries <100 events/day. Revisit if p95 relay-to-browser latency breaches 2 s. |
| R-06 | `partial_merge_state` schema | New column on `entity_merge_audit` (rather than a separate table) — `state` = `initiated` / `notion_copied` / `notion_archived` / `rds_updated` / `complete` / `failed_at_<step>`; resume logic reads this state machine. |
| R-07 | Sentry sample rate | `tracesSampleRate: 1.0` dev, `0.2` prod, `replaysSessionSampleRate: 0.0`, `replaysOnErrorSampleRate: 1.0`. Replays disabled by default (GDPR heuristic — Kevin hasn't opted in). |
| R-08 | Loading placeholder | Reuse existing mockup dot: `<span class="pulse-dot">` — 6×6 box with `--accent` background, `.pulse` keyframes. No library. |
| R-09 | shadcn dialog vs vaul drawer | shadcn `dialog` for desktop-primary (D-27 merge page is its own route, not a modal). `vaul` not needed Phase 3. |
| R-10 | Vercel deployment region | **`arn1`** (Stockholm). Nearest to eu-north-1 RDS / `dashboard-api` Lambda. Vercel has an arn1 edge PoP. |
| R-11 | Timeline pagination | Cursor-based, not offset — cursor = `(occurred_at, id)` tuple. Prevents phantom rows on live insert. |
| R-12 | EventSource reconnection | Native `EventSource` handles reconnect; client adds a 500ms–60s cap via `retry:` SSE comment lines. No library. |

---

## Implementation Approaches

### 1. Monorepo bootstrap for `apps/dashboard`

**Current state.** Repo is pnpm 9.12 workspace with `packages/*` + `services/*` in `pnpm-workspace.yaml`. No `apps/` dir yet. TypeScript strict mode via `tsconfig.base.json` (`ES2022` / `Bundler`). `@kos/db` package exports its schema directly from TS source (`./src/schema.ts` — no build).

**Bootstrap steps:**

1. **Update `pnpm-workspace.yaml`** to add `apps/*`:
   ```yaml
   packages:
     - 'packages/*'
     - 'services/*'
     - 'apps/*'
   ```
2. **Create `apps/dashboard/package.json`** with name `@kos/dashboard`, private, `type: "module"`, matching Node engine (`>=22.12.0`).
3. **Do NOT run `npx create-next-app`** — it writes its own `tsconfig.json`, `package.json`, and ESLint config that conflicts with the monorepo. Instead, hand-author the minimal scaffold:
   - `apps/dashboard/app/layout.tsx`
   - `apps/dashboard/app/page.tsx`
   - `apps/dashboard/next.config.ts`
   - `apps/dashboard/tsconfig.json` that `extends: '../../tsconfig.base.json'` and adds App Router specifics (`jsx: "preserve"`, `plugins: [{ name: "next" }]`, `paths: { "@/*": ["./*"] }`).
4. **Install Next 15 + React 19 + Tailwind v4 via pnpm workspace commands**:
   ```bash
   pnpm --filter @kos/dashboard add next@^15.5.0 react@^19.0.0 react-dom@^19.0.0
   pnpm --filter @kos/dashboard add -D typescript @types/node @types/react @types/react-dom
   pnpm --filter @kos/dashboard add -D tailwindcss@^4 @tailwindcss/postcss postcss
   ```
5. **Workspace-local path alias for `@kos/db`.** `apps/dashboard/package.json` adds `"@kos/db": "workspace:*"` — Next 15 resolves via pnpm symlinks; no extra transpile config needed because `@kos/db` exports raw `.ts`. Next's SWC bundler handles TS source in deps when workspace-local.
   - **Verify with a typecheck run** that `import { entityIndex } from '@kos/db/schema'` works from a Server Action. If SWC chokes on the `.ts` extension, add `transpilePackages: ['@kos/db']` to `next.config.ts`.
6. **Shared contracts.** Create a new `packages/contracts/src/dashboard.ts` exporting the zod schemas for dashboard-api request/response. `dashboard-api` Lambda imports the same file → compile-time guarantee that Vercel and Lambda agree on shapes.
7. **Circular-dep avoidance.** Rule: `apps/dashboard` may import from `packages/*`. `packages/*` must never import from `apps/*`. Linter rule `no-restricted-imports` enforces.

**Source:** [pnpm workspaces docs](https://pnpm.io/workspaces) HIGH. [Next.js 15 monorepo patterns](https://nextjs.org/docs/app/getting-started/installation) HIGH.

### 2. Tailwind v4 `@theme` port from `TFOS-ui.html`

Tailwind v4 replaces `tailwind.config.ts` for design tokens with the `@theme` directive inside CSS. CSS variables declared under `@theme` become both CSS custom properties AND Tailwind utility classes (`bg-surface-1`, `text-text-2`, etc.) with no mapping file.

**`apps/dashboard/src/app/globals.css` skeleton:**

```css
@import "tailwindcss";

/* Port from TFOS-ui.html :root block, 1:1 */
@theme {
  /* Surfaces */
  --color-bg: #0a0c11;
  --color-surface-1: #11141b;
  --color-surface-2: #161a23;
  --color-surface-3: #1c2029;
  --color-surface-hover: #1f2430;

  /* Borders */
  --color-border: #232732;
  --color-border-hover: #2d3340;
  --color-border-strong: #383e4d;

  /* Text */
  --color-text: #e7eaf0;
  --color-text-2: #b1b6c2;
  --color-text-3: #71768a;
  --color-text-4: #4d5263;

  /* Accent — restrained violet */
  --color-accent: #7c5bff;
  --color-accent-2: #9d80ff;

  /* Status (desaturated per mockup) */
  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-danger: #f87171;
  --color-info: #38bdf8;
  --color-pink: #f472b6;

  /* Bolag tints — data-attribute driven at runtime */
  --color-tale-forge: #38bdf8;
  --color-outbehaving: #fb923c;
  --color-personal: #a78bfa;

  /* Motion */
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --transition-fast: 120ms;
  --transition-base: 180ms;
  --transition-slow: 280ms;

  /* Type scale */
  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
  --text-md: 14px;
  --text-lg: 16px;
  --text-xl: 20px;
  --text-2xl: 28px;
  --text-3xl: 36px;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px;

  /* Fonts — names only; actual family injected via next/font */
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

/* Accent with alpha — not a theme token but a utility var */
:root {
  --accent-bg: rgba(124, 91, 255, 0.10);
  --accent-border: rgba(124, 91, 255, 0.25);
}

html, body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.5;
  font-feature-settings: "cv11", "ss01", "ss03";
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.mono { font-family: var(--font-mono); }
::selection { background: var(--accent-bg); color: var(--color-accent-2); }

/* Mockup motion primitive — single pulsing dot replaces all skeletons (D-12) */
@keyframes pulse-dot {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.12); }
}
.pulse-dot {
  width: 6px; height: 6px; border-radius: 999px;
  background: var(--color-accent);
  animation: pulse-dot 1.4s var(--ease) infinite;
}
```

**Font loading via `next/font/google`:**

```tsx
// app/layout.tsx
import { Geist, Geist_Mono } from 'next/font/google';

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

**Why `next/font/google` (not CDN):** zero-layout-shift (fonts are self-hosted at build time), no third-party request from the browser (GDPR-friendlier), prefetched alongside the HTML. Per D-11.

**Gotcha.** Tailwind v4 `@theme` does NOT support JS-style customization (no `plugins: []`, no `extend:`). Any animations beyond what CSS tokens provide must be hand-written CSS keyframes (as shown above for `pulse-dot`). Confidence: HIGH.

**Source:** [tailwindcss.com/docs/theme](https://tailwindcss.com/docs/theme) HIGH; [shadcn Tailwind v4 migration](https://ui.shadcn.com/docs/tailwind-v4) HIGH.

### 3. shadcn/ui + cmdk — component set per view

**Initialization (April 2026 CLI):**

```bash
cd apps/dashboard
npx shadcn@latest init
```

The CLI auto-detects Next 15 + Tailwind v4 + React 19 and writes:
- `components.json` with `"tailwind": { "css": "src/app/globals.css" }` and `"aliases": { "components": "@/components", "ui": "@/components/ui" }`.
- `src/lib/utils.ts` with `cn()` helper.

**Per-view component install map:**

| View | shadcn components (install order) |
|------|-----------------------------------|
| **Layout shell** | `button`, `separator`, `scroll-area`, `tooltip`, `avatar`, `kbd` |
| **Today (UI-01)** | `card`, `badge`, `tabs` — for Top 3 / Drafts / Dropped sections |
| **Per-entity (UI-02)** | `card`, `badge`, `tabs` (timeline/relations/tasks), `dialog` (manual edit) |
| **Inbox (UI-04)** | `card`, `badge`, `button` — two-pane layout custom; shadcn has no "two-pane" primitive |
| **Calendar (UI-03)** | Custom grid; shadcn `popover` for event hover (lucene check) |
| **Command palette (D-10)** | `command` (which pulls `cmdk@1.1.1`) + `dialog` |
| **Merge (`/entities/[id]/merge`)** | `card`, `button`, `separator`, `badge` — two columns of Card |

**Install command (consolidated):**
```bash
npx shadcn@latest add button card dialog command input tabs separator scroll-area toast avatar tooltip kbd badge popover
```

**cmdk usage pattern** (string-contains only per D-10):
```tsx
// src/components/command-palette.tsx
"use client";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function CommandPalette({ entities }: { entities: { id: string; name: string; aliases: string[] }[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0">
        <Command>
          <CommandInput placeholder="Jump to entity, view, or action…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup heading="Views">
              <CommandItem onSelect={() => router.push('/today')}>Today</CommandItem>
              <CommandItem onSelect={() => router.push('/inbox')}>Inbox</CommandItem>
              <CommandItem onSelect={() => router.push('/calendar')}>Calendar</CommandItem>
            </CommandGroup>
            <CommandGroup heading="Entities">
              {entities.map(e => (
                <CommandItem key={e.id} value={`${e.name} ${e.aliases.join(' ')}`} onSelect={() => router.push(`/entities/${e.id}`)}>
                  {e.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
```

**Entity data source for palette:** Phase 3 hydrates `entities` at layout level via an RSC call to `GET /entities/list?fields=id,name,aliases` (new dashboard-api route — lightweight, ≤ 2 KB payload for ~200 entities). Cache for 60 seconds at the client level via a hidden data attribute; SSE events of kind `entity_merge` or `entity_created` invalidate and re-fetch.

**Source:** [shadcn Tailwind v4 docs](https://ui.shadcn.com/docs/tailwind-v4) HIGH; [cmdk docs](https://cmdk.paco.me/) HIGH.

### 4. PWA via `@serwist/next`

**Version note.** Use `@serwist/next@9.5.7` stable with Next 15. The `10.0.0-preview.14` tag is for Next 16; do not use.

**Setup:**

1. **`apps/dashboard/next.config.ts`**:
   ```ts
   import withSerwistInit from '@serwist/next';
   const withSerwist = withSerwistInit({
     swSrc: 'src/app/sw.ts',
     swDest: 'public/sw.js',
     cacheOnNavigation: true,
     reloadOnOnline: true,
     disable: process.env.NODE_ENV === 'development', // don't cache in dev
   });
   export default withSerwist({
     reactStrictMode: true,
     transpilePackages: ['@kos/db', '@kos/contracts'],
     experimental: { /* nothing special needed */ },
   });
   ```

2. **Service worker `src/app/sw.ts`**:
   ```ts
   import { defaultCache } from '@serwist/next/worker';
   import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
   import { Serwist, NetworkFirst, StaleWhileRevalidate } from 'serwist';

   declare global {
     interface WorkerGlobalScope extends SerwistGlobalConfig {
       __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
     }
   }
   declare const self: ServiceWorkerGlobalScope;

   const serwist = new Serwist({
     precacheEntries: self.__SW_MANIFEST,
     skipWaiting: true,
     clientsClaim: true,
     navigationPreload: true,
     runtimeCaching: [
       // Today view HTML — 24h SWR
       {
         matcher: ({ request, url }) =>
           request.mode === 'navigate' && url.pathname === '/today',
         handler: new StaleWhileRevalidate({
           cacheName: 'today-html',
           plugins: [{ cacheWillUpdate: async ({ response }) => (response.status === 200 ? response : null) }],
         }),
       },
       // Today API fetch — 24h SWR with max-age
       {
         matcher: ({ url }) => url.pathname === '/api/today',
         handler: new StaleWhileRevalidate({ cacheName: 'today-api' }),
       },
       // Everything else — Workbox defaults
       ...defaultCache,
     ],
   });
   serwist.addEventListeners();
   ```

3. **Manifest at `apps/dashboard/public/manifest.webmanifest`**:
   ```json
   {
     "name": "Kevin OS",
     "short_name": "KOS",
     "description": "Kevin's personal operating system",
     "start_url": "/today",
     "display": "standalone",
     "background_color": "#0a0c11",
     "theme_color": "#0a0c11",
     "icons": [
       { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
       { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
     ]
   }
   ```
   Linked via `<link rel="manifest" href="/manifest.webmanifest" />` in `layout.tsx`.

4. **Offline banner.** Inside `/today/page.tsx`, detect offline render via a cached SSE-state marker:
   ```tsx
   // Client component banner
   'use client';
   export function OfflineBanner() {
     const [online, setOnline] = useState(navigator.onLine);
     useEffect(() => {
       const on = () => setOnline(true), off = () => setOnline(false);
       window.addEventListener('online', on); window.addEventListener('offline', off);
       return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
     }, []);
     if (online) return null;
     return <div className="offline-banner">Offline · last synced {lastSyncRelative()} · some actions disabled</div>;
   }
   ```
   No "retry" button per specifics.

5. **iOS handling (D-32).** The manifest + service worker are harmless on iOS Safari; user is instructed at `/login` to use "Share → Add to Home Screen" for the shortcut. Do NOT fire `beforeinstallprompt` logic (D-33) — browsers hide it on iOS anyway.

**Source:** [serwist.pages.dev/docs/next/getting-started](https://serwist.pages.dev/docs/next/getting-started) HIGH; [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps) HIGH.

### 5. Bearer cookie auth + middleware

**Route structure:**

```
apps/dashboard/
  src/
    middleware.ts                     # root gate
    app/
      (auth)/
        login/page.tsx                # /login form
      (app)/
        layout.tsx                    # sidebar + command palette
        today/page.tsx                # /today
        inbox/page.tsx                # /inbox
        calendar/page.tsx             # /calendar
        entities/[id]/page.tsx        # /entities/{id}
        entities/[id]/merge/page.tsx  # /entities/{id}/merge
      api/
        auth/
          login/route.ts              # POST token → set cookie
          logout/route.ts             # DELETE cookie
        stream/route.ts               # SSE Node runtime
        today/route.ts                # optional API mirror for SW cache
```

**`middleware.ts`:**

```ts
import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth/login'];
const COOKIE = 'kos_session';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p)) || pathname.startsWith('/_next')
      || pathname.startsWith('/manifest') || pathname.startsWith('/icons')) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE)?.value;
  const expected = process.env.KOS_DASHBOARD_BEARER_TOKEN;

  if (!token || !expected || !constantTimeEqual(token, expected)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('return', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest\\.webmanifest|icons/).*)'],
};
```

**Critical gotcha — Middleware runtime.** Next.js middleware runs on the **Edge runtime**. `crypto.timingSafeEqual` from Node is not available. The `constantTimeEqual` above is pure JS, Edge-safe. Do not import `@aws-sdk/*` or `pg` here.

**`/api/auth/login/route.ts`:**

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'nodejs'; // cookies API works here; Edge also OK but we stay consistent

export async function POST(req: Request) {
  const { token } = await req.json() as { token?: string };
  if (!token || token !== process.env.KOS_DASHBOARD_BEARER_TOKEN) {
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }
  const cookieStore = await cookies();
  cookieStore.set('kos_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 90, // 90 days per D-19
  });
  return NextResponse.json({ ok: true });
}
```

**`/login/page.tsx`** is a client form that POSTs to `/api/auth/login` then `router.push(return ?? '/today')`. Plain shadcn `input` + `button`.

**Confidence: HIGH.** Pattern is standard for Next 15 App Router cookie auth.

### 6. SigV4 signing from Next.js to Lambda Function URL

**Library: `aws4fetch` (1 KB).** Verified via `npm view aws4fetch version` → 1.0.20.

**Server-side fetch wrapper (`src/lib/dashboard-api.ts`):**

```ts
import { AwsClient } from 'aws4fetch';
import type { z } from 'zod';

const client = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID_DASHBOARD!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_DASHBOARD!,
  region: process.env.AWS_REGION ?? 'eu-north-1',
  service: 'lambda',
});

const BASE = process.env.KOS_DASHBOARD_API_URL!; // Lambda Function URL

export async function callApi<T>(path: string, init: RequestInit, schema: z.ZodSchema<T>): Promise<T> {
  const res = await client.fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`dashboard-api ${path} → ${res.status}: ${await res.text()}`);
  return schema.parse(await res.json());
}
```

**Usage from a Server Component:**

```ts
// app/(app)/today/page.tsx
import { callApi } from '@/lib/dashboard-api';
import { TodayResponseSchema } from '@kos/contracts/dashboard';

export default async function TodayPage() {
  const data = await callApi('/today', { method: 'GET' }, TodayResponseSchema);
  return <TodayView data={data} />;
}
```

**Why not `@aws-sdk/signature-v4`.** It works, but it pulls ~4 MB of SDK + `@aws-sdk/protocol-http` + `@aws-crypto/sha256-js` into the Vercel bundle. Cold-start on a cold Vercel Node function matters for the < 1.5 s TTFB budget. `aws4fetch` is one file, pure Web Crypto API, no dependencies.

**Credential handling.** Static IAM user `kos-dashboard-caller` with policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunctionUrl",
    "Resource": "arn:aws:lambda:eu-north-1:<account>:function:dashboard-api",
    "Condition": { "StringEquals": { "lambda:FunctionUrlAuthType": "AWS_IAM" } }
  }]
}
```
Access keys rotated via the `scripts/sync-vercel-env.ts` helper per D-38.

**Cold-start impact.** aws4fetch adds ~3 ms to initial invocation on Vercel Node. Acceptable inside 1.5 s budget.

**Source:** [aws4fetch npm](https://www.npmjs.com/package/aws4fetch) HIGH; [aws-sigv4-fetch article](https://johanneskonings.dev/blog/2024-12-28-api-gw-sigv4-different-api-clients/) MEDIUM (different lib, same concept).

### 7. In-VPC `dashboard-api` Lambda design

**Construct reuse.** Build on `packages/cdk/lib/constructs/kos-lambda.ts` (KosLambda — Node 22 ARM64, ESM, externalized `@aws-sdk/*`). Place in private VPC subnets (D-17 says "existing pattern as Phase 1 `notion-indexer`"). This requires the **Secrets Manager VPC interface endpoint to be re-added** per Phase 1 retro (code_context of CONTEXT.md) — call this out in the plan.

**Route shape: single Lambda with path-based routing.**

Separate Lambdas per route would multiply cold-starts and IAM wiring. One Lambda with an internal mini-router is cheaper and simpler for the phase surface (≤ 10 routes).

```ts
// services/dashboard-api/src/index.ts
import type { LambdaFunctionURLHandler } from 'aws-lambda';
import { z } from 'zod';
import { route } from './router.js';
import { getDb } from './db.js'; // Drizzle + RDS Proxy, module-level cache

export const handler: LambdaFunctionURLHandler = async (event) => {
  const db = await getDb(); // lazy-init, pool 1-5 via RDS Proxy
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  try {
    return await route(method, path, event, db);
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'internal' }) };
  }
};
```

**Routing table:**

| Method | Path | Handler | Body schema | Auth |
|--------|------|---------|-------------|------|
| `GET`  | `/today` | `handlers/today.get` | — | SigV4 |
| `GET`  | `/entities/list` | `handlers/entities.list` | — | SigV4 |
| `GET`  | `/entities/:id` | `handlers/entities.get` | — | SigV4 |
| `GET`  | `/entities/:id/timeline?cursor=…` | `handlers/timeline.get` | — | SigV4 |
| `GET`  | `/inbox` | `handlers/inbox.get` | — | SigV4 |
| `POST` | `/inbox/:id/approve` | `handlers/inbox.approve` | `{ edits?: InboxEdits }` | SigV4 |
| `POST` | `/inbox/:id/edit` | `handlers/inbox.edit` | `{ fields: Partial<InboxFields> }` | SigV4 |
| `POST` | `/inbox/:id/skip` | `handlers/inbox.skip` | — | SigV4 |
| `POST` | `/entities/:id/merge` | `handlers/merge.execute` | `{ target_id, diff, merge_id }` | SigV4 |
| `POST` | `/entities/:id/merge/resume` | `handlers/merge.resume` | `{ merge_id }` | SigV4 |
| `POST` | `/capture` | `handlers/capture.post` | `{ text?, audio_s3?: string }` | SigV4 |

**RDS Proxy connection pattern.**

```ts
// services/dashboard-api/src/db.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

let pool: Pool | null = null;

export async function getDb() {
  if (pool) return drizzle(pool);
  const signer = new Signer({
    hostname: process.env.RDS_PROXY_ENDPOINT!,
    port: 5432,
    username: 'dashboard_api',
    region: process.env.AWS_REGION,
  });
  pool = new Pool({
    host: process.env.RDS_PROXY_ENDPOINT,
    port: 5432,
    user: 'dashboard_api',
    database: 'kos',
    ssl: { rejectUnauthorized: true },
    max: 5, // Lambda concurrency × this × 1.2 must stay under RDS Proxy target-conns limit
    password: async () => signer.getAuthToken(),
  });
  return drizzle(pool);
}
```

**Module-level cache is correct here** — one pool per warm Lambda instance. RDS IAM auth tokens are valid 15 minutes; the Signer regenerates on each new connection open (which Pool does as needed). No manual token rotation.

**zod at boundary.**

```ts
// packages/contracts/src/dashboard.ts (NEW)
import { z } from 'zod';

export const TodayResponseSchema = z.object({
  brief: z.object({ body: z.string(), generated_at: z.string().datetime() }).nullable(),
  priorities: z.array(z.object({ id: z.string(), title: z.string(), bolag: z.enum(['tale-forge','outbehaving','personal']).nullable() })),
  drafts: z.array(z.object({ id: z.string(), entity: z.string(), preview: z.string() })),
  dropped: z.array(z.object({ id: z.string(), entity: z.string(), age_days: z.number() })),
});
export type TodayResponse = z.infer<typeof TodayResponseSchema>;

export const InboxApproveSchema = z.object({ edits: z.record(z.string(), z.unknown()).optional() });
// …etc
```

Imported by BOTH `@kos/dashboard` (Vercel) and `services/dashboard-api` (Lambda) — single source of truth.

**IAM permission shape.** `dashboard-api` execution role needs:
- `rds-db:connect` on the `dashboard_api` db user (IAM auth).
- `secretsmanager:GetSecretValue` on `kos/notion-token` (for merge Notion writes).
- `events:PutEvents` on `kos.output` bus (if any handler publishes events — e.g., merge completion → triggers NOTIFY chain).
- ENI network permissions (auto from VPC config).

**Function URL config:**
- `authType: AWS_IAM`.
- `invokeMode: BUFFERED` (RESPONSE_STREAM not needed — payloads are <1 MB).
- Resource policy: allow principal = the `kos-dashboard-caller` IAM user.
- CORS: allow origin `https://kos-dashboard-kevin-elzarka.vercel.app` (and any future custom domain). Methods `GET, POST`. Headers `content-type, authorization`.

**Confidence: HIGH.**

### 8. Server Actions + `useOptimistic` on Inbox

**Inbox UI pattern** (two-pane per mockup §Inbox, J/K keyboard nav):

```tsx
// app/(app)/inbox/page.tsx
import { getInbox } from '@/lib/dashboard-api';
import { InboxClient } from './inbox-client';
export default async function InboxPage() {
  const items = await getInbox();
  return <InboxClient initialItems={items} />;
}
```

```tsx
// app/(app)/inbox/inbox-client.tsx
'use client';
import { useOptimistic, useState, useTransition, useEffect } from 'react';
import { approveInbox, skipInbox, editInbox } from './actions';

export function InboxClient({ initialItems }: { initialItems: InboxItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [optimistic, addOptimistic] = useOptimistic(items, (cur, action: { id: string; kind: 'approve'|'skip'|'edit' }) =>
    cur.filter(i => i.id !== action.id)
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'j') setSelectedIdx(i => Math.min(i + 1, optimistic.length - 1));
      else if (e.key === 'k') setSelectedIdx(i => Math.max(i - 1, 0));
      else if (e.key === 'Enter') startTransition(() => {
        const id = optimistic[selectedIdx]?.id; if (!id) return;
        addOptimistic({ id, kind: 'approve' });
        approveInbox(id);
      });
      else if (e.key === 's') startTransition(() => {
        const id = optimistic[selectedIdx]?.id; if (!id) return;
        addOptimistic({ id, kind: 'skip' });
        skipInbox(id);
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [optimistic, selectedIdx]);

  return (/* two-pane render */);
}
```

```ts
// app/(app)/inbox/actions.ts
'use server';
import { callApi } from '@/lib/dashboard-api';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

export async function approveInbox(id: string) {
  await callApi(`/inbox/${id}/approve`, { method: 'POST' }, z.object({ ok: z.literal(true) }));
  revalidatePath('/inbox');
}
```

**Rationale.** `useOptimistic` removes the approved row instantly; `revalidatePath` re-fetches the server component on success. On failure, `useOptimistic` auto-reverts when the transition rejects. Exactly the "calm" UX: action → row dissolves → next item already selected.

### 9. Today view data composition

**Queries composed by `GET /today` in dashboard-api:**

1. **Morning brief** — read Notion 🏠 Today page, extract the "Brief" block. If not present (pre-Phase-7), return `brief: null` → UI renders stub copy.
2. **Top 3 priorities** — query Notion Command Center DB filtered `Prio = 1/2/3` and `Status != Done`, sorted by manual order, limit 3. Call Notion API from Lambda (not from RDS — Command Center not indexed yet).
3. **Drafts to review** — RDS query on KOS Inbox Notion DB (mirrored in `entity_index`? No — Inbox is a separate DB). **Gap:** Phase 2 created the KOS Inbox Notion DB (D-13 Phase 2) but there is no `inbox_index` RDS table yet. The planner must decide: (a) `dashboard-api` reads Notion API directly (simpler, 300–800 ms), or (b) add a new `inbox_index` table to Drizzle schema + add `kos_inbox` to notion-indexer watched DBs. **Recommendation: option (b)** — matches Phase 1 pattern and enables offline cache. Migration `0009_inbox_index.sql` required.
4. **Dropped threads** — derived query on `mention_events`: entities with `last_touch > 7 days ago` AND `status = 'active'`. Hydrate name + bolag from `entity_index`.
5. **Voice/text dump zone** — UI render only; submit goes to `POST /capture` → publishes to `kos.capture` EventBridge bus with a fresh `capture_id` ULID (reuses Phase 2 pipeline).

**Budget: < 1.5 s TTFB + LCP.** Composition does Notion (Command Center) + RDS (dropped threads) + Notion (brief) + RDS or Notion (drafts) in parallel via `Promise.all`. Expected p50: 400 ms; p95: 900 ms. Budget met.

**Caching.** Today API response carries `Cache-Control: private, max-age=0, stale-while-revalidate=86400` so the service worker honours the 24h SWR rule from D-31.

### 10. Per-entity page data composition + react-window

**Query shape for timeline (`GET /entities/:id/timeline?cursor=…`):**

```sql
-- Pseudocode; Drizzle-ORM composed
SELECT
  me.id, me.source, me.context, me.occurred_at, me.capture_id, 'mention' AS kind
FROM mention_events me
WHERE me.owner_id = $1 AND me.entity_id = $2 AND (me.occurred_at, me.id) < ($cursor_ts, $cursor_id)
UNION ALL
SELECT
  ar.id::text, ar.agent_name AS source, ar.output_json->>'summary' AS context, ar.started_at AS occurred_at, ar.capture_id, 'agent_run' AS kind
FROM agent_runs ar
WHERE ar.owner_id = $1 AND (ar.output_json->>'entity_id')::uuid = $2
ORDER BY occurred_at DESC, id DESC
LIMIT 50;
```

**Index required** (migration `0010_entity_timeline_indexes.sql`):
- Existing `mention_events_by_entity_time` handles the mention side.
- Add `agent_runs_by_entity_jsonb` — a GIN or a `CREATE INDEX … (((output_json->>'entity_id'))::uuid, started_at DESC)` expression index.

**Cursor format:** `${occurred_at_iso}:${id}` base64-encoded. Prevents phantom rows on live insert.

**Live 10-min overlay.** Phase 6 MEM-04 introduces a materialized view refreshed every 5 min. Phase 3 does not have the MV — it queries live tables directly. Add a code comment:
```ts
// TODO(phase-6): replace with `entity_timeline_mv` + live UNION from the last 10 min once MEM-04 ships.
```

**"What you need to know" AI block.** Per CONTEXT D-02 Phase 3 deferred items, Gemini 2.5 Pro auto-context loader lands in Phase 6 (AGT-04). Phase 3 MUST NOT invoke an LLM. **Recommendation:** render a cached last-known summary from `entity_index.seed_context` + the 3 most recent `mention_events` contexts, with a label "Based on last known summary · Full AI context coming soon". Avoids a live Gemini call and the cost ($0.03+) per view.

**react-window v2 pattern:**

```tsx
'use client';
import { List, type RowComponentProps } from 'react-window';
import { useRef, useEffect, useState } from 'react';

type Row = TimelineRow; // shared type

function TimelineRow({ index, style, data }: RowComponentProps<Row[]>) {
  const item = data[index];
  return <div style={style} className="timeline-row">…</div>;
}

export function Timeline({ initial, entityId }: { initial: Row[]; entityId: string }) {
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState<string | null>(initial.at(-1) ? `${initial.at(-1)!.occurred_at}:${initial.at(-1)!.id}` : null);

  const loadMore = async () => {
    if (!cursor) return;
    const res = await fetch(`/api/proxy/entities/${entityId}/timeline?cursor=${encodeURIComponent(cursor)}`);
    const more: Row[] = await res.json();
    setRows(r => [...r, ...more]);
    setCursor(more.at(-1) ? `${more.at(-1)!.occurred_at}:${more.at(-1)!.id}` : null);
  };

  return (
    <List
      rowCount={rows.length}
      rowHeight={72}
      rowComponent={TimelineRow}
      rowProps={rows}
      onRowsRendered={({ stopIndex }) => {
        if (stopIndex >= rows.length - 10) loadMore();
      }}
    />
  );
}
```

**Initial 50 rows SSR'd** (dashboard-api returns first 50); client hydrates with `initial=[…]` and paginates with cursor. Motion: fade-in only on insert via framer-motion `AnimatePresence` — **but only on new rows arriving via SSE**, not on scroll-pagination loads (which should feel instant, not animated).

**Source:** [react-window v2 docs](https://github.com/bvaughn/react-window) HIGH.

### 11. Postgres LISTEN/NOTIFY wiring

**Triggers (migration `0008_listen_notify_triggers.sql`):**

```sql
-- Fires on every inbox_item insert (via indexer when KOS Inbox Notion DB syncs)
CREATE OR REPLACE FUNCTION notify_kos_output() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('kos_output', json_build_object(
    'kind', TG_ARGV[0],
    'id', NEW.id::text,
    'entity_id', CASE WHEN TG_ARGV[0] = 'timeline_event' THEN NEW.entity_id::text ELSE NULL END,
    'ts', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- inbox_index: new row = new inbox item
CREATE TRIGGER trg_inbox_notify
  AFTER INSERT ON inbox_index
  FOR EACH ROW EXECUTE FUNCTION notify_kos_output('inbox_item');

-- entity_merge_audit: state=complete → entity_merge event
CREATE TRIGGER trg_entity_merge_notify
  AFTER UPDATE OF state ON entity_merge_audit
  FOR EACH ROW WHEN (NEW.state = 'complete')
  EXECUTE FUNCTION notify_kos_output('entity_merge');

-- mention_events: new row = timeline event (used by entity dossier)
CREATE TRIGGER trg_mention_notify
  AFTER INSERT ON mention_events
  FOR EACH ROW EXECUTE FUNCTION notify_kos_output('timeline_event');

-- agent_runs: completion of certain kinds = draft_ready / capture_ack
CREATE TRIGGER trg_agent_run_notify
  AFTER INSERT ON agent_runs
  FOR EACH ROW WHEN (NEW.status = 'ok' AND NEW.agent_name IN ('voice-capture','email-triage-draft'))
  EXECUTE FUNCTION notify_kos_output(CASE WHEN NEW.agent_name = 'voice-capture' THEN 'capture_ack' ELSE 'draft_ready' END);
```

**⚠️ Trigger above uses `TG_ARGV[0]`** which is a static value per trigger definition — the CASE-in-EXECUTE is not valid PL/pgSQL in the same form. Use **four separate functions** or compute kind inside the function from `TG_TABLE_NAME` / `NEW.agent_name`. Planner: resolve during SQL authoring.

**Alternative kept simple** — also publish `kos.output` EventBridge from `dashboard-notify` Lambda which then calls `NOTIFY` directly via `pg.Client`. Per D-22, the pipeline IS `kos.output` → `dashboard-notify` Lambda → `NOTIFY`. So the **triggers above are optional** — they exist as a belt-and-suspenders for events that originate in RDS without going through EventBridge (e.g. indexer inserts). Planner decides whether to keep both paths.

**`dashboard-notify` Lambda (in-VPC):**

```ts
// services/dashboard-notify/src/index.ts
import type { EventBridgeHandler } from 'aws-lambda';
import { getDb } from './db.js'; // same pattern as dashboard-api

export const handler: EventBridgeHandler<string, any, void> = async (event) => {
  const db = await getDb();
  const payload = {
    kind: event['detail-type'],     // e.g. 'inbox_item'
    id: event.detail.id,
    entity_id: event.detail.entity_id ?? null,
    ts: new Date().toISOString(),
  };
  const json = JSON.stringify(payload);
  if (json.length > 7000) throw new Error(`NOTIFY payload ${json.length}B > 8000B cap`);
  await db.execute(`SELECT pg_notify('kos_output', $1)`, [json]);
};
```

**8 KB cap mitigation.** `id` + `entity_id` are UUID strings (36 chars each). `kind` < 32 chars. `ts` is 24 chars. Payload stays well under 1 KB. The contract in D-25 (pointer-only) is correct — do not add full rows.

**EventBridge rule in `events-stack.ts`** (new):
```ts
new Rule(this, 'ToDashboardNotify', {
  eventBus: buses.output,
  eventPattern: { detailType: ['inbox_item','entity_merge','capture_ack','draft_ready','timeline_event'] },
  targets: [new LambdaFunction(dashboardNotifyLambda)],
});
```

**Source:** [PostgreSQL LISTEN/NOTIFY docs](https://www.postgresql.org/docs/16/sql-listen.html) HIGH; [brandur.org/notifier](https://brandur.org/notifier) HIGH.

### 12. Vercel SSE Route Handler

**File:** `apps/dashboard/src/app/api/stream/route.ts`

```ts
export const runtime = 'nodejs';          // required for fetch-to-Fargate + long execution
export const maxDuration = 300;            // Vercel Pro cap; D-23
export const dynamic = 'force-dynamic';    // no caching of SSE response

import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const abort = req.signal;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // initial comment keeps some proxies happy
      controller.enqueue(encoder.encode(`: connected\n\n`));
      controller.enqueue(encoder.encode(`retry: 500\n\n`));

      // heartbeat every 15s — through Vercel's buffer AND any intermediate proxy
      const hb = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { clearInterval(hb); }
      }, 15_000);

      try {
        // Long-poll the Fargate relay. cursor = highest event id we've seen this connection.
        let cursor = req.nextUrl.searchParams.get('cursor') ?? '0';
        while (!abort.aborted) {
          const res = await fetchRelay(`/events?cursor=${encodeURIComponent(cursor)}&wait=25`);
          // relay holds up to 25s if no events; long-poll pattern
          if (abort.aborted) break;
          const batch: Array<{ id: string; kind: string; entity_id?: string; ts: string }> = await res.json();
          for (const ev of batch) {
            controller.enqueue(encoder.encode(`event: ${ev.kind}\nid: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`));
            cursor = ev.id;
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`));
      } finally {
        clearInterval(hb);
        controller.close();
      }
    },
    cancel() { /* abort handled via req.signal */ },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

async function fetchRelay(path: string): Promise<Response> {
  // SigV4 against API Gateway HTTP API in front of Fargate (§13)
  // Implementation via aws4fetch + service='execute-api'
  return client.fetch(`${process.env.KOS_RELAY_URL}${path}`, { method: 'GET' });
}
```

**Key details:**
- `'x-accel-buffering': 'no'` is critical — prevents Vercel's intermediate buffers from withholding bytes until the response closes.
- Heartbeat (`: hb\n\n`) every 15s ensures intermediate proxies keep the connection open.
- `retry: 500` tells `EventSource` to reconnect after 500 ms on disconnect. Browser ramps up via its own exponential backoff if server keeps closing.
- `maxDuration: 300` caps at 5 min; client reconnect is invisible for single-user.

**Client-side EventSource (one hook):**

```ts
// src/hooks/use-sse.ts
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function useSSE(onEvent: (ev: { kind: string; id: string; entity_id?: string; ts: string }) => void) {
  const router = useRouter();
  useEffect(() => {
    const es = new EventSource('/api/stream');
    const handler = (e: MessageEvent) => onEvent(JSON.parse(e.data));
    for (const k of ['inbox_item','entity_merge','capture_ack','draft_ready','timeline_event']) {
      es.addEventListener(k, handler as EventListener);
    }
    es.addEventListener('error', () => { /* auto-reconnects via browser */ });
    return () => es.close();
  }, [onEvent, router]);
}
```

In each view component, call `useSSE` with a revalidator tied to the event kind:
- `kind: 'inbox_item'` → `router.refresh()` on `/inbox`.
- `kind: 'timeline_event' && entity_id === currentId` → refetch the timeline's first page.
- `kind: 'entity_merge'` → refresh any affected entity page + invalidate command palette entity list.

**Source:** [Vercel streaming functions docs](https://vercel.com/docs/functions/streaming-functions) HIGH; [Next.js SSE discussion #83373](https://github.com/vercel/next.js/discussions/83373) MEDIUM.

### 13. `dashboard-listen-relay` Fargate + public ingress (MOST UNCERTAIN)

The core problem: RDS is VPC-private. Vercel must receive `NOTIFY` events. The relay's long-poll endpoint needs a public, IAM-authed ingress. Three viable architectures evaluated:

**Option A (recommended): API Gateway HTTP API with IAM authorizer in front of Fargate via VPC Link**

```
Vercel /api/stream
    │ SigV4 (service=execute-api)
    ▼
API Gateway HTTP API (public, IAM authorizer)
    │ VPC Link (private)
    ▼
Network Load Balancer (internal, private subnets)
    │
    ▼
Fargate task (0.25 vCPU / 0.5 GB)
  ├─ Fastify HTTP server on :8080
  ├─ pg-listen client: LISTEN kos_output
  └─ in-memory event buffer (ring, last 256 events)
```

- **Pros:** Native IAM auth. Private Fargate (no public IP). Free tier for HTTP API generous. VPC Link + NLB is standard pattern.
- **Cons:** VPC Link charge ~$10/month. NLB charge ~$16/month. Total added ~$26/month on top of the Fargate $5. **~$31/month total** — still cheap.
- **Per-request latency:** +30 ms through API Gateway + VPC Link.

**Option B: Function URL on a wrapper Lambda that polls Fargate internally**

```
Vercel /api/stream
    │ SigV4 (service=lambda)
    ▼
Lambda Function URL (public, AWS_IAM)
    │ (in-VPC, calls internal Fargate)
    ▼
Fargate long-poll task (as Option A, but NLB is internal, no VPC Link)
```

- **Pros:** No VPC Link. No NLB. Reuses the same SigV4 library (`service=lambda`) as `dashboard-api`. Cheapest (~$10/month total).
- **Cons:** Adds a Lambda hop per long-poll. Cold starts matter — but the relay wrapper Lambda stays warm with Kevin's single user.
- **Per-request latency:** +50 ms through Lambda (warm).

**Option C (deferred per CONTEXT): Upstash Redis pub/sub**

```
dashboard-notify Lambda publishes to Upstash Redis pub/sub
Vercel /api/stream subscribes via Upstash serverless REST
```

- **Pros:** No Fargate. No relay. ~$0/month on Upstash free tier.
- **Cons:** Third-party dependency in data path (CLAUDE.md "What NOT to Use" list ethos says no). Not matching STATE.md locked decision #7 (LISTEN/NOTIFY).
- **Verdict:** Explicitly deferred per CONTEXT.md §Deferred Ideas. Document as future swap if Fargate operational weight becomes too much.

**Recommendation: Option A (HTTP API + VPC Link + NLB + Fargate).** Matches existing AWS patterns in the repo, keeps Fargate private, and gives us a clean path to add the `dashboard-api` Function URL behind the same HTTP API later if we want unified IAM. The planner may pick Option B if they want to minimize moving parts; both are architecturally sound.

**Fargate task spec:**

| Property | Value |
|----------|-------|
| Image | `services/dashboard-listen-relay` (Dockerfile in service, Fastify + pg-listen) |
| CPU | 0.25 vCPU (256) |
| Memory | 0.5 GB (512) |
| Arch | ARM64 |
| Desired count | **1** (LISTEN is per-connection — multiple tasks would each hold a separate Postgres connection and each receive every event — OK semantically, but wasteful) |
| Health check | HTTP `GET /healthz` returns 200 if Postgres LISTEN connection is healthy (`pg-listen` exposes a `.events.connected` flag) |
| Autoscaling | Off (single instance; restart on failure via ECS service desiredCount) |
| IAM task role | `rds-db:connect` on `dashboard_relay` user; SSM `GetParameter` for endpoint config |
| VPC | Same as RDS; private subnet |
| Network mode | `awsvpc` |
| Logs | CloudWatch `/ecs/dashboard-listen-relay` 30-day retention |

**Fargate service code outline:**

```ts
// services/dashboard-listen-relay/src/index.ts
import Fastify from 'fastify';
import createSubscriber from 'pg-listen';
import { Signer } from '@aws-sdk/rds-signer';

const app = Fastify();
const buffer: Array<{ id: string; kind: string; entity_id?: string; ts: string }> = [];
const MAX = 256;

const signer = new Signer({ hostname: process.env.RDS_PROXY_ENDPOINT!, port: 5432, username: 'dashboard_relay', region: process.env.AWS_REGION! });

async function mkClient() {
  const subscriber = createSubscriber({
    host: process.env.RDS_PROXY_ENDPOINT,
    port: 5432,
    user: 'dashboard_relay',
    database: 'kos',
    ssl: { rejectUnauthorized: true },
    password: await signer.getAuthToken(),
  });
  subscriber.notifications.on('kos_output', (payload) => {
    const ev = typeof payload === 'string' ? JSON.parse(payload) : payload;
    buffer.push(ev); while (buffer.length > MAX) buffer.shift();
  });
  subscriber.events.on('error', (err) => { console.error(err); process.exit(1); /* ECS restarts */ });
  subscriber.events.on('connected', () => console.log('LISTEN connected'));
  await subscriber.connect(); await subscriber.listenTo('kos_output');
  return subscriber;
}

app.get('/healthz', async () => ({ ok: true, buffered: buffer.length }));

app.get('/events', async (req, reply) => {
  const cursor = (req.query as any).cursor ?? '0';
  const wait = Math.min(Number((req.query as any).wait ?? '25'), 25);
  // pluck events with id > cursor
  const pluck = () => buffer.filter(e => e.id > cursor);
  let batch = pluck();
  if (batch.length) return batch;
  // long-poll up to `wait` seconds
  await new Promise(r => setTimeout(r, wait * 1000));
  return pluck();
});

await mkClient();
app.listen({ host: '0.0.0.0', port: 8080 });
```

**⚠️ Gotchas:**
- RDS Proxy IAM auth tokens expire after 15 min. `pg-listen` reconnect logic handles this — on token expiry the connection errors, subscriber reconnects, new token is fetched. `pg-listen`'s `password` option accepts an async function; use that form for continuous refresh.
- The buffer is in-memory — if Fargate restarts, events are lost. That's acceptable: SSE clients reconnect and get the next live event; missed events are recovered by full-query refresh (`router.refresh()`) on next navigation or manual reload.

**Source:** [pg-listen npm](https://www.npmjs.com/package/pg-listen) HIGH; [oneuptime blog on LISTEN/NOTIFY](https://oneuptime.com/blog/post/2026-01-25-use-listen-notify-real-time-postgresql/view) MEDIUM.

### 14. Transactional entity merge (ENT-07)

**New tables (migration `0007_entity_merge_audit.sql`):**

```sql
CREATE TABLE entity_merge_audit (
  merge_id TEXT PRIMARY KEY,                             -- ULID, sortable
  owner_id UUID NOT NULL DEFAULT '7a6b5c4d-...'::uuid,
  source_entity_id UUID NOT NULL REFERENCES entity_index(id),
  target_entity_id UUID NOT NULL REFERENCES entity_index(id),
  initiated_by TEXT NOT NULL DEFAULT 'kevin',            -- 'kevin' | 'agent:entity-resolver' | etc.
  state TEXT NOT NULL,                                   -- state machine values below
  diff JSONB NOT NULL,                                   -- field-level diff recorded at initiation
  error_message TEXT,
  notion_archived_at TIMESTAMPTZ,
  rds_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX entity_merge_audit_by_state ON entity_merge_audit(state, created_at DESC);
CREATE INDEX entity_merge_audit_by_source ON entity_merge_audit(source_entity_id);
```

**State machine values (R-06):**
`initiated` → `notion_relations_copied` → `notion_archived` → `rds_updated` → `complete`
At any step: `failed_at_<step>` terminal state.

**Merge execution in `dashboard-api` `POST /entities/:target_id/merge`:**

```ts
// services/dashboard-api/src/handlers/merge.ts
import { ulid } from 'ulid';

export async function executeMerge(db: DB, notion: Client, source: string, target: string, diff: object) {
  const merge_id = ulid();
  await db.insert(entityMergeAudit).values({
    merge_id, source_entity_id: source, target_entity_id: target,
    state: 'initiated', diff,
  });

  try {
    // Step 1: copy Notion relations to canonical page
    const sourcePage = await notion.pages.retrieve({ page_id: sourceNotionId(source) });
    await copyRelations(notion, sourcePage, targetNotionId(target));
    await db.update(entityMergeAudit).set({ state: 'notion_relations_copied' }).where(eq(entityMergeAudit.merge_id, merge_id));

    // Step 2: archive source Notion page
    await notion.pages.update({ page_id: sourceNotionId(source), archived: true });
    await db.update(entityMergeAudit).set({ state: 'notion_archived', notion_archived_at: new Date() }).where(eq(entityMergeAudit.merge_id, merge_id));

    // Step 3: RDS txn — rewrite FK refs + flip source entity status
    await db.transaction(async (tx) => {
      await tx.update(mentionEvents).set({ entity_id: target }).where(eq(mentionEvents.entity_id, source));
      await tx.update(entityIndex).set({ status: 'merged_into', /* keep row for audit */ }).where(eq(entityIndex.id, source));
    });
    await db.update(entityMergeAudit).set({ state: 'rds_updated', rds_updated_at: new Date() }).where(eq(entityMergeAudit.merge_id, merge_id));

    // Step 4: write agent_runs audit + mark complete
    await db.insert(agentRuns).values({
      agent_name: 'entity_merge_manual', status: 'ok', capture_id: null,
      output_json: { source_id: source, target_id: target, merge_id, initiated_by: 'kevin' },
    });
    await db.update(entityMergeAudit).set({ state: 'complete', completed_at: new Date() }).where(eq(entityMergeAudit.merge_id, merge_id));

    // Publish kos.output event so SSE pushes the completion to the open tab
    await publishOutput('entity_merge', { merge_id, entity_id: target });

    return { ok: true, merge_id };
  } catch (err: any) {
    const lastState = (await db.select().from(entityMergeAudit).where(eq(entityMergeAudit.merge_id, merge_id)).limit(1))[0]?.state;
    await db.update(entityMergeAudit).set({ state: `failed_at_${lastState}`, error_message: String(err) }).where(eq(entityMergeAudit.merge_id, merge_id));
    // Surface a "Resume?" Inbox card
    await insertInboxResumeCard(db, merge_id);
    return { ok: false, merge_id, resumable: true };
  }
}
```

**Idempotency on Resume.** The resume handler reads the last known `state` and picks up from there:
- If `notion_relations_copied` → skip step 1, try step 2.
- If `notion_archived` → skip steps 1 & 2, try step 3.
- Notion `archive` is idempotent (re-archiving an archived page is a no-op). Copying relations requires a dedup check on the target page (read existing relations, only add missing). **The planner must decide the dedup key** — likely `source_entity_notion_id` as a property on the copied relation, so re-copy is detectable.

**Notion API rate limits.** 3 requests/second. Merge does ~3–5 requests depending on relation count. At 1 merge/day this is fine. On bulk migrations add 400 ms inter-request sleep.

**Resume UI.** The "Resume?" Inbox card is a plain row in the Inbox DB with `Type = 'merge_resume'`, `merge_id` referenced, and shadcn `button` actions `Resume` / `Revert` / `Cancel`. `Revert` calls a separate handler that reverses whatever was committed (un-archive Notion page; flip back `entityIndex.status`). `Cancel` just marks audit row `cancelled` and leaves partial state.

**Confidence: MEDIUM-HIGH** — Notion two-phase commit with a local audit log is a well-known pattern; the fiddly parts are the dedup keys on relation copy.

### 15. Validation Architecture (Nyquist D-8)

#### Test Framework

| Property | Value |
|----------|-------|
| **Unit framework** | Vitest 2.1.4 (monorepo pin) — per package |
| **E2E framework** | **Playwright 1.47+** (new for Phase 3) — against a deployed preview URL |
| **Component framework** | Vitest + React Testing Library + jsdom — for `apps/dashboard/**/*.test.tsx` |
| **Config files** | `apps/dashboard/vitest.config.ts`, `apps/dashboard/playwright.config.ts` (both new) |
| **Quick run** | `pnpm --filter @kos/dashboard test` |
| **Full suite** | `pnpm -r test && pnpm --filter @kos/dashboard playwright` |
| **Phase gate** | All green + Lighthouse Performance score ≥ 90 on Today view |

#### Phase Requirements → Test Map

| Req | Behavior | Test Type | Automated Command | Exists? |
|-----|----------|-----------|-------------------|---------|
| UI-01 | Today renders Top 3 + Drafts + Dropped | Playwright E2E | `playwright test today.spec.ts` | ❌ Wave 0 |
| UI-01 | Today TTFB + LCP < 1.5 s | Lighthouse CI | `lhci autorun --url=https://.../today` | ❌ Wave 0 |
| UI-02 | Entity page renders dossier + timeline with 50 SSR'd rows | Playwright E2E | `playwright test entity.spec.ts` | ❌ Wave 0 |
| UI-02 | Timeline virtualization — scroll past row 50 triggers paginated fetch | Playwright E2E (mock API) | `playwright test timeline.spec.ts` | ❌ Wave 0 |
| UI-02 | Interactive in < 500 ms | Lighthouse CI | `lhci autorun --url=https://.../entities/<id>` | ❌ Wave 0 |
| UI-03 | Calendar renders Command Center deadline events | Playwright E2E | `playwright test calendar.spec.ts` | ❌ Wave 0 |
| UI-04 | Inbox J/K navigation + Enter=approve + S=skip | Playwright E2E (keyboard) | `playwright test inbox-keyboard.spec.ts` | ❌ Wave 0 |
| UI-04 | Approve row removes it optimistically; failure re-inserts | Vitest + RTL | `vitest run inbox-client.test.tsx` | ❌ Wave 0 |
| UI-05 | PWA installable (manifest + SW registration) | Playwright (headed Chromium) | `playwright test pwa-install.spec.ts` | ❌ Wave 0 |
| UI-05 | Offline reload serves cached Today | Playwright (setOffline) | `playwright test pwa-offline.spec.ts` | ❌ Wave 0 |
| UI-06 | SSE reconnect after 5-min disconnect (maxDuration) | Playwright + mock relay | `playwright test sse-reconnect.spec.ts` | ❌ Wave 0 |
| UI-06 | `NOTIFY` → EventSource receives event in < 2s | Integration test against deployed | `vitest run sse-integration.test.ts` | ❌ Wave 0 |
| ENT-07 | Merge happy path writes audit row with ULID | Vitest + Drizzle test DB | `vitest run merge.test.ts` | ❌ Wave 0 |
| ENT-07 | Partial failure writes `failed_at_notion_archived` + Inbox Resume card | Vitest + mocked Notion | `vitest run merge-partial.test.ts` | ❌ Wave 0 |
| ENT-07 | Resume from `notion_archived` skips step 2 | Vitest | `vitest run merge-resume.test.ts` | ❌ Wave 0 |
| ENT-08 | Timeline query returns mention + agent_run union by entity | Vitest + Drizzle | `vitest run timeline.test.ts` | ❌ Wave 0 |
| INF-12 | Auth middleware: missing cookie → 302 to /login | Playwright | `playwright test auth.spec.ts` | ❌ Wave 0 |
| INF-12 | Valid cookie → access granted; invalid → 302 | Playwright | `playwright test auth.spec.ts` | ❌ Wave 0 |

#### Sampling Rate

- **Per task commit:** `pnpm --filter @kos/dashboard test` (Vitest unit + component, <10 s)
- **Per wave merge:** Full Playwright suite against Vercel preview URL (~3–5 min)
- **Phase gate:** Full suite green + Lighthouse CI scores ≥ 90 perf, ≥ 95 a11y on Today + entity pages
- **Post-deploy smoke:** Curl `/today` from CI; assert 200 + cookie redirect behavior

#### Wave 0 Gaps

- [ ] `apps/dashboard/vitest.config.ts` — component test config with jsdom
- [ ] `apps/dashboard/playwright.config.ts` — E2E config with Vercel preview URL + auth cookie fixture
- [ ] `apps/dashboard/tests/e2e/auth.spec.ts` — auth smoke tests
- [ ] `apps/dashboard/tests/e2e/today.spec.ts` — Today render
- [ ] `apps/dashboard/tests/e2e/entity.spec.ts`
- [ ] `apps/dashboard/tests/e2e/timeline.spec.ts`
- [ ] `apps/dashboard/tests/e2e/calendar.spec.ts`
- [ ] `apps/dashboard/tests/e2e/inbox-keyboard.spec.ts`
- [ ] `apps/dashboard/tests/e2e/pwa-install.spec.ts`
- [ ] `apps/dashboard/tests/e2e/pwa-offline.spec.ts`
- [ ] `apps/dashboard/tests/e2e/sse-reconnect.spec.ts`
- [ ] `services/dashboard-api/test/merge.test.ts` — merge happy path
- [ ] `services/dashboard-api/test/merge-partial.test.ts` — partial failure
- [ ] `services/dashboard-api/test/merge-resume.test.ts` — resume logic
- [ ] `services/dashboard-api/test/timeline.test.ts` — query shape
- [ ] `services/dashboard-listen-relay/test/relay.test.ts` — long-poll behavior with mocked subscriber
- [ ] `apps/dashboard/tests/integration/sse.test.ts` — end-to-end NOTIFY → EventSource
- [ ] Lighthouse CI config `.lighthouserc.json`
- [ ] Framework installs:
  - `pnpm --filter @kos/dashboard add -D @playwright/test` + `npx playwright install chromium`
  - `pnpm --filter @kos/dashboard add -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom`
  - `pnpm add -D -w @lhci/cli` (root)

### 16. Security Domain

#### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token in httpOnly cookie (D-19); 90-day expiry; SameSite=Lax; Secure flag. Validation is constant-time string equality. |
| V3 Session Management | yes | Cookie-as-session. No server-side session store. Logout = cookie delete. Token rotation = regenerate in Secrets Manager + redeploy (D-21 rotation process). |
| V4 Access Control | yes | Single-user: every RDS query carries `where owner_id = $1`. Middleware gates every `(app)/*` route. `dashboard-api` IAM policy restricts Function URL invocation to one IAM user. |
| V5 Input Validation | yes | zod at every `dashboard-api` route boundary. Client-side forms also zod-validate (shared schema from `@kos/contracts`). Notion API payloads constructed server-side only. |
| V6 Cryptography | yes | Rely on `aws4fetch`'s Web Crypto API SigV4 — do not roll. TLS via Vercel + AWS. Cookie uses `Secure` flag. Passwords N/A (no user table). |
| V7 Error Handling | yes | `@sentry/nextjs` captures exceptions; stack traces never surfaced to user (per ADHD constraint). 500 responses return `{ error: 'internal' }` only. |
| V12 Files | n/a | No file upload in Phase 3 (voice capture composer posts S3 presigned URL; covered Phase 2). |
| V14 Configuration | yes | Env vars sourced from AWS Secrets Manager via `scripts/sync-vercel-env.ts`. No secrets in git. Vercel env vars marked "Encrypted" for access keys. |

#### Known Threat Patterns for Phase 3

| Threat | STRIDE | Mitigation |
|--------|--------|-----------|
| Bearer token leaked via console.log / error boundary | Information disclosure | httpOnly cookie; token never rendered in React tree; Sentry scrubber on `cookie` and `authorization` headers. |
| CSRF against Server Actions / `/api/auth/login` | Tampering | SameSite=Lax cookie blocks cross-site POST. Next.js Server Actions include a built-in origin check. |
| XSS via Notion content (user-generated) | Tampering | React escapes by default. Never use `dangerouslySetInnerHTML` with Notion content. If rich text needed, use a sanitizer (`dompurify`) — **flag for planner** if a view needs it. |
| SSE endpoint DoS (hold open all slots) | DoS | Vercel Pro concurrent function limit is generous (~1000). Single-user risk is minimal. Rate-limit at CloudFront if it ever matters. |
| SigV4 access-key leakage in Vercel build logs | Information disclosure | Vercel env vars are not logged by default. Confirm `NEXT_PUBLIC_` prefix is NEVER used for AWS keys (would expose to client bundle). |
| Replay attack on `/entities/:id/merge` | Tampering | `merge_id` ULID as idempotency key: duplicate calls with same `merge_id` short-circuit on the initial INSERT (unique constraint). |
| Privilege escalation via `owner_id` bypass | Elevation | Every SQL query has explicit `where owner_id = $1` literal — enforce via Drizzle query helper `ownerScoped(q)` that adds the predicate. Code review checklist item. |
| Cache poisoning of `/today` via SW | Tampering | SW runs in browser only; no cross-user contamination (single-user). Cache version bumped on every deploy via Serwist manifest hash. |
| EventSource endpoint leaks pointer-only data → attacker could enumerate IDs | Information disclosure | Middleware gate on `/api/stream` requires cookie auth. Payload contains only ULIDs (no PII). |
| Fargate relay ingress abused to enumerate events | Information disclosure | API Gateway HTTP API IAM authorizer = only the `kos-dashboard-caller` IAM user can invoke. |

#### STRIDE Summary

- **S (spoofing):** Cookie + IAM double-gate.
- **T (tampering):** zod + SigV4 + SameSite.
- **R (repudiation):** `agent_runs` + `entity_merge_audit` durable log.
- **I (info disclosure):** httpOnly + Sentry scrubbing + pointer-only SSE.
- **D (DoS):** Low risk single-user; Vercel + API Gateway handle at edge.
- **E (elevation):** `owner_id` scoping + IAM least-privilege.

### 17. Phase-Specific Pitfalls

> These are live traps the planner must wire into verification steps. Each maps to a Phase 3 verification gate.

**P-01: Vercel Edge runtime cannot import `pg` or `@kos/db`**
- **What:** Middleware and Edge-runtime Route Handlers run in a V8 isolate with no Node APIs. `pg`, `drizzle-orm/node-postgres`, `@aws-sdk/rds-signer` all fail at build.
- **Mitigation:** Every Route Handler that touches the database or AWS SDK MUST declare `export const runtime = 'nodejs';`. Middleware stays pure JS (token compare only). **Wave 0 check:** add a lint rule that flags `import ... from '@kos/db'` in any file under `middleware.ts` or any file with `export const runtime = 'edge'`.

**P-02: Next.js middleware + auth cookie vs service worker**
- **What:** Service worker caches a response that was fetched with a valid cookie. Later the cookie expires. The SW still serves the cached response, so the user sees stale authenticated content before `/api/*` calls return 401.
- **Mitigation:** SW only caches `/today` HTML + `/api/today` JSON (per D-31). Both need to gracefully degrade on 401 — the HTML is pre-rendered by `/today/page.tsx` which checks auth in middleware. If middleware redirects to `/login`, SW never caches the redirect (301/302 are not cached by the runtimeCaching rules above). Explicit cache `plugins: [{ cacheWillUpdate: ({ response }) => response.status === 200 ? response : null }]`.

**P-03: RSC streaming + SSE on the same page**
- **What:** React Server Components stream HTML to the client. A client component on the same page opens an EventSource. A developer might confuse "RSC streaming" with "SSE" and try to use `use()` inside an RSC to block on an SSE.
- **Mitigation:** Clear separation: RSC for initial load (`await callApi('/today', ...)`), client component + `useSSE` hook for updates. Never try to `await` an EventSource in an RSC. The client component receives RSC-computed data via props; its only job is to re-fetch on SSE events.

**P-04: Secrets Manager VPC interface endpoint missing**
- **What:** `dashboard-api` Lambda runs in private VPC subnets. It reads `kos/notion-token` from Secrets Manager. Without a Secrets Manager interface endpoint, the read fails (no route to AWS services).
- **Mitigation:** Re-add the interface endpoint in `DashboardStack` (was torn down post-Phase-1 bastion teardown per CONTEXT.md code_context). Cost: ~$7.30/month per endpoint × one AZ. Or, pass the Notion token as a Lambda environment variable populated at deploy-time from Secrets Manager — cheaper (no endpoint), acceptable for a single token that rotates rarely.
- **Recommendation:** Environment variable approach (cheaper, simpler, no network dependency). Add `@aws-cdk/aws-secretsmanager.Secret.valueFromVersion()` in the CDK to inject the token at deploy time.

**P-05: `owner_id` filter missed in at least one dashboard-api query**
- **What:** The forward-compat multi-user convention fails if any query omits `owner_id`. Once added to a different user, cross-user leakage.
- **Mitigation:** Build a `ownerScoped()` wrapper in `services/dashboard-api/src/db.ts` that every handler imports instead of using Drizzle raw. Code review checklist. Vitest can enforce with a snapshot test on generated SQL.

**P-06: Notion API 3 req/s rate limit during merge**
- **What:** Merge does relation-copy + archive = 3–5 Notion API calls in quick succession. Bulk merge (multi-entity later) would exceed 3/s.
- **Mitigation:** Serialize merge steps (already natural in the state machine). Add 400 ms inter-request sleep in the merge handler. For Phase 3 single-entity pairwise merges this is irrelevant; document for future multi-merge work.

**P-07: Tailwind v4 `@theme` doesn't support JS plugins**
- **What:** v3 muscle-memory reaches for `tailwind.config.ts` `plugins: []`. v4 removed JS config; everything is CSS.
- **Mitigation:** Keep `tailwind.config.ts` minimal (optional; v4 works without it). Custom utilities (`.pulse-dot`, `.offline-banner`) are plain CSS in `globals.css`. No plugin library.

**P-08: Vercel SSE gets buffered through proxies**
- **What:** Missing `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` headers cause some intermediaries (particularly behind corporate proxies) to buffer the full response.
- **Mitigation:** All three headers set explicitly in the Route Handler Response. 15s heartbeat forces flush.

**P-09: `export const maxDuration = 300` only works on Vercel Pro and only on specific runtimes**
- **What:** Hobby tier caps at 10 s. Edge runtime caps at 30s regardless of tier. Node runtime on Pro → 300s cap.
- **Mitigation:** D-37 locks Pro. `/api/stream/route.ts` declares `runtime = 'nodejs'`. Verify via `vercel env ls` during deploy smoke.

**P-10: Playwright E2E against Vercel preview — auth cookie**
- **What:** E2E tests need a valid `kos_session` cookie to reach `(app)` routes. Hard-coding the token in CI leaks it.
- **Mitigation:** Use a separate `KOS_TEST_BEARER_TOKEN` Secrets Manager entry; Playwright `global-setup.ts` POSTs to `/api/auth/login` and persists `storageState` for all tests. Token stored as a GitHub Actions secret.

**P-11: React Server Component data fetched on Vercel Node runtime with a VPC-private Lambda**
- **What:** RSC executes on Vercel's serverless Node runtime. Calls to `dashboard-api` go over the public internet (via SigV4 on the Function URL). Latency from Vercel Stockholm → AWS eu-north-1 is ~5–15 ms. Fine. But a cold Vercel function + cold Lambda = 400ms+ before first byte.
- **Mitigation:** Function URL + Vercel both cold-start. Keep Vercel function warm via Vercel "Fluid Compute" (GA 2025; on by default on Pro). Keep Lambda warm via EventBridge Scheduler every 5 min (cheap). ≤ 1.5 s TTFB budget still achievable.

**P-12: `node-postgres` LISTEN silently stops**
- **What:** Raw `pg.Client.query('LISTEN foo')` has a known issue where the `notification` event stops firing after transient network issues without emitting an `error`. Issue #967 still open.
- **Mitigation:** Use `pg-listen` (R-03). It adds heartbeats and auto-reconnect. Verified with Playwright integration test `sse-reconnect.spec.ts`.

**P-13: `react-window` v2 API breaking change from v1**
- **What:** v1 used `FixedSizeList` with `itemCount`/`itemSize` props. v2 uses `List` with `rowCount`/`rowHeight` and a `rowComponent` prop. Blog posts and AI-generated code still assume v1.
- **Mitigation:** Pin `react-window@^2.2.0` in `apps/dashboard/package.json`. Tests cover the row-render contract. Team / planner notice in plans.

**P-14: Next.js 16 Turbopack-default breaks Serwist**
- **What:** Next 16 switched dev to Turbopack by default; `@serwist/next@9` only supports webpack-in-dev per Serwist docs.
- **Mitigation:** Pin Next 15.5.x (R-01). If forced to Next 16 later, run dev with `next dev --webpack`.

**P-15: `useOptimistic` before shadcn `toast`**
- **What:** Optimistic row removal feels great; failure path needs to re-insert AND surface the error. Without a toast, the error is invisible and the row stays removed.
- **Mitigation:** `useOptimistic` auto-reverts on transition reject. Wrap Server Action call in `try/catch` and call `toast.error("Couldn't approve — try again.")` on failure. shadcn toast is in the initial install set per D-09.

**P-16: Circular dep between `apps/dashboard` and a would-be `packages/ui`**
- **What:** Early instinct to extract shadcn components into `packages/ui`. shadcn's whole premise is "components live in your app, not a library." Creating `packages/ui` would require re-exporting + re-building on every update.
- **Mitigation:** shadcn components live in `apps/dashboard/src/components/ui/*`. `packages/contracts` for shared zod schemas only. No shared UI package.

---

## Runtime State Inventory

> Phase 3 is additive, not a rename. No existing data needs migration.

| Category | Items | Action |
|----------|-------|--------|
| Stored data | None renamed | — |
| Live service config | n8n/EmailEngine/Baileys untouched | — |
| OS-registered state | None | — |
| Secrets/env vars | **New:** `kos/dashboard-bearer-token` (Secrets Manager) + mirror in Vercel env as `KOS_DASHBOARD_BEARER_TOKEN`. **New:** `kos/sentry-dsn`. **New:** access keys `AWS_ACCESS_KEY_ID_DASHBOARD` / `AWS_SECRET_ACCESS_KEY_DASHBOARD`. | Create placeholders in Phase 3 plan; Kevin populates before deploy. |
| Build artifacts / installed packages | `apps/dashboard/node_modules`, new Drizzle migration files `0007..0010`, new CDK stack `DashboardStack` | New, not migration. |

---

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build + Lambda + Fargate | ✓ | 22.12+ | — |
| pnpm | Monorepo | ✓ | 9.12.0 | — |
| Docker | Fargate image build | ✓ (per Phase 1 CDK) | — | — |
| AWS CDK | Infra | ✓ | monorepo pin | — |
| Vercel CLI | Dashboard deploy | needs install | `vercel@latest` | Web UI deploy |
| Playwright | E2E | needs install | 1.47+ | — |
| `lhci` Lighthouse CI | Perf gate | needs install | `@lhci/cli@latest` | Manual Lighthouse |

**Missing, with action:** Vercel CLI (install via `pnpm add -Dw vercel`), Playwright (install per §15), Lighthouse CI.

---

## Assumptions Log

All critical stack decisions are VERIFIED or CITED. Remaining ASSUMED items for planner/discuss review:

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | Next.js 15.5.x is a stable, maintained branch receiving security patches | Stack versions / R-01 | Low — if 15.x EOL earlier than expected, plan upgrade to 16 with `--webpack` dev workaround |
| A2 | `@serwist/next@9.5.7` still works with Next 15 in April 2026 | §4 | Medium — if regressed, fall back to `next-pwa` (unmaintained but functional) |
| A3 | `aws4fetch` works unchanged on Vercel Node runtime (not Edge) | §6 | Low — swap to `@aws-sdk/signature-v4` (heavier, but proven) |
| A4 | Vercel Fluid Compute keeps Node functions warm enough for < 1.5 s TTFB | §12, P-11 | Medium — if cold-start latency hits budget, add EventBridge Scheduler ping every 5 min to the `/today` endpoint |
| A5 | RDS Proxy + IAM auth + `pg-listen` survives 15-min token expiry via reconnect | §13, R-03 | Medium — if reconnect misses, events during the gap are lost; acceptable given single-user tolerance but flag for integration test |
| A6 | Notion `pages.update({ archived: true })` is idempotent | §14 | Low — if not, add state-machine check before archive |
| A7 | API Gateway HTTP API IAM authorizer + VPC Link + NLB works for long-poll (25 s) — some LB timeouts default to 30–60s which is OK, but confirm | §13 Option A | Medium — if LB drops connection at 30s, reduce long-poll wait to 20s |
| A8 | Vercel Pro `maxDuration: 300` applies to `/api/stream` Node runtime | §12, P-09 | High if wrong (SSE breaks); verify with smoke test post-deploy |
| A9 | `entity_index.seed_context` has enough content to render a meaningful "What you need to know" stub in Phase 3 | §10 | Low — if empty, render "No summary yet. Full AI context coming in Phase 6." |
| A10 | Phase 2 Inbox DB will need an `inbox_index` mirror in RDS for Phase 3 offline caching | §9 | Medium — planner must decide in Phase 3 plan whether to add the mirror or read Notion directly |

**All other claims** in this research are either VERIFIED against npm/official docs or CITED from authoritative sources.

---

## Open Questions (for planner to resolve)

1. **Fargate relay ingress architecture — Option A (HTTP API + VPC Link + NLB) vs Option B (Lambda Function URL wrapper).** Both work. Option A costs ~$31/month, Option B ~$10/month. Recommendation: Option B for MVP cost sensibility; migrate to A if relay traffic grows or a multi-service ingress is needed. **This is the planner's decision.**

2. **Inbox RDS mirror vs Notion-direct.** A1 in Assumptions — add `inbox_index` table to Drizzle schema or have `dashboard-api` read Notion directly? Recommendation: mirror (enables offline cache + consistent pattern).

3. **Secrets Manager VPC interface endpoint vs env-var injection at deploy.** P-04 recommendation: env-var at deploy. Planner confirms.

4. **`/today` RSC vs `/api/today` Route Handler.** Service worker needs a JSON endpoint to cache (D-31). Either the RSC page AND a mirror `/api/today` Route Handler, OR call `/api/today` from the RSC. Recommendation: dedicated `/api/today` Route Handler, RSC calls it directly (zero duplication).

5. **react-window v2 vs v1 — does the team have v1 familiarity worth preserving?** Recommendation: v2 (simpler API, smaller bundle).

6. **Sentry error sample rate + replay policy.** R-07 default proposed; planner ratifies.

---

## Sources

### HIGH confidence (verified + cited)

- [Vercel docs — Configuring maximum duration](https://vercel.com/docs/functions/configuring-functions/duration) — Pro 300s limit
- [Vercel docs — Streaming functions](https://vercel.com/docs/functions/streaming-functions) — SSE + Node runtime pattern
- [Next.js 15 App Router docs](https://nextjs.org/docs/app) — Route Handlers, Middleware, Server Actions
- [shadcn/ui Tailwind v4 migration](https://ui.shadcn.com/docs/tailwind-v4) — `@theme` compatibility
- [Tailwind CSS v4 docs — `@theme`](https://tailwindcss.com/docs/theme) — directive syntax
- [cmdk docs](https://cmdk.paco.me/) — command palette API
- [Serwist getting started](https://serwist.pages.dev/docs/next/getting-started) — App Router setup
- [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps) — manifest conventions
- [PostgreSQL LISTEN/NOTIFY docs](https://www.postgresql.org/docs/16/sql-listen.html) — 8 KB payload cap
- [pg-listen npm](https://www.npmjs.com/package/pg-listen) — reconnect semantics
- [node-postgres issue #967](https://github.com/brianc/node-postgres/issues/967) — silent LISTEN stall
- [aws4fetch npm](https://www.npmjs.com/package/aws4fetch) — SigV4 minimal wrapper
- [AWS docs — HTTP API IAM authorization](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-access-control-iam.html) — auth mode
- [Sentry Next.js docs](https://docs.sentry.io/platforms/javascript/guides/nextjs/) — setup
- `npm view` 2026-04-23 for every version pin above

### MEDIUM confidence

- [brandur.org — The Notifier Pattern](https://brandur.org/notifier) — LISTEN/NOTIFY production design
- [johanneskonings.dev — SigV4 HTTP clients](https://johanneskonings.dev/blog/2024-12-28-api-gw-sigv4-different-api-clients/) — aws4fetch vs SDK comparison
- [oneuptime.com — Real-Time LISTEN/NOTIFY](https://oneuptime.com/blog/post/2026-01-25-use-listen-notify-real-time-postgresql/view) — 2026 patterns
- [Aurora blog — @serwist/next](https://aurorascharff.no/posts/dynamically-generating-pwa-app-icons-nextjs-16-serwist/) — Serwist + Next 16 caveats
- [AWS blog — API Gateway + Fargate](https://aws.amazon.com/blogs/containers/building-http-api-based-services-using-aws-fargate/) — VPC Link pattern

### LOW confidence (unverified, flagged)

- None critical. Assumption log items A4, A5, A7, A8 should be verified in-situ during Wave 0 / first deploy smoke.

---

## Metadata

**Confidence breakdown:**
- Standard stack / versions: HIGH — verified against npm registry 2026-04-23
- Auth + middleware + SigV4: HIGH — standard patterns, well-documented
- PWA + Serwist: HIGH — official docs, pinned stable version
- Entity merge transactional design: MEDIUM-HIGH — Notion two-phase commit is well-trodden; Notion-specific rate limit + idempotency details need plan-time confirmation
- SSE + LISTEN/NOTIFY + Fargate relay: MEDIUM — pattern is sound; exact ingress (Option A vs B) is the planner's call; A7 verification during deploy
- Performance budgets: MEDIUM — < 1.5s TTFB is achievable but depends on Vercel Fluid Compute warmth + Lambda cold-start behaviour; Wave 0 Lighthouse runs validate

**Research date:** 2026-04-23
**Valid until:** 2026-05-23 (30 days — Next.js minor versions and Vercel feature changes are the main watch items)
