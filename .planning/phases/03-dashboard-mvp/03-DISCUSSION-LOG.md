# Phase 3: Dashboard MVP - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 03-CONTEXT.md — this log preserves the alternatives considered
> and documents the auto-mode choices for review.

**Date:** 2026-04-23
**Phase:** 03-dashboard-mvp
**Mode:** `--auto` — all gray areas resolved by Claude to recommended defaults
**Areas discussed:** View scope, Design system, App shell & routing, Data access, Auth, SSE, Entity merge, PWA, Performance, Deployment, Language

---

## View scope & information architecture

| Option | Description | Selected |
|--------|-------------|----------|
| Four views only (Today + Entity + Inbox + Calendar) | Minimum roadmap scope | |
| Four views + Command palette | Mockup-driven, cmdk add-on is cheap | ✓ |
| Everything in mockup (incl. Capture chat) | Full mockup parity | |

**[auto] Choice:** Four views + Command palette
**Rationale:** Command palette is fully designed in `TFOS-ui.html`, cost of cmdk integration is trivial, and it meaningfully amplifies Inbox + entity navigation. Capture chat requires a streaming triage backend that overlaps Phase 4 — deferred to keep Phase 3 scope tight.

---

## Design system

| Option | Description | Selected |
|--------|-------------|----------|
| Use `TFOS-ui.html` as canonical spec | Port tokens 1:1 into Tailwind v4 @theme | ✓ |
| Hand-roll a new design system | Ignore mockup, start fresh | |
| Tailwind defaults + shadcn defaults | Don't port any mockup tokens | |

**[auto] Choice:** Port `TFOS-ui.html` tokens into Tailwind v4 `@theme` directive
**Rationale:** Kevin already invested 2102 lines into a complete visual spec with 7 designed views, explicit anti-patterns ("no skeleton loaders"), and motion principles. Discarding this would be a net loss. Tokens as CSS variables lets mockup HTML be pasted side-by-side during development for visual-diff validation.

---

## Component primitives

| Option | Description | Selected |
|--------|-------------|----------|
| shadcn/ui (Radix + Tailwind) | Canonical choice in CLAUDE.md §Stack | ✓ |
| Headless UI / Radix directly | More manual but less opinionated | |
| Chakra / MUI | Heavier, opinionated, fights with tokens | |

**[auto] Choice:** shadcn/ui with tokens overridden to match `TFOS-ui.html`
**Rationale:** shadcn is the monorepo's designated choice; Radix primitives give keyboard-first accessibility out of the box (critical for the Inbox J/K flow); components are vendored into the repo so overrides are first-class.

---

## App shell & routing

| Option | Description | Selected |
|--------|-------------|----------|
| Next.js 15 App Router | React Server Components, Server Actions, middleware | ✓ |
| Next.js Pages Router | Legacy, no RSC | |
| Remix / SvelteKit | Different framework entirely | |

**[auto] Choice:** Next.js 15 App Router with `(auth)` and `(app)` route groups
**Rationale:** Locked in CLAUDE.md §Stack. RSC removes the need for a separate API layer for reads; Server Actions handle mutations with no REST boilerplate.

---

## Database access from Vercel

| Option | Description | Selected |
|--------|-------------|----------|
| Direct Postgres from Vercel | Needs Vercel static IPs + VPC peering | |
| In-VPC Lambda Function URL API layer (IAM auth) | Keeps RDS private, centralises authz | ✓ |
| RDS Data API / HTTP endpoint | Not available on RDS PostgreSQL 16 | |

**[auto] Choice:** `dashboard-api` Lambda inside VPC exposed via Function URL with AWS_IAM auth
**Rationale:** RDS stays private forever. One place to observe, rate-limit, and authorize reads. Vercel holds IAM credentials only — no DB connection strings. Matches the "Fargate for persistent connections, Lambda for everything else" principle.

---

## Authentication

| Option | Description | Selected |
|--------|-------------|----------|
| Static Bearer token in httpOnly cookie | Per STATE.md locked decision #8 | ✓ |
| NextAuth.js | Overkill for single-user | |
| Clerk / Cognito | Excluded in CLAUDE.md §What NOT to Use | |

**[auto] Choice:** Bearer token → httpOnly cookie via `/login` + middleware-gated routes
**Rationale:** Already locked cross-phase. Single-user means no user table, no session store, no OAuth dance. Cookie carries the token verbatim; middleware checks presence-only.

---

## Real-time push (SSE)

| Option | Description | Selected |
|--------|-------------|----------|
| Vercel Node SSE + Fargate LISTEN relay | Matches STATE.md #7 (Postgres LISTEN/NOTIFY) | ✓ |
| Upstash Redis pub/sub fan-out | Simpler but adds 3rd-party dependency | |
| AppSync / Pusher | Excluded in CLAUDE.md §What NOT to Use | |
| WebSocket via API Gateway | Overkill; unidirectional push sufficient | |

