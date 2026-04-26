# Phase 11: Frontend Rebuild + Real-Data Wiring + Button Audit — Context

**Gathered:** 2026-04-26
**Status:** Ready for planning
**Source:** Direct brief from Kevin (PRD Express style — no discuss-phase needed)

<domain>
## Phase Boundary

This phase replaces the current `apps/dashboard` Next.js placeholder UI with a production-grade operational dashboard, eliminates demo/seed data leakage from prod RDS, surfaces ALL real captures (not just urgent email drafts) with classification tags, and audits every interactive button so each one either works or is removed. It also wires the existing `/calendar`, `/chat`, `/entities`, `/today` pages to live data sources end-to-end.

**In scope:**
- Visual redesign of `apps/dashboard/src/app/(app)/**/*` in mission-control aesthetic
- New unified design system (tokens, primitives, theme) under `apps/dashboard/src/components/ui/` (or chosen path)
- DELETE stale demo rows from `inbox_index`, `email_drafts`, `agent_dead_letter`, and any other prod tables polluted with fixtures
- Re-seeding safeguard: a runtime guard or DB CHECK so prod cannot ingest seed data again
- Drop email-triage urgent-only filter for inbox surfacing — show all classified captures with status pills
- Button audit across every page (approve / edit / skip / search / settings / nav / capture) — wire or remove
- Wire `/calendar`, `/chat`, `/entities`, `/today` to real data via existing dashboard-api endpoints (or new endpoints where missing)
- Today view: surface today's real captures (Telegram, Gmail, Granola, Chrome highlights, LinkedIn DMs)

