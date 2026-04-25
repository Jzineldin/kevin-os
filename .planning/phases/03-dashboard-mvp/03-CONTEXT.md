# Phase 3: Dashboard MVP - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning
**Mode:** `--auto` — all gray areas resolved to recommended defaults, logged in DISCUSSION-LOG.md

<domain>
## Phase Boundary

Kevin opens a deployed Next.js 15 dashboard at a Vercel URL, authenticates once with a Bearer token (stored as an httpOnly cookie thereafter), and lands on a calm desktop-primary UI with four views wired to the live entity graph populated in Phase 2:

- **Today** — the AI morning brief (Phase 7 placeholder until AUTO-01 ships), Top 3 priorities from Command Center, Drafts-to-review queue from KOS Inbox, Dropped threads, voice/text dump zone.
- **Per-entity dossier** — Person + Project layouts with "What you need to know" AI block (cached), chronological timeline from `mention_events`/`agent_runs`/Notion, linked tasks + projects + documents, side rail with computed stats.
- **Inbox** — two-pane Superhuman-style approval queue with J/K keyboard nav, Approve/Edit/Skip on drafts + ambiguous entity routings + new-entity confirmations, driven by the Phase 2 "KOS Inbox" Notion DB.
- **Calendar** — Command Center `Deadline` field events only (Google Calendar integration is Phase 8), bolag-coloured, click-through to entity dossiers.

**Real-time behaviour:** an event published on the `kos.output` EventBridge bus triggers a Postgres `NOTIFY`; the dashboard's SSE Route Handler is `LISTEN`-ing and pushes the event to the open tab; the relevant card re-renders within 2 seconds. Telegram remains the sole mobile push channel (UI-06 locked).

**Entity merge (ENT-07):** Kevin can select duplicates in the dashboard, preview the merge, confirm, and the system archives (never deletes) the source entity, copies all relations to the canonical entity, writes an audit row to `agent_runs`, and on partial failure surfaces a "Resume?" card in the Inbox keyed to the `merge_id`.

**PWA:** installs on Android home screen + desktop Chrome/Edge (UI-05); iOS is a Safari Add-to-Home-Screen shortcut (not a standalone PWA — EU DMA locked this in). Offline mode renders the last-loaded Today view from a 24-hour service-worker cache.

**In scope:**
- Next.js 15 App Router monorepo app at `apps/dashboard`
- Design system ported from `TFOS-ui.html` (canonical visual spec — 7 designed views + tokens + motion rules)
- Four core views above + global command palette (press `K`)
- Bearer-token auth with cookie session + `/login` route + middleware gate
- SSE stream via Vercel Node function → Postgres LISTEN/NOTIFY
- PWA manifest + service worker with 24h Today-view offline cache
- VPC-private Lambda Function URL API layer so Vercel never touches RDS directly
- Sentry (NextJS SDK) wired from day one; Langfuse already covers agents
- Vercel Pro tier ($20/mo) — SSE `maxDuration: 300`

**Out of scope (explicitly deferred):**
- Capture chat view (requires streaming triage backend; lands alongside Phase 4 iOS Shortcut or as a Phase 3.5 add-on)
- Google Calendar integration (Phase 8 per roadmap)
- Web Push desktop notifications (lower priority than Telegram; add post Phase 3 if Kevin requests)
- Morning-brief generation itself (Phase 7 AUTO-01 — dashboard renders whatever Phase 7 writes, placeholder until then)
- Voice/text dump zone wired to the capture pipeline (UI renders the composer; pipeline wiring to `kos.capture` bus lives in Phase 3 but the voice path reuses Phase 2 Telegram infra)

</domain>

<decisions>
## Implementation Decisions

### View scope & information architecture