**[auto] Choice:** `kos.output` → `dashboard-notify` Lambda → Postgres `NOTIFY` → `dashboard-listen-relay` Fargate (holds LISTEN) → Vercel SSE Route Handler long-polls relay → browser
**Rationale:** Honours the locked Postgres LISTEN/NOTIFY architecture. Vercel's Node functions can't hold VPC-private Postgres connections directly; the tiny Fargate relay bridges this gap with persistent LISTEN. Upstash recorded as deferred alternative if the Fargate task proves heavier than expected.

**SSE duration:** 300s `maxDuration` with client auto-reconnect (500ms → 60s exponential backoff). Single-user reconnect is invisible in practice.

---

## Vercel tier

| Option | Description | Selected |
|--------|-------------|----------|
| Hobby (free) | 10s function max — SSE unusable | |
| Pro ($20/month) | 300s maxDuration, included Analytics | ✓ |
| Fluid Compute | Experimental; stay on stable Pro | |

**[auto] Choice:** Vercel Pro
**Rationale:** SSE requires long-running Node functions. Pro also includes Vercel Analytics which IS the measurement source for Gate 4's "dashboard > 3 sessions/week" criterion. Resolves STATE.md open question #6.

---

## Entity merge UI (ENT-07)

| Option | Description | Selected |
|--------|-------------|----------|
| Modal on per-entity page | Quick but cramped for audit preview | |
| Dedicated `/entities/[id]/merge` route | Room for diff + relations + audit preview | ✓ |
| Wizard / stepper | Overkill for two-entity merge | |

**[auto] Choice:** Dedicated route with transactional execution in `dashboard-api` + "Resume?" Inbox card on partial failure
**Rationale:** Merges are consequential; the dedicated route signals weight and leaves room for the relation-rewrite preview. Partial-failure resume flow matches roadmap success criterion 3 literally.

---

## PWA

| Option | Description | Selected |
|--------|-------------|----------|
| `@serwist/next` | Modern Workbox-based, App Router native | ✓ |
| `next-pwa` | Older, Pages Router-focused | |
| Hand-rolled service worker | More control, more maintenance | |

**[auto] Choice:** `@serwist/next` with 24h stale-while-revalidate on Today view + offline banner
**Rationale:** Serwist is the maintained successor to next-pwa with first-class App Router support. Kevin wants "offline mode renders the last loaded Today state from a 24-hour service-worker cache rather than a blank screen" — Workbox's SWR strategy is literally this.

---

## Performance budgets

| Option | Description | Selected |
|--------|-------------|----------|
| Virtualized timeline (react-window) | Required for 50+ row entity pages | ✓ |
| Plain scroll | Fine until volume grows | |
| Pagination buttons | Feels dated; mockup shows scroll | |

**[auto] Choice:** 50 rows SSR + react-window virtualization + paginated API fetch on scroll
**Rationale:** Matches mockup's scroll behaviour and hits the roadmap's < 500ms interactive target even at 50 rows without needing Phase 6's MV. Upgrade path to `entity_timeline_mv` flagged inline in the API query.

---

## Language / i18n

| Option | Description | Selected |
|--------|-------------|----------|
| English chrome, pass through data as-is | No i18n lib, bilingual data renders natively | ✓ |
| Full i18n (next-intl) | Overkill for single user | |
| Swedish chrome | Kevin uses both; English is clearer for tech labels | |

**[auto] Choice:** English UI chrome; data passes through unchanged
**Rationale:** Kevin is bilingual; entity names, transcripts, briefs are naturally code-switched. Adding an i18n layer would add complexity without a second user to justify it.

---

## Claude's Discretion

Left flexible for downstream planners:
- shadcn subcomponent composition per view (mockup HTML is the target)
- Tailwind grid/flex specifics
- Sentry sample rate and error boundary placement
- Postgres notification channel split strategy (single `kos_output` or per-kind)
- Icon set (lucide-react default unless mockup demands custom)
- `/settings` page content (empty stub acceptable)

## Deferred Ideas

Captured in `03-CONTEXT.md` §deferred. Key items:
- Capture chat view (Phase 3.5 / Phase 4)
- Natural-language command palette routing (needs Phase 6 auto-context loader)
- Google Calendar merge (Phase 8)
- Web Push desktop notifications (post-MVP)
- Company + Document entity dossier templates (when volume exists)
- Upstash Redis alternative for SSE fan-out (if Fargate relay proves heavier than expected)
- Custom domain migration
- `/settings` page, keyboard help overlay, multi-entity merge

---

*Discussion mode: `--auto` — all 11 gray areas resolved to recommended defaults in a single pass.*