**Out of scope (explicit deferrals):**
- Phase 11-bis (NEW): two-way Telegram conversational mode (deferred to a separate phase — `gsd-add-phase` later)
- Brand voice / Postiz publisher / SES production access (already deferred indefinitely per HANDOFF-2026-04-26-FULL-DAY)
- iOS Action Button / Discord / WhatsApp (deferred indefinitely per Kevin)
- New AI features beyond chat surface wiring (chat backend is its own phase)

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### D-01 — Design system: Mission-Control aesthetic
**Locked.** Reference repo: github.com/Jzineldin/mission-control. Key visual properties (extracted from screenshots):
- Background: dark navy-tinted black (NOT pure #000)
- Containers: rounded cards with subtle borders, soft shadows
- Stats: BIG numeric tiles in caps-labelled boxes (e.g., "INVENTORY 24", "MENTIONS 46", "EVENTS 225")
- Status pills: colored dots with text label (green=Active/Healthy, blue=Info, orange=Token-budget, red=Alert)
- Activity feed: priority-numbered rows (100, 99, 95, 87, 84, 81…) — descending priority, color-shaded by score
- Channel health: integration status bars per channel (Telegram, Gmail, Granola, Calendar, etc.) with colored health indicator
- Persistent chat bubble in bottom-right (existing `kos-chat` route — wire it visually)
- Sidebar nav: icons + compact labels, active state highlighted
- Profile avatar: bottom-left of sidebar
- Accent palette: vibrant green (#10b981 family), blue (#3b82f6 family), orange (#f59e0b family), red (#ef4444 family) on muted base

### D-02 — No quick-win-only path
**Locked.** Kevin chose "Big play" — full rebuild + real data wiring + button audit. NOT just clearing demo data.

### D-03 — Demo data wipe: scope
**Locked.** DELETE stale rows from `inbox_index`, `email_drafts`, `agent_dead_letter` for `owner_id = Kevin`. Names confirmed in seed pollution (none exist in code/migrations — they were inserted by hand or one-shot dev script): "Damien Carter", "Christina Larsson", "Jan Eriksson", "Lars Svensson", "Almi Företagspartner", "Re: Partnership proposal", "Re: Summer meeting", "Possible duplicate: Damien C.", "Paused: Maria vs Maria Johansson", "Outbehaving angel investor".

### D-04 — Re-seeding safeguard
**Locked, mechanism Claude's discretion.** Acceptable options: (a) DB CHECK constraint that blocks rows with known seed-name patterns when `kos.environment=prod` GUC is set; (b) startup guard in dashboard-api that hard-fails if it detects known-seed rows; (c) migration-script flag preventing dev seeds from running in prod. Pick the cheapest one that works.

### D-05 — Drop urgent-only filter for inbox surfacing
**Locked.** Currently `services/dashboard-api/src/email-drafts-persist.ts:listInboxDrafts` filters `status IN ('draft','edited')` — this hides `'skipped'` (= classified `not_urgent`). Phase 11 expands the inbox to show ALL classified email captures with their classification as a visible tag/pill. The existing approve/edit/skip flow still works for `draft` status; `not_urgent` items are read-only (no approve action) but visible.

### D-06 — Button audit: every interactive surface must work or be removed
**Locked.** Sweep every `<button>`, `<Link>`, kbd shortcut, tab, filter, search, settings entry across the `(app)` route group. Each one either has a working handler or is removed. NO half-implemented buttons. Document each in PLAN.md acceptance criteria.

### D-07 — Live data wiring: pages affected
**Locked.** `/today`, `/inbox`, `/entities`, `/calendar`, `/chat` (chat surface only — backend is separate phase), plus a new `/integrations-health` view (channel-health indicator strip on Today should link here). Each page must call real dashboard-api endpoints (or have new endpoints added in a plan) and render real data. NO mocks, NO seed fixtures rendered.

### D-08 — Stack constraints
**Locked.** Stay on Next.js 15 App Router + React 19 + Tailwind v4 (already in tree per CLAUDE.md). Add shadcn/ui primitives via `npx shadcn@latest add` for cards/buttons/dialogs (already partially used). NEW: introduce a small set of design-system tokens in `apps/dashboard/src/lib/design-tokens.ts` so colors and spacing live in one place. NO new framework swap.

### D-09 — Authentication unchanged
**Locked.** Static Bearer token in cookie continues — no auth rewrite in this phase.

### D-10 — Mobile / responsive
**Locked, deferred.** Desktop-first. Phone responsiveness can be best-effort but is NOT a blocker.

### D-11 — Accessibility floor
**Locked.** Keyboard navigation must work on the inbox approve/edit/skip flow (already has J/K/Enter/E/S shortcuts in current UI per inbox screenshot). Color contrast must clear WCAG AA on text — design tokens picked accordingly.

### D-12 — Empty-state strategy
**Locked.** Every page MUST render gracefully when there is zero data. Empty state should be informative ("No captures today — KOS will surface as they arrive") not blank.

### D-13 — Telemetry / Sentry
**Locked.** Already wired via `@sentry/nextjs` per CLAUDE.md. New components must not regress it.

### D-14 — Real-time push behavior preserved
**Locked.** The existing SSE flow (`router.refresh()` on `inbox_item` / `draft_ready` / `entity_merge` kinds — see `apps/dashboard/src/app/(app)/inbox/page.tsx:6-11`) continues. New pages should subscribe similarly.

### Claude's Discretion
- Component library structure (atomic / feature-grouped / etc.)
- Specific Tailwind class composition or CSS-in-JS approach
- Exact shape of integration-health endpoint
- Whether to keep `/inbox-merged` route or extend it (it currently only returns drafts + dead-letters; the route doc-comment claims it also returns `inbox_index` rows but the code does not — this gap can be closed here)
- Exact wipe mechanism for stale rows (one-shot SQL via bastion port-forward vs. migration vs. admin endpoint)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design inspiration (external)
- `https://github.com/Jzineldin/mission-control` — repo cloned locally to `/tmp/mission-control` for visual reference. Screenshots: `screenshot.png`, `screenshot-chat.png`, `screenshot-scout.png`, `screenshot-cron.png` show the target aesthetic.

### Project conventions
- `CLAUDE.md` — stack constraints (Next.js 15, Tailwind v4, shadcn, SSE, single-user, calm-by-default ADHD UX)
- `.planning/STATE.md` — current phase status, recent decisions
- `.planning/ROADMAP.md` — Phase 3 (Dashboard MVP), Phase 4 (email_drafts), Phase 11 entry
- `.planning/HANDOFF-2026-04-26-FULL-DAY.md` — what's actually working live as of today

### Existing dashboard surface (read before planning UI changes)
- `apps/dashboard/src/app/(app)/inbox/page.tsx` — RSC entry, switched to `/inbox-merged` 2026-04-26
- `apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` — client list + keyboard nav
- `apps/dashboard/src/app/(app)/today/` — today RSC
- `apps/dashboard/src/app/(app)/entities/` — entity list + detail
- `apps/dashboard/src/app/(app)/calendar/`
- `apps/dashboard/src/app/(app)/chat/` (if exists)
- `apps/dashboard/src/app/(app)/settings/`
- `apps/dashboard/src/lib/dashboard-api.ts` — SigV4-signed API client
- `apps/dashboard/src/components/` — current primitives

### Dashboard-api routes (target endpoints to wire)
- `services/dashboard-api/src/routes/inbox.ts` — `/inbox`, `/inbox-merged`
- `services/dashboard-api/src/routes/today.ts`
- `services/dashboard-api/src/routes/entities.ts`
- `services/dashboard-api/src/routes/calendar.ts`
- `services/dashboard-api/src/routes/entity-timeline.ts`
- `services/dashboard-api/src/email-drafts-persist.ts:listInboxDrafts` — D-05 lives here

### Schema / data layer
- `services/email-triage/src/persist.ts` — email_drafts insertion + status state machine
- Migration history: 0003-0021 applied per HANDOFF — schema is current on prod
- `inbox_index` table — Phase 3 entity routings (this is where the demo names live)
- `agent_dead_letter` table — Phase 4 D-24

### Contracts
- `packages/contracts/dashboard.ts` (or wherever `InboxListSchema` lives — verify path during planning)

</canonical_refs>

<specifics>
## Specific Ideas

### Mission-control screenshots — concrete UI elements to reproduce
1. **Top stat tiles** — 4 across, label in caps small font (e.g., "INVENTORY"), giant number below (e.g., "24"). Apply to KOS as: CAPTURES TODAY / DRAFTS PENDING / ENTITIES ACTIVE / EVENTS UPCOMING.
2. **Activity feed** with descending priority numbers (100, 99, 95, 87…) — apply to KOS Today view: priority score derived from urgency + recency.
3. **Channels block** — Telegram / Gmail / Granola / Calendar / LinkedIn / Chrome status with color-coded health dots. Each clickable into `/integrations-health`.
4. **Persistent chat bubble** — bottom-right floating button, opens existing chat surface. Stays visible across all pages.
5. **Cron/Job status table** (mission-control's "Cron Jobs" page) — apply as `/integrations-health` page: schedulers + their last-run / next-run / status.

### Demo rows to wipe (case-sensitive search keys for cleanup script)
- `Damien Carter`
- `Christina Larsson`
- `Jan Eriksson`
- `Lars Svensson`
- `Almi Företagspartner`
- `Re: Partnership proposal`
- `Re: Summer meeting`
- `Possible duplicate: Damien C.`
- `Paused: Maria vs Maria Johansson`
- `Outbehaving angel investor`

### Known small bugs to close opportunistically
- `/inbox-merged` route's doc comment claims it unions `inbox_index` rows but the implementation in `services/dashboard-api/src/routes/inbox.ts:54-111` doesn't include them — match doc to code (or extend code to match doc — Phase 11 picks code-extension since users want fewer empty states).
- entity-resolver `email` column missing — degrades silently per CloudWatch logs `[email-triage] resolveEntitiesByEmail: lookup failed`. Not a Phase 11 blocker, can be flagged as separate gap.

</specifics>

<deferred>
## Deferred Ideas

- **Phase 11-bis: Two-way Telegram conversational mode** — bot becomes interactive (not just brief-pusher) wired to chat backend. Separate phase.
- **Phase 11-ter: AI chat backend** (`services/kos-chat`) — Sonnet 4.6 + `loadContext()` per HANDOFF. Separate phase.
- **iOS Action Button / Discord / WhatsApp captures** — deferred indefinitely per Kevin.
- **Brand voice doc + Postiz publisher** — gated behind brand voice; deferred.
- **Mobile-first responsive** — desktop is the target; phone is best-effort.
- **Multi-tenant productization** — Phase 999.1 backlog.
- **entity-resolver `email` column fix** — flagged in <specifics>, will become its own quick fix outside this phase.

</deferred>

---

*Phase: 11-frontend-rebuild-real-data-wiring-button-audit-mission-contr*
*Context gathered: 2026-04-26 from direct brief — no discuss-phase needed*