- **D-01:** Views shipped in Phase 3 = **Today, Per-entity (Person + Project variants share one template), Inbox, Calendar, global Command Palette**. Why: the first four map 1:1 to UI-01/02/03/04; the command palette is already fully designed in `TFOS-ui.html` §Command palette, is low-implementation-cost (cmdk + entity search), and meaningfully amplifies Inbox + per-entity navigation. [auto] Selected default over "four views only".
- **D-02:** Capture chat view (mockup §Capture) is **deferred** to Phase 3.5 / Phase 4. Why: it requires a streaming triage backend and duplicates Telegram's capture surface — building it now front-loads Phase 4 concerns and risks Phase 3 slipping. Listed in deferred ideas so the mockup stays a reference.
- **D-03:** Per-entity page in Phase 3 renders **Person + Project** variants. Company + Document variants are deferred (no live data volume yet; same template shape — trivial later).
- **D-04:** Calendar view data source in Phase 3 = **Command Center `Deadline` + `Idag` filtered rows only**. Google Calendar merging is Phase 8 (CAP-09). Mockup's calendar layout stands; the data source layer is swap-compatible.
- **D-05:** Today view "Morning brief" region renders whatever Phase 7 AUTO-01 writes to the 🏠 Today Notion page. Until Phase 7 ships the brief is a stub ("Brief generated daily at 07:00 — ships with Phase 7"). The view contract (bilingual prose block + timestamp + source ref) is defined now so Phase 7 has a visual target.
- **D-06:** Every entity link in every view routes to `/entities/[id]`. URL shape is stable across all views; command palette deep-links use the same URL.

### Visual system & component library

- **D-07:** Canonical design spec for Phase 3 = **`TFOS-ui.html` (committed to repo root)**. Tokens, surface levels, accent usage, motion principles, typography scale, and the explicit "what this UI deliberately avoids" list are binding. Downstream planning agents read this file directly. Note: despite the `TFOS-` prefix, the HTML internally titles itself "Kevin OS · UI/UX" — treat as the KOS dashboard spec.
- **D-08:** CSS tokens ported to **Tailwind CSS v4 `@theme` directive** in `apps/dashboard/src/app/globals.css`, matching `TFOS-ui.html` `:root` variables 1:1 (colours, radii, durations, type scale, eases). No Tailwind theme rewrite — tokens stay as CSS variables so the mockup HTML can be pasted side-by-side for visual parity during development.
- **D-09:** Component primitives = **shadcn/ui (Radix + Tailwind)**. Tokens overridden to match `TFOS-ui.html`. Initial install set: `button, card, dialog, command, input, tabs, separator, scroll-area, toast, avatar, tooltip, kbd`. Added on demand thereafter.
- **D-10:** Command palette = **`cmdk`** (what shadcn wraps). Keyboard: `⌘K` / `Ctrl+K` opens, `↑/↓` navigate, `Enter` selects, `Esc` closes. Root data = entity_index rows + view routes + common actions (approve selected, merge, logout). Natural-language queries deferred (per mockup description) — Phase 3 does string-contains matching only; NL routing is Phase 6+ (needs agent-context loader).
- **D-11:** Fonts = **Geist + Geist Mono via `next/font/google`**, not CDN, per `TFOS-ui.html` font stack. Mono used for IDs, timestamps, and one-off tags (`capture_id`, keyboard shortcut hints, bolag tags as mockup does).
- **D-12:** Motion principles (mockup §Design system card) are binding. No skeleton loaders, no spinners — a single 6×6 pulsing dot per mockup §Motion item. Load budget targets mean this is rarely seen anyway.

### App shell & routing

- **D-13:** Next.js 15 **App Router only**. No Pages Router. Route groups: `(auth)` for `/login`, `(app)` for all authenticated routes with shared sidebar layout. Sidebar nav per mockup: Today · Inbox · Calendar · Chat (disabled in Phase 3) · Entities (type filters) · Command palette shortcut.
- **D-14:** Initial loads use **React Server Components** reading via Drizzle against the in-VPC API layer (see D-19). Interactive updates use client components with SSE subscription + React 19 `useOptimistic` for approve/skip on Inbox. No SWR / React Query in Phase 3 — RSC + native fetch + SSE covers it.
- **D-15:** Server Actions are used for every mutating interaction (Approve, Edit, Skip, Merge, confirm-entity). Action handlers call the in-VPC API layer (not Notion directly) — the API layer writes Notion, returns the new state, the server action re-renders. Keeps Notion-first source-of-truth (STATE.md locked decision #2).

### Database access from Vercel

- **D-16:** Vercel does **not connect to RDS directly**. A new in-VPC Lambda (`dashboard-api`) with a Lambda Function URL (AWS_IAM auth) exposes the read/write surface the dashboard needs. Vercel calls it with SigV4-signed requests using a dashboard-only IAM user whose credentials are in Vercel env vars (synced from AWS Secrets Manager).
- **D-17:** `dashboard-api` is a Node 22 Lambda inside the VPC, uses the existing RDS Proxy + RDS IAM auth (same pattern as Phase 1 `notion-indexer`). Routes: `GET /today`, `GET /entities/:id`, `GET /inbox`, `POST /inbox/:id/approve|edit|skip`, `POST /entities/:id/merge`, `POST /capture`, `GET /stream` (no — stream handled separately; see D-25). Request/response schemas validated with zod on both sides.
- **D-18:** Dashboard reads never bypass the API layer — Vercel has no `pg` connection string in env. This keeps RDS in the private VPC forever and gives us one place to rate-limit, observe, and authorize.

### Authentication

- **D-19:** Auth flow: `/login` page takes a Bearer token (typed or pasted), POSTs to `/api/auth/login` Next.js Route Handler, which validates the submitted token against `kos/dashboard-bearer-token` in Secrets Manager (loaded at build time into Vercel env) and sets an httpOnly + Secure + SameSite=Lax cookie `kos_session` with 90-day expiry. Single user, no user table needed.
- **D-20:** `middleware.ts` at the root protects every route outside `(auth)`. Missing/invalid cookie → 302 to `/login?return=...`. Cookie carries the token verbatim; its presence is the only authorization check. No JWT, no session store — the Bearer token IS the session per STATE.md locked decision #8.
- **D-21:** IAM credentials for calling the `dashboard-api` Function URL live in Vercel env vars (`AWS_ACCESS_KEY_ID_DASHBOARD`, `AWS_SECRET_ACCESS_KEY_DASHBOARD`), scoped to `lambda:InvokeFunctionUrl` on only that Function URL. Rotation = re-generate access key in AWS, update Vercel env, redeploy.

### Real-time (SSE + LISTEN/NOTIFY)

- **D-22:** Real-time pipeline honours STATE.md locked decision #7:  
  `kos.output` EventBridge bus → EventBridge rule → `dashboard-notify` Lambda → Postgres `NOTIFY kos_output, jsonb_payload` → SSE Route Handler held open with `LISTEN kos_output` → push to browser → client re-renders the relevant card.
- **D-23:** SSE endpoint lives at `/api/stream` in the `apps/dashboard` Next.js app, **Node runtime, `export const maxDuration = 300;`**. Holds a single Postgres connection (via the in-VPC API layer proxying LISTEN — see D-24). Every 300s the stream closes; the client auto-reconnects with 500ms → 60s exponential backoff. For single-user steady use, the 5-minute reconnect is invisible.
- **D-24:** LISTEN connection indirection: the SSE Route Handler **cannot** hold a direct LISTEN on RDS (VPC-private). Instead, a `dashboard-listen-relay` Fargate task (tiny, 0.25 vCPU / 0.5 GB, single instance, in the existing `kos-cluster`) holds the Postgres LISTEN continuously and exposes a long-polling HTTP endpoint (`GET /events?cursor=...`) protected by IAM auth. The SSE Route Handler on Vercel long-polls this endpoint and streams each event as `data: {json}\n\n`. Cost: ~$5/month. Alternative evaluated (Upstash pub/sub) is recorded in deferred ideas for swap-in if the Fargate task proves too much operational weight.
- **D-25:** Postgres channel payload contract: `{ kind: "inbox_item" | "entity_merge" | "capture_ack" | "draft_ready" | "timeline_event", id: string, entity_id?: string, ts: iso8601 }`. Client fans payloads to the relevant view's revalidator based on `kind`. Full row data is re-fetched via the API layer — the NOTIFY carries only pointers, never full rows (Postgres NOTIFY payload cap is 8 KB; this sidesteps it and keeps auth on reads centralised).
- **D-26:** Quiet hours do not apply to SSE pushes (browser renders are not notifications). Web Push is out of scope for Phase 3 per D-01.

### Entity merge (ENT-07) + manual edit

- **D-27:** Merge UI is a **dedicated route** `/entities/[id]/merge` (not a modal — merge is consequential enough to deserve a page with room for the audit preview). Two-column layout: left = canonical entity (target), right = source entity (to be archived). Shows diff of fields, relations to be rewritten (`LinkedProjects`, `mention_events` FK updates), and an Approve-to-merge button.
- **D-28:** Merge execution is transactional in `dashboard-api`: (1) copy relations on the canonical Notion page, (2) archive source Notion page, (3) update `entity_index` and FK tables in RDS under one transaction, (4) write `agent_runs` audit row with `action='entity_merge_manual'`, `source_id`, `target_id`, `initiated_by='kevin'`, `merge_id` ULID. If any step fails partway, a `partial_merge_state` row is written to RDS and a "Resume?" card surfaces in the Inbox keyed to `merge_id` with options: Resume / Revert / Cancel.
- **D-29:** Manual entity edit is a shadcn Dialog on the per-entity page. Editable fields match Phase 1 ENT-01 schema (Name, Aliases, Type, Org, Role, Relationship, Status, LinkedProjects, SeedContext, ManualNotes). Submit writes to Notion via API layer; indexer sync propagates to RDS on next 5-min cycle (expected latency ≤ 5 min — documented, not shortened).

### PWA

- **D-30:** PWA implemented via **`@serwist/next`** (modern maintained successor to `next-pwa`, built on Workbox, supports App Router). Manifest at `apps/dashboard/public/manifest.webmanifest`; icons 192/512 generated from Kevin's monogram (TBD during execution).
- **D-31:** Service worker caches: (a) Static assets via Workbox default; (b) The Today view HTML + API response at `GET /today` with a **24-hour stale-while-revalidate** strategy. On offline open, the SW serves the cached Today response with a single `<div class="offline-banner">Offline — last synced {ts}</div>` overlay; no blank screen.
- **D-32:** iOS handled via Safari Add-to-Home-Screen shortcut only (not a PWA). Document this in `/login` help text so Kevin doesn't try to install from iOS and hit EU DMA regression.
- **D-33:** Android + desktop install prompt behaviour: no proactive `beforeinstallprompt` banner. Installs happen via Chrome's address-bar icon or the `/settings` page's "Install" button (later). Reason: ADHD-friendly + matches mockup's restrained tone.

### Performance budgets

- **D-34:** Initial Today render budget = **< 1.5 s TTFB + LCP on Vercel EU region** (Stockholm edge). Per-entity page with 50 timeline rows = **< 500 ms interactive** per roadmap success criterion 2.
- **D-35:** Timeline rendering = **50 rows SSR + react-window virtualization** for rows beyond 50 (infinite scroll on scroll-to-bottom triggers API layer paginated fetch). Mockup's scroll behaviour honoured.
- **D-36:** `mention_events` MV (MEM-04) is a Phase 6 concern. Phase 3 queries the live `mention_events + agent_runs` JOIN with the per-entity index on `entity_id + ts`. A comment in the API-layer query flags the upgrade path: "replace with `entity_timeline_mv` when Phase 6 ships".

### Deployment & ops

- **D-37:** Vercel account = `kevin-elzarka`, project = `kos-dashboard`, linked to the monorepo, root = `apps/dashboard`. **Pro tier** ($20/month) — chosen to get `maxDuration: 300` on the SSE endpoint (Hobby caps at 10s, unusable). This resolves STATE.md open question #6.
- **D-38:** Environment variables synced from AWS Secrets Manager → Vercel via a `scripts/sync-vercel-env.ts` helper that Kevin runs on rotation. Required keys: `KOS_DASHBOARD_API_URL` (Function URL), `AWS_ACCESS_KEY_ID_DASHBOARD`, `AWS_SECRET_ACCESS_KEY_DASHBOARD`, `AWS_REGION=eu-north-1`, `KOS_DASHBOARD_BEARER_TOKEN`, `SENTRY_DSN`, `LANGFUSE_PUBLIC_KEY` (reuse Phase 2 secret).
- **D-39:** Custom domain deferred — Vercel's default `kos-dashboard-kevin-elzarka.vercel.app` is sufficient for single-user MVP. Document a path for moving to `kos.tale-forge.app` once the rest of the system is stable.
- **D-40:** Observability: **`@sentry/nextjs`** in the dashboard app; Sentry project `kos-dashboard` (free tier). **Vercel Analytics** enabled (included in Pro) — source of truth for Gate 4's "dashboard > 3 sessions/week" metric.

### Language / i18n

- **D-41:** UI chrome is **English** (labels, button text, empty states, errors). Data passes through unchanged — entity names, Notion content, transcripts, briefs render in whatever language they were written in (Swedish-English code-switched is the expected case). No `i18n` library, no translation layer. Matches PROJECT.md "bilingual SE/EN throughout" intent without adding infra.

### Claude's Discretion

The following are not decided here — downstream agents have flexibility:

- Exact shadcn/ui subcomponent composition per view (mockup HTML is the visual target; implementation assembly details open).
- Layout grid specifics (mockup uses a ~1280px max-width container; Tailwind grid/flex choices open).
- Sentry sample rate, Langfuse integration depth (dashboard-to-agent correlation), error boundary placement.
- Loading indicator placements (subject to D-12 motion rules — single pulsing dot).
- Exact Postgres notification channel name beyond `kos_output` (may split per-kind if performance warrants).
- Icon set beyond Geist Mono kbd badges — lucide-react is the default shadcn pairing; use it unless mockup demands custom.
- `/settings` page content and route (acceptable to ship empty or minimal; not load-bearing for success criteria).
- Keyboard shortcut list surface (a `?` help overlay is mockup-consistent but not required for phase gate).

### Folded Todos

None — `gsd-tools todo match-phase 3` returned zero matches.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project definition & scope
- `.planning/PROJECT.md` — KOS vision, ADHD rules, locked key decisions, single-user constraint, calm-by-default output principle.
- `.planning/REQUIREMENTS.md` §Dashboard (UI) — Phase 3 owns **UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, ENT-07, ENT-08, INF-12**.
- `.planning/ROADMAP.md` §Phase 3 — goal, 6 success criteria, dependency on Phase 2, parallelism note with Phase 4.
- `.planning/STATE.md` — 14 locked cross-phase decisions (SSE via Postgres LISTEN/NOTIFY #7, Bearer token auth #8, single-user #13); open question #6 (Vercel tier) resolved → Pro.

### Phase 1 / Phase 2 carry-forward
- `.planning/phases/01-infrastructure-foundation/01-CONTEXT.md` — D-01..D-15 infrastructure locks (VPC topology, RDS, Secrets Manager, cost alarms).
- `.planning/phases/02-minimum-viable-loop/02-CONTEXT.md` — D-13 KOS Inbox Notion DB schema (this is the data source for Phase 3's Inbox view), D-19..D-21 agent orchestration contract (this is what emits `kos.output` events), D-25 Langfuse tracing (dashboard extends the tag convention).
- `.planning/phases/01-infrastructure-foundation/01-*-SUMMARY.md` and `.planning/phases/02-minimum-viable-loop/02-*-SUMMARY.md` — what actually shipped in each plan; check before assuming infra behaviour.

### Design system (binding)
- **`TFOS-ui.html` at repo root** — canonical visual spec. 2102 lines. Contains 7 fully designed views (Today, Person dossier, Project dossier, Inbox, Calendar, Capture chat, Command palette) + a `:root` design-token card + a motion-principles card + a "what this UI deliberately avoids" list. All Phase 3 visual decisions defer to this file.
- **`TFOS-overview.html` at repo root** — companion document. Background, system narrative, and flow explanations that frame the UI decisions.

### Research & stack rationale
- `.planning/research/STACK.md` §Frontend — Next.js 15 + Vercel rationale, SSE vs alternatives, shadcn/ui choice.
- `.planning/research/ARCHITECTURE.md` §Dashboard — the `kos.output` → LISTEN/NOTIFY → SSE pipeline intent.
- `.planning/research/PITFALLS.md` — Vercel Edge runtime cannot use `pg`; Next.js App Router gotchas; service worker traps.

### Project conventions
- `CLAUDE.md` §"Recommended Stack" — Next.js 15.x, Tailwind v4, shadcn/ui versions. Drizzle ORM v0.30+ for DB access. Sentry NextJS v8.x.
- `CLAUDE.md` §"What NOT to Use" — AppSync, Pusher, Supabase Realtime, Cognito, Clerk are all excluded; D-19..D-25 honour this.

### External docs (read during planning)
- Next.js 15 App Router — `https://nextjs.org/docs/app` (route groups, middleware, Server Actions)
- shadcn/ui components — `https://ui.shadcn.com/docs` (install per-component; Tailwind v4 compat notes)
- Tailwind CSS v4 `@theme` directive — `https://tailwindcss.com/docs/theme`
- cmdk command palette — `https://cmdk.paco.me/`
- @serwist/next — `https://serwist.pages.dev/docs/next` (PWA + service worker, App Router native)
- Vercel SSE + `maxDuration` — `https://vercel.com/docs/functions/streaming-functions`
- Postgres LISTEN/NOTIFY — `https://www.postgresql.org/docs/16/sql-listen.html` (8 KB payload cap → D-25 pointer-only contract)
- @sentry/nextjs — `https://docs.sentry.io/platforms/javascript/guides/nextjs/`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/cdk/lib/constructs/kos-lambda.ts` — KosLambda (Node 22 ARM64, externalized `@aws-sdk/*`, 30-day log retention). Phase 3's `dashboard-api`, `dashboard-notify`, and `dashboard-listen-relay` all use this (latter as a Fargate task, different construct but same logging convention).
- `packages/cdk/lib/stacks/events-stack.ts` — `kos.output` bus already exists. Phase 3 adds an EventBridge rule pointing to `dashboard-notify`.
- `packages/cdk/lib/stacks/integrations-stack.ts` — thin composition; Phase 3 adds a new helper `integrations-dashboard.ts` for the Vercel-facing pieces.
- `packages/db/src/schema.ts` — `entity_index`, `project_index`, `mention_events`, `agent_runs` tables ready. Phase 3 adds:
  - `entity_merge_audit` (source_id, target_id, merge_id, state, initiated_by, created_at, completed_at, error)
  - `dashboard_sessions` (optional — for Gate 4 session tracking; Vercel Analytics covers this too, decide during planning)
- `services/notion-indexer/` — the pattern for Notion reads + upserts; the Phase 3 `dashboard-api` merge path reuses these helpers.
- `services/push-telegram/` — the existing wrapper for any Telegram fan-out; Phase 3 does not need this directly, but the merge "Resume?" card MAY push a Telegram ack on completion (counts against the 3/day cap, so default is silent — Inbox-only notification).
- `vocab/sv-se-v1.txt` — not used in Phase 3 but demonstrates the repo's approach to asset files.

### Established Patterns
- Per-plan helper file in `packages/cdk/lib/stacks/` (e.g. `integrations-notion.ts`, `integrations-azure.ts`) — Phase 3 adds `integrations-dashboard.ts` + a new `dashboard-stack.ts` if the SSE Fargate task lives separately.
- Drizzle migrations hand-authored in SQL (`0001_initial.sql` through `0006_*.sql` after Phase 2). Phase 3 adds migration `0007_entity_merge_audit.sql` and `0008_listen_notify_triggers.sql`.
- IAM grants: `.grantRead/Write()` cross-stack fails silently; always belt-and-braces with an explicit `PolicyStatement` (Phase 1 retro).
- CustomResource DELETE handlers MUST echo `event.PhysicalResourceId` unchanged (Phase 1 retro).
- Lambdas that read Secrets Manager from private-isolated subnets need a Secrets Manager VPC interface endpoint — the endpoint was torn down post-bastion. If `dashboard-api` runs in private subnets and needs Secrets Manager, re-add the interface endpoint in the DashboardStack.

### Integration Points
- **`kos.output` EventBridge bus** — Phase 3 adds rule `to-dashboard-notify` matching `detail-type ∈ {inbox_item, entity_merge, capture_ack, draft_ready, timeline_event}`.
- **RDS Proxy** — reused by `dashboard-api` Lambda and `dashboard-listen-relay` Fargate task. Both authenticate via RDS IAM auth per Phase 1 pattern.
- **Notion workspace** — `dashboard-api` reads/writes the KOS Inbox DB (created Phase 2), Entities DB, Projects DB, Kevin Context page. Never writes to Command Center directly from the dashboard in Phase 3 (that's Phase 7+).
- **Secrets Manager** — new entry `kos/dashboard-bearer-token` (placeholder to Kevin-generated), `kos/sentry-dsn` (placeholder until Sentry project created).
- **Monorepo** — `apps/dashboard` is a new pnpm workspace. `pnpm-workspace.yaml` needs the `apps/*` glob added.

### What doesn't exist yet
- `apps/` directory — monorepo currently has `packages/` + `services/`. Phase 3 creates `apps/dashboard/`.
- Any frontend code, any React, any Tailwind, any shadcn config — this is the first TypeScript UI work in the repo.
- Vercel project — Kevin creates it during the phase, connects to the repo.
- No prior Vercel → AWS integration to template from — Phase 3 establishes the pattern.

</code_context>

<specifics>
## Specific Ideas

- **Mockup is binding, not aspirational.** `TFOS-ui.html` is a fully-rendered prototype, not a wireframe. Planning should paste the mockup's HTML snippet per view directly into the plan as the visual target. Deviations require a documented reason.
- **Keyboard-first Inbox** per mockup §Inbox: `J/K` next/prev, `Enter` approve, `E` edit, `S` skip, `Esc` close. These map to the actions from ENT-09 resolver stages and the triage queue. Do not invent new shortcuts without checking the mockup.
- **Bolag colour coding** (Tale Forge sky-blue, Outbehaving orange, Personal violet) is used throughout the mockup. `entity_index.org` is the data source; map at render time.
- **Command palette is the unified nav.** Sidebar nav is also present but the palette is the ADHD-friendly primary. Expect Kevin to live in it.
- **Status colours are desaturated** per mockup's "what to avoid". #34D399 success, #FBBF24 warning, #F87171 danger — these exact hexes are in `TFOS-ui.html`.
- **Real-time updates fade in only** (mockup §Motion). New Inbox row slides 4px max. No layout reflow on existing rows. This is the single-most-violated principle by default React behaviour — plan accordingly (e.g., `FlipMove`-style animations banned; use a stable virtualized list with `framer-motion` `AnimatePresence` for insertions only).
- **No skeleton loaders anywhere.** Load budgets (< 1.5 s Today, < 500 ms entity) make them unnecessary; if a load does take longer, the "single 6×6 pulsing dot" rule applies.
- **PWA offline banner text is honest:** "Offline · last synced {relative time} · some actions disabled". No "try again" button — reconnection is automatic.
- **The dashboard counts against Gate 4.** Vercel Analytics session count IS the measurement for "dashboard > 3 sessions/week" in Gate 4 criteria. Ensure Vercel Analytics is wired on the first deploy, not retroactively.
- **ENT-07 merge audit must be queryable** by Gate 4 reviewers — store `merge_id` as a ULID so audit timelines sort naturally.

</specifics>

<deferred>
## Deferred Ideas

- **Capture chat view** (mockup §Capture chat) — deferred to Phase 3.5 or bundled with Phase 4 iOS Shortcut work. Requires streaming triage backend, auto-context dossier preview, and a composer connected to the `kos.capture` bus with live routing visibility. Mockup stays as the visual target.
- **Command palette natural-language routing** — Phase 3 ships string-match only. NL routing (e.g. "what did Christina say about timing") requires AGT-04 auto-context loader (Phase 6) and semantic search over transcripts.
- **Google Calendar merge into Calendar view** — Phase 8 (CAP-09).
- **Web Push desktop notifications** — Telegram covers push today; Web Push desktop-only is a nice-to-have, not a Phase 3 gate.
- **Company + Document entity dossier templates** — deferred until live data of those types exists. Same per-entity template shape.
- **Morning brief generation (AUTO-01)** — Phase 7 owns the generator. Phase 3 renders the output container.
- **Voice/text dump zone backend wiring** — UI renders the composer; wiring it to publish to `kos.capture` bus with a fresh `capture_id` is in scope for Phase 3, but if it slips, Telegram already covers the path.
- **Custom domain** (`kos.tale-forge.app` or similar) — defer until beyond Phase 3 MVP.
- **Upstash Redis pub/sub as SSE fan-out** — alternative to the Fargate LISTEN relay (D-24). If the Fargate task proves operationally heavier than expected, swap in Upstash (free tier sufficient for single-user). Architecture identical from the Vercel side.
- **RDS Proxy endpoint exposed to Vercel via VPC peering** — alternative to the API-layer Lambda (D-16). Requires Vercel Enterprise or a paid IP allowlist add-on. Deferred indefinitely.
- **Multi-entity merge (select-three-to-merge)** — Phase 3 merges pairwise only. Multi-entity can come once the core merge flow is stable.
- **Dashboard localization (i18n library)** — not needed for single-user bilingual use; revisit if collaboration is ever added.
- **Keyboard shortcut help overlay (`?`)** — nice-to-have; skip unless it naturally falls out of a shadcn dialog.
- **`/settings` page** — ship stub; full settings (Bearer rotation UI, data export, logout everywhere) not required for Phase 3 gate.

### Reviewed Todos (not folded)
None — no pending todos matched Phase 3 scope.

</deferred>

---

*Phase: 03-dashboard-mvp*
*Context gathered: 2026-04-23*
*Mode: --auto (all gray areas resolved to recommended defaults)*
