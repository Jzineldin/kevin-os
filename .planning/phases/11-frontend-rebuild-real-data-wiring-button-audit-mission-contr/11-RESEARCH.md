# Phase 11: Frontend Rebuild + Real-Data Wiring + Button Audit — Research

**Researched:** 2026-04-26
**Domain:** Next.js 15 / React 19 / Tailwind v4 / shadcn/ui — operational dashboard rebuild + real-data wiring + DB pollution cleanup
**Confidence:** HIGH (codebase fully inspected; mission-control reference cloned; current state of every page + endpoint + schema verified directly)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 — Design system: Mission-Control aesthetic.** Reference repo: github.com/Jzineldin/mission-control (cloned to `/tmp/mission-control`). Visual properties:
- Background: dark navy-tinted black (NOT pure #000)
- Containers: rounded cards with subtle borders, soft shadows
- Stats: BIG numeric tiles in caps-labelled boxes ("INVENTORY 24", "MENTIONS 46", "EVENTS 225")
- Status pills: colored dot + text label (green=Active/Healthy, blue=Info, orange=Token-budget, red=Alert)
- Activity feed: priority-numbered rows (100, 99, 95, 87…) descending priority, color-shaded by score
- Channel health: integration status bars per channel with colored health dots
- Persistent chat bubble bottom-right
- Sidebar nav: icons + compact labels, active state highlighted
- Profile avatar: bottom-left of sidebar
- Accent palette: vibrant green (#10b981), blue (#3b82f6), orange (#f59e0b), red (#ef4444) on muted base

**D-02 — No quick-win-only path.** Full rebuild + real data wiring + button audit, NOT just clearing demo data.

**D-03 — Demo data wipe scope.** DELETE stale rows from `inbox_index`, `email_drafts`, `agent_dead_letter` for `owner_id = Kevin`. Names confirmed in seed pollution (verified absent from code/migrations): "Damien Carter", "Christina Larsson", "Jan Eriksson", "Lars Svensson", "Almi Företagspartner", "Re: Partnership proposal", "Re: Summer meeting", "Possible duplicate: Damien C.", "Paused: Maria vs Maria Johansson", "Outbehaving angel investor".

**D-04 — Re-seeding safeguard, mechanism Claude's discretion.** Acceptable options:
- (a) DB CHECK constraint that blocks rows with known seed-name patterns when `kos.environment=prod` GUC is set
- (b) startup guard in dashboard-api that hard-fails if it detects known-seed rows
- (c) migration-script flag preventing dev seeds from running in prod
Pick the cheapest one that works.

**D-05 — Drop urgent-only filter for inbox surfacing.** Currently `services/dashboard-api/src/email-drafts-persist.ts:listInboxDrafts` filters `status IN ('draft','edited')` — this hides `'skipped'` (= classified `not_urgent`). Phase 11 expands the inbox to show ALL classified email captures with classification as a visible tag/pill. Approve/edit/skip flow still works for `draft`/`edited`; `not_urgent`/`skipped` items are read-only (no approve action) but visible.

**D-06 — Button audit: every interactive surface must work or be removed.** Sweep every `<button>`, `<Link>`, kbd shortcut, tab, filter, search, settings entry across the `(app)` route group. Each one either has a working handler or is removed. NO half-implemented buttons. Document each in PLAN.md acceptance criteria.

**D-07 — Live data wiring: pages affected.** `/today`, `/inbox`, `/entities`, `/calendar`, `/chat` (chat surface only — backend is separate phase), plus a NEW `/integrations-health` view (channel-health indicator strip on Today should link here). Each page must call real dashboard-api endpoints (or have new endpoints added in a plan) and render real data. NO mocks, NO seed fixtures rendered.

**D-08 — Stack constraints.** Stay on Next.js 15 App Router + React 19 + Tailwind v4 (already in tree). Add shadcn/ui primitives via `npx shadcn@latest add`. NEW: introduce a small set of design-system tokens in `apps/dashboard/src/lib/design-tokens.ts` so colors and spacing live in one place. NO new framework swap.

**D-09 — Authentication unchanged.** Static Bearer token in cookie continues — no auth rewrite.

**D-10 — Mobile/responsive deferred.** Desktop-first. Phone responsiveness best-effort, NOT a blocker.

**D-11 — Accessibility floor.** Keyboard navigation must work on the inbox approve/edit/skip flow (J/K/Enter/E/S already wired). Color contrast WCAG AA on text.

**D-12 — Empty-state strategy.** Every page MUST render gracefully with zero data. Empty state should be informative ("No captures today — KOS will surface as they arrive") not blank.

**D-13 — Telemetry / Sentry.** Already wired via `@sentry/nextjs`. Must not regress.

**D-14 — Real-time push behavior preserved.** Existing SSE flow (`router.refresh()` on `inbox_item` / `draft_ready` / `entity_merge` kinds) continues. New pages subscribe similarly.

### Claude's Discretion
- Component library structure (atomic / feature-grouped / etc.)
- Specific Tailwind class composition or CSS-in-JS approach
- Exact shape of integration-health endpoint
- Whether to keep `/inbox-merged` route or extend it (the route doc-comment claims it unions `inbox_index` rows but the code does not — gap can be closed here)
- Exact wipe mechanism for stale rows (one-shot SQL via bastion port-forward vs. migration vs. admin endpoint)

### Deferred Ideas (OUT OF SCOPE)
- **Phase 11-bis:** Two-way Telegram conversational mode — separate phase
- **Phase 11-ter:** AI chat backend (`services/kos-chat`) — separate phase
- iOS Action Button / Discord / WhatsApp captures — deferred indefinitely per Kevin
- Brand voice doc + Postiz publisher — gated behind brand voice
- Mobile-first responsive — desktop is target; phone is best-effort
- Multi-tenant productization — Phase 999.1 backlog
- entity-resolver `email` column fix — separate quick fix
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-1 (UI-01 Today view) | Calendar (today + tomorrow), Top 3 priorities, Drafts to review, Dropped threads, voice/text dump zone | All current `/today` data sources verified live (HANDOFF 2026-04-26). Need to extend with mission-control stat tiles, channel-health strip, and surfacing of all capture types (Telegram/Gmail/Granola/Chrome/LinkedIn) — see Data Layer §"Today aggregation". |
| REQ-3 (UI-03 Calm visual UX) | Calm-by-default, ADHD-friendly, no notification fatigue, mission-control SOC aesthetic | Existing `globals.css` already encodes a thoughtful 03-UI-SPEC token palette (dark navy `#0a0c11`, restrained violet accent `#7c5bff`, Geist Sans + Mono). Mission-control adds: bigger numeric tiles, priority-numbered list, channel health bars. Phase 11 layers the mission-control patterns ON TOP of the existing token system rather than replacing it. |
| REQ-12 (UI-04 Inbox approval flow) | Drafts awaiting approval + ambiguous entity routings + new entities to confirm with Approve/Edit/Skip | Already partially wired (`/inbox-merged` returns `email_drafts`+`agent_dead_letter`; `/inbox` returns `inbox_index`). D-05 extends this to surface ALL classified captures with classification pills. The merge here is the explicit Phase 11 "all captures, not just urgent drafts" decision. |
</phase_requirements>

## Summary

**Para 1 — Where we stand.** Phase 3 already shipped a working dashboard scaffold on Next.js 15 / React 19 / Tailwind v4 / shadcn — including a sophisticated `globals.css` token system (matching the locked 03-UI-SPEC), a dark-navy palette (`--color-bg: #0a0c11`), Geist fonts, an SSE provider with backoff, a SigV4-since-converted-to-Bearer API client, a Sidebar with kbd shortcuts (T/I/C), an Inbox keyboard-driven approve/edit/skip flow with `useOptimistic`, a Today view with brief/priorities/drafts/dropped/meetings, a Calendar week view, an Entities list+dossier, and a CommandPalette. The dashboard is live at https://kos-dashboard-navy.vercel.app and HANDOFF-2026-04-26 confirms all routes render with real data when authenticated. **The bones are good.** Phase 11 is a cosmetic upgrade + a data-surface expansion + a button audit, NOT a rewrite. [VERIFIED: filesystem inspection of `apps/dashboard/src/**`, `services/dashboard-api/src/**`, package.json versions]

**Para 2 — What changes in Phase 11.** Three orthogonal workstreams: (1) **Visual:** layer mission-control patterns (giant numeric tiles, priority-numbered activity rows, channel-health bars, persistent chat bubble) on top of the existing 03-UI-SPEC token system — this is composition, not replacement. The existing `--color-bg / --color-surface-{1,2,3}` system already produces dark-navy SOC look; we add tile primitives, priority-list primitives, and a `ChannelHealth` component. (2) **Data:** drop the `status IN ('draft','edited')` filter in `listInboxDrafts` so all classified emails surface with a classification pill mapped from `email_drafts.classification` (urgent/important/informational/junk) × `status` (pending_triage/draft/edited/skipped/approved/sent/failed). Wire `/calendar` to real Google Calendar via the calendar-reader Lambda's `calendar_events_cache` table (currently it only reads Notion Command Center). Add a `/integrations-health` page backed by a new endpoint that polls `agent_runs` + `scheduler_runs` (where present) for last-success-per-channel. (3) **Hygiene:** delete demo rows by exact-name match (zero false positives — the names are not in any code path), install a startup guard in dashboard-api that hard-fails on detection (cheapest safeguard, no schema migration needed). [VERIFIED: persist.ts lines 51-59, 156-178; `email_drafts.classification` schema verified in 0016 migration]

**Para 3 — Risk profile.** Low surgical risk on visual layer (Tailwind v4 already in tree, shadcn CLI works with React 19 — confirmed via Context7 `/shadcn-ui/ui` Apr-2026 docs). Medium risk on data wipe: prod RDS access today is bastion + SSM port-forward, so the wipe is a one-shot SQL session, not a migration. The seed names appear ZERO times in `services/`, `apps/`, `scripts/`, or `packages/db/drizzle/` per repo-wide grep — confirming Kevin's brief that they were inserted by hand or a one-shot dev script that no longer exists. Highest risk is hydration mismatch on theme tokens (avoided by using CSS custom properties only, no JS-driven theme switching). The `agent_runs` table for channel-health derivation needs verification of column shape — flagged as Open Question 1.

**Primary recommendation:** Do NOT rewrite `globals.css`. ADD a thin mission-control layer (`mission-control.css` or extend `globals.css` with namespaced classes like `.mc-stat-tile`, `.mc-priority-row`, `.mc-channel-bar`, `.mc-chat-bubble`). Do NOT replace shadcn primitives. Use `npx shadcn@latest add` for any missing primitives (`progress`, `tabs` already exists, `sheet`, `accordion`). Wipe with one-shot SQL via the existing bastion (HANDOFF says it's already deployed; teardown is on the operator todo list). Re-seed safeguard: option (b) startup guard in dashboard-api — cheapest, zero migration cost, immediate fail-loud signal.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Visual rebuild (mission-control aesthetic) | Browser/Client (Next.js client components) | Frontend Server (RSC) | Pure presentation; tokens live in CSS; data still SSR'd from RSC for first paint. |
| Demo data wipe | Database (RDS) | API (dashboard-api startup guard) | Deletion is a DB op; safeguard runs at API boot. |
| Re-seeding safeguard | API (dashboard-api startup guard) | — | Hard-fail at Lambda init; zero schema impact. |
| Inbox classification surfacing (drop urgent-only filter) | API (dashboard-api `listInboxDrafts` + `/inbox-merged`) | Browser/Client (renderer + pill mapping) | SQL filter change in API; pill rendering in client. |
| Button audit | Browser/Client (component-level) | — | Static analysis + manual sweep; no API changes unless a button needs a new endpoint. |
| Live data wiring `/today` | Frontend Server (RSC `callApi('/today')`) | API (dashboard-api `/today` + new sub-endpoints for Telegram/Granola/Chrome/LinkedIn captures) | Existing /today exists; needs extension for non-email captures. |
| Live data wiring `/calendar` | API (calendar-reader → calendar_events_cache → dashboard-api `/calendar/week`) | Frontend Server (RSC + CalendarWeekView client) | Calendar handler currently reads Notion ONLY — needs to UNION with `calendar_events_cache` populated by calendar-reader Lambda. |
| Live data wiring `/entities` | API (dashboard-api `/entities/list` + `/entities/:id`) | Frontend Server (RSC) | Already wired; needs visual upgrade only. |
| Chat UI shell | Browser/Client (Sheet/Dialog component for floating bubble) | — | Visual shell only; backend is Phase 11-ter. Bubble opens a `<Sheet>` with "Coming soon — Phase 11-ter" placeholder. |
| `/integrations-health` view | Frontend Server (RSC) | API (new `/integrations/health` endpoint reading agent_runs + scheduler last-success) | New surface. |
| SSE refresh hooks (existing) | Browser/Client (SseProvider + useSseKind) | API (dashboard-listen-relay) | Already wired; new pages just add `useSseKind('inbox_item', () => router.refresh())`. |

## Current State Inventory

### Pages & Routes (apps/dashboard/src/app)

| Route | File | Status | Notes |
|-------|------|--------|-------|
| `/` | `page.tsx` | Redirects to `/today` (HANDOFF) | Was a placeholder pulse-dot. |
| `/login` | `(auth)/login/page.tsx` + `LoginForm.tsx` | LIVE | Bearer token form. |
| `/today` | `(app)/today/page.tsx` + `TodayView.tsx` + 6 sub-components | LIVE | RSC reads `/today`; client subscribes to `inbox_item`+`draft_ready` SSE. **Missing:** stat tiles, channel health, non-email captures. |
| `/inbox` | `(app)/inbox/page.tsx` + `InboxClient.tsx` + `ItemDetail.tsx` + `ItemRow.tsx` + `ResumeMergeCard.tsx` + `actions.ts` | LIVE | Calls `/inbox-merged` first (Phase 4 union), falls back to `/inbox`. J/K/Enter/E/S kbd works. **D-05 changes here.** |
| `/entities` | `(app)/entities/page.tsx` | LIVE | List view; uses `getPaletteEntities()` shared with command palette. |
| `/entities/[id]` | `(app)/entities/[id]/page.tsx` + `AiBlock.tsx` + `EntityDossier.tsx` + `EditEntityDialog.tsx` + `LinkedWork.tsx` + `StatsRail.tsx` + `Timeline.tsx` + `actions.ts` | LIVE | Full dossier + edit dialog. |
| `/entities/[id]/merge` | `merge/page.tsx` + `MergeReview.tsx` + `MergeConfirmDialog.tsx` + `merge/actions.ts` | LIVE (Phase 8) | Merge flow. |
| `/calendar` | `(app)/calendar/page.tsx` + `CalendarWeekView.tsx` | LIVE BUT THIN | Reads `/calendar/week` which currently ONLY hits Notion Command Center. **Phase 11 must UNION with calendar_events_cache from calendar-reader.** |
| `/chat` | **DOES NOT EXIST** | NOT BUILT | Sidebar references it as `disabled` with tooltip "Ships with Phase 4". Phase 11 adds shell only. |
| `/settings` | `(app)/settings/page.tsx` | STUB | Says "Settings stub — not wired in Phase 3." Phase 11 must either wire something useful (env / channel toggles / token refresh) or remove the link entirely (D-06). |
| `/integrations-health` | **DOES NOT EXIST** | NEW | Phase 11 adds. |
| `/offline` | `app/offline/page.tsx` | LIVE | PWA offline fallback. |
| `/api/auth/login` | route.ts | LIVE | Sets `kos_session` cookie. |
| `/api/auth/logout` | route.ts | LIVE | Clears cookie. |
| `/api/stream` | route.ts | LIVE | SSE proxy to dashboard-listen-relay; 280s deadline; 15s heartbeat. |
| `/api/today` | route.ts | LIVE | Mirror of dashboard-api `/today`. |
| `/api/calendar/week` | route.ts | LIVE | Mirror. |
| `/api/email-drafts/[id]/{approve,edit,skip}` | three route.ts files | LIVE (Phase 4) | Server Actions for inbox flow. |
| `/api/entities/[id]/timeline` | route.ts | LIVE (Phase 6) | Timeline cursor pagination. |
| `/api/merge-resume` | route.ts | LIVE (Phase 3) | Merge flow. |
| `/api/palette-entities` | route.ts | LIVE | Command palette data. |

### Shared Components (apps/dashboard/src/components)

**Already installed shadcn primitives** (under `components/ui/`): `avatar`, `button`, `card`, `command`, `dialog`, `dropdown-menu`, `input`, `input-group`, `kbd`, `scroll-area`, `separator`, `sonner`, `tabs`, `textarea`, `tooltip`. [VERIFIED: filesystem]

**Custom components:**
- `app-shell/` — `BrandMark`, `NavItem`, `Sidebar`, `Topbar`, `UserMenu`
- `badge/BolagBadge` — Tale Forge / Outbehaving / Personal tint pills
- `entity/EntityLink` — `.ent` styled inline link
- `palette/CommandPalette` + `palette-context` + `palette-root`
- `pwa/serwist-provider` — service worker for offline
- `system/LiveRegion` — aria-live announcer for SSE
- `system/OfflineBanner`
- `system/PulseDot` — single pulsing-dot motion primitive (replaces all skeletons per D-12 03-UI-SPEC)
- `system/SseProvider` — `useSseKind` hook + EventSource manager with exponential backoff

**Missing primitives Phase 11 needs (install via shadcn CLI):**
- `progress` — for channel-health bars + token usage indicator
- `sheet` — for the persistent chat bubble drawer (Phase 11-ter shell)
- `accordion` — possibly for grouped activity feed sections (optional)
- `badge` — for classification pills (or build custom — `BolagBadge` pattern is the local idiom)
- `popover` — for hover-detail on stat tiles

[CITED: Context7 `/shadcn-ui/ui` Apr-2026 docs — `npx shadcn@latest add progress sheet badge popover` works on Next 15 + React 19 + Tailwind v4]

### dashboard-api endpoints (services/dashboard-api/src)

| Method | Route | Handler file | Status | Phase 11 action |
|--------|-------|--------------|--------|----------------|
| GET | `/today` | `handlers/today.ts` | LIVE — Notion brief + Notion Command Center top 3 + RDS inbox_index draft_reply pending + RDS entity_index dropped + meetings:[] | Extend: union "today's captures" from email_drafts + capture_text + capture_voice + transcripts + chrome_highlights tables |
| GET | `/entities/list` | `handlers/entities.ts` | LIVE | Add `?counts=1` mode (sidebar already calls this — degraded to zero today per layout.tsx fallback) |
| GET | `/entities/:id` | `handlers/entities.ts` | LIVE | None |
| POST | `/entities/:id` | `handlers/entities.ts` | LIVE — edit fields → Notion update | None |
| GET | `/entities/:id/timeline` | `routes/entity-timeline.ts` (Phase 6) | LIVE | None |
| GET | `/inbox` | `handlers/inbox.ts` | LIVE — only `inbox_index` rows in `status='pending'` | None (legacy; dashboard prefers /inbox-merged) |
| POST | `/inbox/:id/approve` | `handlers/inbox.ts` | LIVE | None |
| POST | `/inbox/:id/edit` | `handlers/inbox.ts` | LIVE | None |
| POST | `/inbox/:id/skip` | `handlers/inbox.ts` | LIVE | None |
| GET | `/inbox-merged` | `routes/inbox.ts` | LIVE — UNIONs email_drafts (status IN ['draft','edited']) + agent_dead_letter (retried_at IS NULL). **DOES NOT include inbox_index** despite doc comment claiming so. | **D-05:** drop status filter on email_drafts → show all classifications. **Bug-fix:** ALSO union inbox_index rows so single endpoint serves all kinds. |
| POST | `/entities/:id/merge` + `/merge/resume` | `handlers/merge.ts` + `handlers/notion-merge.ts` | LIVE (Phase 8) | None |
| POST | `/capture` | `handlers/capture.ts` | LIVE | None |
| GET | `/calendar/week` | `handlers/calendar.ts` | LIVE — Command Center Notion ONLY | **Phase 11:** UNION with `calendar_events_cache` table populated by calendar-reader Lambda (Phase 8 calendar-reader pushes to RDS but `/calendar/week` doesn't read it yet). |
| GET | `/integrations/health` | **DOES NOT EXIST** | NEW | Phase 11 adds. Reads `agent_runs` for last-success per agent + scheduler_runs for last-tick per scheduler. |
| GET | `/email-drafts/:id` + POST `/approve`/`/edit`/`/skip` | `routes/email-drafts.ts` | LIVE (Phase 4) | None |

### Inbox kind values (verified from migration 0008)

```
'draft_reply', 'entity_routing', 'new_entity', 'merge_resume'
```

Inbox status values: `'pending', 'approved', 'skipped', 'rejected', 'archived'`. Dashboard renders `kind`-discriminated; Phase 11 needs to add `'classified_email'` (or extend `'draft_reply'` semantics) for non-urgent classified emails to appear with a read-only pill — tracked under D-05.

### email_drafts state machine

Verified from `services/email-triage/src/persist.ts:51-59`:
```ts
type EmailClassification = 'urgent' | 'important' | 'informational' | 'junk';
type EmailDraftStatus =
  | 'pending_triage'  // inserted, agent hasn't run yet
  | 'draft'           // urgent → has draft_body, awaits approval
  | 'edited'          // operator opened in Edit mode
  | 'approved'        // approved → email-sender Lambda will fire
  | 'skipped'         // operator skipped OR classification was non-urgent
  | 'sent'            // SES SendRawEmail succeeded
  | 'failed';         // sender error
```

**Pill mapping for D-05** (classification × status → visual):
| Classification | Status | Pill | Color | Action surface |
|---|---|---|---|---|
| urgent | draft | "URGENT — Draft ready" | red | Approve/Edit/Skip |
| urgent | edited | "URGENT — Edited" | orange | Approve/Skip |
| urgent | approved | "URGENT — Sending…" | blue | (read-only, transient) |
| urgent | sent | "URGENT — Sent" | green | (read-only, transient) |
| urgent | failed | "URGENT — Failed" | red | Retry |
| important | * | "Important" | blue | (read-only) |
| informational | * | "FYI" | gray | (read-only) |
| junk | * | "Junk" | dim gray | (read-only, dismiss) |
| any | pending_triage | "Triaging…" | dim blue | (read-only, animated dot) |
| any | skipped | "Skipped" | dim gray | (read-only) |

### Migration history (packages/db/drizzle/)

```
0001_initial          — entity_index + project_index + mention_events + capture_text + capture_voice + agent_runs
0002_hnsw_index       — pgvector HNSW
0003_cohere_embedding — 1024-dim
0004_pg_trgm_indexes
0005_kos_inbox_cursor
0006_embed_hash
0007_entity_merge_audit
0008_inbox_index      — Phase 3
0009_listen_notify_triggers
0010_entity_timeline_indexes
0011_dashboard_roles
0012_phase_6_dossier_cache_and_timeline_mv
0014_phase_7_top3_and_dropped_threads
0015_kos_agent_writer_role
0016_phase_4_email_and_dead_letter   — email_drafts, email_send_authorizations, agent_dead_letter
0017_phase_4_email_sender_role
0018_phase_4_email_triage_role
0019_phase_5_messaging
0020_phase_8_content_mutations_calendar_documents  — content_drafts, mutation_*, calendar_events_cache, document_versions
0021_phase_10_migration_audit
```

(No 0013 in tree — gap intentional or pre-applied; not blocking.)

### Auth flow (current)

1. User hits any `/(app)/*` route.
2. `middleware.ts` checks `kos_session` cookie via `constantTimeEqual()` against `KOS_DASHBOARD_BEARER_TOKEN` env.
3. Mismatch → 302 `/login?return=<path>`.
4. `/login` POSTs to `/api/auth/login` which sets cookie.
5. RSC handlers use `callApi(path, init, schema)` from `@/lib/dashboard-api` which sends `Authorization: Bearer ${KOS_DASHBOARD_BEARER_TOKEN}` (env var) directly to dashboard-api Lambda Function URL (no SigV4 anymore — switched 2026-04-24).
6. dashboard-api Lambda's handler does its own `verifyBearer()` check; mismatch → 401.
7. Client components don't directly call dashboard-api — they call `/api/...` Vercel route handlers which wrap callApi.

[VERIFIED: middleware.ts, dashboard-api.ts, services/dashboard-api/src/index.ts]

### SSE refresh pattern

```tsx
// In any client component:
import { useSseKind } from '@/components/system/SseProvider';
const router = useRouter();
useSseKind('inbox_item', () => router.refresh());
```

`SseProvider` opens a single `EventSource('/api/stream')` per tab. The Vercel `/api/stream` handler proxies to dashboard-listen-relay with 25s long-poll, 15s heartbeat, 280s deadline before graceful reconnect. Backoff on error: 500ms → 5s exponential. Available kinds (from contracts): `'inbox_item' | 'entity_merge' | 'capture_ack' | 'draft_ready' | 'timeline_event'`. **Phase 11 adds no new kinds** — every page just calls `useSseKind('inbox_item', refresh)` to re-fetch on any inbox change.

### Project Constraints (from CLAUDE.md)
- Single-user (Kevin). No teams, no shared accounts, no permission system.
- AWS-primary; eu-north-1 for data; us-east-1 for Bedrock.
- TypeScript monorepo (no Python in dashboard/api).
- Drizzle ORM v0.30+ with raw `sql` for joins not yet typed.
- shadcn primitives via `npx shadcn@latest add` (don't hand-write Radix wrappers).
- Tailwind v4 with `@theme {}` directive.
- Zod 3.23.8 monorepo-wide; **don't upgrade** to v4 here.
- No iOS/Discord/WhatsApp captures (Kevin: "fuck whatsapp").
- Calm-by-default; ADHD UX; no notification fatigue.
- WCAG AA contrast on text.
- Sentry already wired (`@sentry/nextjs` + `@sentry/aws-serverless`).
- GSD workflow: don't direct-edit; route through GSD commands.
- Stay within ~$200-280/month steady state.

## Implementation Approach

### Workstream A — Visual Rebuild (mission-control aesthetic)

**Decision: Layer, don't replace.** Keep the entire 03-UI-SPEC token system in `globals.css`. Add a new section (or new file `mission-control.css`, imported from `globals.css`) with the mission-control primitives.

**Alternatives considered:**
- Replace `globals.css` wholesale with mission-control's `index.css` — REJECTED. The current tokens encode a thoughtful design language (`--color-bg: #0a0c11`, restrained violet `#7c5bff`, Geist fonts, type scale, motion primitives) and are 1:1 with 03-UI-SPEC. Replacing destroys Phase 3's accessibility + ADHD calm-by-default work.
- Port mission-control's `.macos-panel` glass-morphism to KOS — REJECTED. Mission-control's 80px backdrop blur + saturate 200% looks beautiful but eats GPU on a long Today page; we already have a flat-card aesthetic that's calmer.
- Adopt framer-motion `<motion.div>` for all panels with hover-lift — REJECTED. KOS already constrains motion (single sanctioned `.cal-event:hover` transform per UI-SPEC line 428). Mission-control's whole-app hover-scale violates that contract.

**Concrete additions** (extend `globals.css` or new `mission-control.css`):
- `.mc-stat-tile` — caps-label + giant numeric value tile (wraps `<Card>` shadcn primitive)
- `.mc-priority-row` — priority-numbered row with hover-actions (extend existing `.pri-row`/`.pri-num` already in globals.css for Today!)
- `.mc-channel-bar` — horizontal channel-health row with colored dot + ago-time
- `.mc-chat-bubble` — fixed bottom-right floating button (44x44, rounded-full)
- `.mc-chat-sheet` — Sheet drawer that opens from chat bubble
- `.mc-pill` — generic colored-dot+label status pill (extend BolagBadge pattern)

**Existing primitives to reuse:**
- `.pri-row`, `.pri-num`, `.pri-title`, `.pri-meta`, `.pri-actions` — ALREADY in globals.css for Today's Priority list. Mission-control's "activity feed" is the same shape; we extend, not duplicate.
- `.brief`, `.draft-card`, `.side-card`, `.thread-row`, `.thread-avatar`, `.thread-title`, `.thread-meta`, `.count-chip` — Today view primitives (Plan 03-08).
- `.ai-block`, `.pstat-label`, `.pstat-value`, `.tl-snippet` — Entity dossier primitives (Plan 03-10).
- `.cal-event`, `.week-grid`, `.week-th`, `.week-time`, `.week-cell` — Calendar primitives.
- `.bolag-tf`, `.bolag-ob`, `.bolag-pe` — bolag tints.

### Workstream B — Demo Data Wipe + Re-Seeding Safeguard

**Decision (D-04): Option (b) — startup guard in dashboard-api.** Cheapest, fastest, fail-loud.

**Alternatives considered:**
- (a) **DB CHECK constraint with `kos.environment=prod` GUC** — REJECTED. Requires migration + GUC management + complicates local dev where these names ARE valid (Damien is a real person Kevin has on his email — see HANDOFF "Damien" mentioned in send-emails-flow chat). The brief lists "Damien CARTER" as the demo (different last name) but the CHECK constraint can't distinguish full-name patterns reliably without per-row regex. False-positive risk too high.
- (c) **Migration script flag preventing dev seeds in prod** — REJECTED. There ARE no dev seed scripts. Repo-wide grep confirms: zero `INSERT INTO inbox_index ... VALUES (..., 'Damien Carter', ...)` anywhere in `services/`, `apps/`, `scripts/`, `packages/db/drizzle/`, `cdk.out`. The pollution came from a one-shot manual SQL session. There's nothing to "prevent" because no seed exists. (The names ARE in `services/content-writer-platform/test/agent.test.ts` and `services/azure-search-indexer-entities/test/handler.test.ts` as test fixtures — verified via grep — but these are vitest fixtures that never touch prod.)
- (b) **Dashboard-api startup guard** — WINNER. On Lambda init, run a single `SELECT 1 FROM inbox_index WHERE owner_id = $1 AND title IN (<seed names>) LIMIT 1`. If row found, log Sentry error + return 503 from every request. If empty, normal startup. Cost: ~5ms per cold start. Self-explanatory. Easy to remove if false-positive ever hits a real entity.

**Wipe SQL** (executed via bastion + SSM port-forward — bastion already deployed per HANDOFF; teardown is in operator todo):

```sql
BEGIN;
-- Pre-flight count, surfaces in psql output for evidence
SELECT 'inbox_index' AS tbl, COUNT(*) FROM inbox_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND title IN (
      'Damien Carter', 'Christina Larsson', 'Jan Eriksson', 'Lars Svensson',
      'Almi Företagspartner', 'Re: Partnership proposal', 'Re: Summer meeting',
      'Possible duplicate: Damien C.', 'Paused: Maria vs Maria Johansson',
      'Outbehaving angel investor'
    );

-- Same SELECT for email_drafts (subject column)
SELECT 'email_drafts' AS tbl, COUNT(*) FROM email_drafts
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND (
      subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
      OR draft_subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
    );

-- Same SELECT for agent_dead_letter (error_message column)
-- ...

-- DELETE only after operator visually confirms counts match expectation
-- (the plan should require operator-in-the-loop for the actual DELETE)
DELETE FROM inbox_index WHERE owner_id = '...'::uuid AND title IN (...);
DELETE FROM email_drafts WHERE owner_id = '...'::uuid AND (subject IN (...) OR draft_subject IN (...));
DELETE FROM agent_dead_letter WHERE owner_id = '...'::uuid AND error_message ILIKE ANY (ARRAY['%Damien Carter%', ...]);

-- Final count = 0 expected
SELECT COUNT(*) FROM inbox_index WHERE owner_id = '...'::uuid AND title IN (...);

COMMIT;  -- or ROLLBACK if counts wrong
```

**Owner-id constant:** `7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c` — verified in migration 0008 + `services/dashboard-api/src/owner-scoped.ts` (the OWNER_ID export).

### Workstream C — Inbox surfacing expansion (D-05)

**Code change** (single file): `services/dashboard-api/src/email-drafts-persist.ts:listInboxDrafts`. Drop the `AND status IN ('draft','edited')` clause. Order by `received_at DESC`. Bump limit to 100.

```sql
SELECT
  id::text AS draft_id, capture_id, from_email, subject,
  draft_subject, draft_body, classification, status, received_at::text
FROM email_drafts
WHERE owner_id = $1
  -- AND status IN ('draft','edited')  -- REMOVED in Phase 11 D-05
ORDER BY received_at DESC
LIMIT 100;
```

**Renderer change** (`apps/dashboard/src/app/(app)/inbox/InboxClient.tsx`): the optimistic remove on Approve still works for `draft`/`edited` rows. For `skipped`/`junk`/`informational`/`important` rows: hide Approve button, hide Skip button (already terminal), keep Edit only for `draft`/`edited`. Add classification pill in `ItemRow` from new `classification` field on the `MergedItemDraft` shape.

**Contract change** (`packages/contracts/src/dashboard.ts`): extend `InboxItemKindSchema` with `'classified_email'` OR (preferred) keep `kind: 'draft_reply'` and add an optional `classification` field. Less work, fewer renderer branches.

**`/inbox-merged` extension:** also UNION inbox_index rows (closes the doc-vs-code gap noted in CONTEXT). Single source for all 4 kinds.

### Workstream D — Live-data wiring per page

**`/today`:** Extend `services/dashboard-api/src/handlers/today.ts` to add a `captures_today` field that UNIONs:
- `email_drafts WHERE received_at::date = today AND owner_id = ?` (top 5)
- `capture_text WHERE created_at::date = today AND owner_id = ?` (Telegram text + Chrome highlights — both write to capture_text)
- `capture_voice WHERE created_at::date = today AND owner_id = ?` (Telegram voice → transcript JOIN)
- `mention_events WHERE source = 'granola' AND occurred_at::date = today AND owner_id = ?` (Granola transcripts processed today)
- `mention_events WHERE source = 'linkedin' AND occurred_at::date = today AND owner_id = ?` (LinkedIn DMs)
[VERIFIED: the existence of `capture_text`, `capture_voice`, `mention_events` tables in migration 0001; sources 'granola'/'linkedin' in current Phase 5/6 routing — but exact column names need confirmation during Wave 0]

**`/calendar`:** Extend `services/dashboard-api/src/handlers/calendar.ts:queryCommandCenter` to ALSO read from `calendar_events_cache` table (populated by calendar-reader Lambda — Plan 08-01) and merge by `(start_at, title)`. Calendar-reader emits to RDS every 30 min from both Google accounts (HANDOFF-2026-04-26 confirms it's polling).

**`/entities`:** Already wired. Visual upgrade only.

**`/chat`:** Add a new route `apps/dashboard/src/app/(app)/chat/page.tsx` that renders a "Coming in Phase 11-ter" placeholder + the floating bubble (`ChatBubble.tsx`) component. The bubble lives in the `(app)/layout.tsx` so it's persistent across all routes. Chat backend is NOT in scope.

**`/integrations-health`:** New route. RSC reads new dashboard-api endpoint `GET /integrations/health` that returns:
```json
{
  "channels": [
    { "name": "Telegram", "status": "healthy", "last_event_at": "2026-04-26T08:30:00Z", "type": "capture" },
    { "name": "Gmail (kevin.elzarka)", "status": "healthy", "last_event_at": "...", "type": "capture" },
    { "name": "Google Calendar", "status": "healthy", "last_event_at": "...", "type": "capture" },
    { "name": "Granola", "status": "healthy", "last_event_at": "...", "type": "capture" },
    { "name": "Chrome extension", "status": "healthy", "last_event_at": "...", "type": "capture" },
    { "name": "LinkedIn", "status": "healthy", "last_event_at": "...", "type": "capture" },
    ...
  ],
  "schedulers": [
    { "name": "morning-brief", "next_run_at": "...", "last_run_at": "...", "last_status": "ok" },
    ...
  ]
}
```

**Channel health derivation:** query `agent_runs` table (Phase 1 INF) for the most-recent successful row per agent_name. Definition of "healthy" = last success within 2× expected interval (Telegram = 1 day; Gmail = 30 min; Granola = 1 hour; etc.).

[ASSUMED: `agent_runs.agent_name` column shape suitable for last-run-per-channel queries — needs confirmation during planning Wave 0]

### Workstream E — Button audit (D-06)

Sweep targets (every interactive surface in `(app)/*`):

| Surface | Target | Action |
|---|---|---|
| Sidebar `T`/`I`/`C` shortcuts | router.push | KEEP (all wired) |
| Sidebar Chat link (disabled) | `disabled` + tooltip "Ships with Phase 4" | UPDATE: enable + route to new `/chat` shell |
| Sidebar Search (⌘K) | opens command palette | KEEP |
| Sidebar Settings link | routes to stub | DECIDE: wire (env channel toggles? token rotation?) OR remove until Phase 999.x |
| Sidebar Logout button | clears cookie + redirect | KEEP |
| Topbar (whatever it has) | inspect via TFS | AUDIT |
| `/today` Composer (voice/text dump) | `today/Composer.tsx` | AUDIT — does it actually POST to /capture? |
| `/today` PriorityList row click | navigates to entity OR ??? | AUDIT |
| `/today` DraftsCard "Approve" button | calls action | AUDIT |
| `/today` DroppedThreads click | navigates to /entities/[id] | AUDIT |
| `/today` Brief refresh button (if any) | router.refresh? | AUDIT |
| `/inbox` J/K/Enter/E/S | wired (D-11) | KEEP |
| `/inbox` D/A/R | RESERVED (no binding per UI-SPEC line 373) | KEEP RESERVATION; document |
| `/inbox` ItemDetail textarea + Save | Server Action | KEEP |
| `/entities` filter chips | href links | KEEP |
| `/entities/[id]` Edit button | opens EditEntityDialog | KEEP |
| `/entities/[id]/merge` Merge button | merge action | KEEP (Phase 8) |
| `/calendar` event click | ??? | AUDIT |
| `/login` Submit button | sets cookie | KEEP |
| Command palette result click | navigates | KEEP |

The audit IS the work — Phase 11 plans must enumerate every button discovered (current count is ~30) and assign each to KEEP / WIRE / REMOVE.

## Visual Pattern Reference (from /tmp/mission-control)

### Mission-Control source language — port table

The reference repo is React + Vite + Inline-styles + `framer-motion` + `lucide-react`. KOS is Next 15 + Tailwind v4 + CSS-in-globals + `framer-motion` + `lucide-react`. Same icon library, same animation library, different CSS strategy.

**Translation rules:**
| Mission-control pattern | KOS port |
|---|---|
| Inline `style={{ ... }}` props | Tailwind utility classes OR named CSS classes in `globals.css` |
| `GlassCard` with `backdrop-filter: blur(60px)` | shadcn `<Card>` primitive (no glass effect — calm-by-default) |
| `accent(COLORS.blue)` helper returning `{bg, border, bgHover}` | CSS `color-mix()` + `--color-info` token (already in globals.css) |
| `<StatusBadge status="active" pulse />` | New `<Pill tone="success" pulse />` component reusing `.pulse-dot` keyframe (already in globals.css) |
| `<AnimatedCounter end={42} />` | NEW: copy mission-control's component or use `framer-motion`'s `useMotionValue` + `useTransform` |
| `feedColors[item.type]` lookup | Type-discriminated mapping in TypeScript; render `<div className={'mc-feed-row'} data-type={item.type}>` + CSS attribute selectors |
| `macos-sidebar` brushed-metal gradient | Existing KOS `Sidebar.tsx` keeps its restrained dark slab |

### Concrete component shapes to lift

**Stat tile** (mission-control Dashboard.tsx lines 285-307; KOS port):

```tsx
// apps/dashboard/src/components/dashboard/StatTile.tsx
export function StatTile({ icon: Icon, label, value, color = 'accent' }: Props) {
  return (
    <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5">
      <div className="flex items-center gap-2 mb-2.5">
        <div className={cn(
          'w-7 h-7 rounded-lg flex items-center justify-center',
          color === 'accent' && 'bg-[color:var(--accent-bg)]',
          color === 'success' && 'bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)]',
        )}>
          <Icon size={14} />
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-3)]">
          {label}
        </span>
      </div>
      <p className="text-[28px] font-light text-[color:var(--color-text)] tabular-nums">
        {value}
      </p>
    </div>
  );
}
```

**Priority-numbered activity row** (mission-control dashboard activity feed → KOS port; reuses existing `.pri-row` already in globals.css for Today):

```tsx
<div className="priority-list">
  {feed.map((item, i) => (
    <div key={item.id} className="pri-row" data-priority={item.priority}>
      <span className="pri-num">{100 - i}</span>
      <div>
        <div className="pri-title">{item.title}</div>
        <div className="pri-meta">{item.source} · {timeAgo(item.time)}</div>
      </div>
      <div className="pri-actions">
        {item.actionable && <button onClick={...}>{item.actionLabel}</button>}
      </div>
    </div>
  ))}
</div>
```

**Channel health row:**

```tsx
<div className="flex items-center justify-between py-2 border-b border-[color:var(--color-border)]">
  <div className="flex items-center gap-2.5 min-w-0 flex-1">
    <Icon size={14} className="text-[color:var(--color-text-3)]" />
    <div>
      <p className="text-[12px] font-medium text-[color:var(--color-text)]">{channel.name}</p>
      <p className="text-[11px] text-[color:var(--color-text-3)]">{timeAgo(channel.last_event_at)}</p>
    </div>
  </div>
  <Pill tone={channel.status === 'healthy' ? 'success' : 'danger'}>{channel.status}</Pill>
</div>
```

**Persistent floating chat bubble:**

```tsx
// Mounted in (app)/layout.tsx alongside <Toaster />
<button
  type="button"
  onClick={() => setChatOpen(true)}
  className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-[color:var(--color-accent)] hover:bg-[color:var(--color-accent-2)] shadow-lg transition-colors flex items-center justify-center"
  aria-label="Open chat"
>
  <MessageSquare size={20} className="text-white" />
</button>

<Sheet open={chatOpen} onOpenChange={setChatOpen}>
  <SheetContent side="right" className="w-[400px]">
    <SheetHeader><SheetTitle>Chat with KOS</SheetTitle></SheetHeader>
    <div className="text-[13px] text-[color:var(--color-text-3)]">
      Coming in Phase 11-ter — AI chat backend not yet wired.
    </div>
  </SheetContent>
</Sheet>
```

## Data Layer

### Schema additions (none required for Phase 11)

All needed tables exist:
- `inbox_index` (Phase 3, mig 0008)
- `email_drafts`, `email_send_authorizations`, `agent_dead_letter` (Phase 4, mig 0016)
- `calendar_events_cache` (Phase 8, mig 0020)
- `agent_runs` (Phase 1, mig 0001)
- `capture_text`, `capture_voice`, `mention_events` (Phase 1+2)

### Endpoint additions

| Endpoint | Source | Purpose |
|---|---|---|
| `GET /integrations/health` | new file `services/dashboard-api/src/handlers/integrations.ts` | Channel + scheduler last-success snapshot |
| `GET /today` (extended) | edit `services/dashboard-api/src/handlers/today.ts` | UNION captures from all sources for today's date |
| `GET /calendar/week` (extended) | edit `services/dashboard-api/src/handlers/calendar.ts` | UNION Notion + calendar_events_cache |
| `GET /inbox-merged` (extended) | edit `services/dashboard-api/src/routes/inbox.ts` | drop status filter; add inbox_index rows |

### Read query for today's captures

```sql
WITH today_window AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AS d_start
)
-- Email drafts
SELECT 'email' AS source, id::text AS id, subject AS title, classification AS detail, received_at AS at
FROM email_drafts, today_window
WHERE owner_id = $1 AND received_at >= d_start
UNION ALL
-- Telegram + Chrome highlights (both write capture_text)
SELECT 'capture_text' AS source, id::text, source_kind AS title, body AS detail, created_at AS at
FROM capture_text, today_window
WHERE owner_id = $1 AND created_at >= d_start
UNION ALL
-- Telegram voice
SELECT 'capture_voice' AS source, id::text, 'voice' AS title, transcript AS detail, created_at AS at
FROM capture_voice, today_window
WHERE owner_id = $1 AND created_at >= d_start
UNION ALL
-- Mention events from Granola + LinkedIn etc.
SELECT 'mention' AS source, id::text, source AS title, detail, occurred_at AS at
FROM mention_events, today_window
WHERE owner_id = $1 AND occurred_at >= d_start
ORDER BY at DESC
LIMIT 50;
```

[ASSUMED: exact column names `source_kind`, `body`, `transcript`, `detail` on capture/mention tables — needs Wave 0 verification against schema]

### Channel health query

```sql
SELECT agent_name,
       MAX(finished_at) AS last_success_at,
       MAX(CASE WHEN status='ok' THEN finished_at END) AS last_ok_at
FROM agent_runs
WHERE owner_id = $1
GROUP BY agent_name;
```

Then for each known capture channel (`telegram-bot`, `gmail-poller`, `granola-poller`, `calendar-reader`, `linkedin-webhook`, `chrome-webhook`), compute health = `last_ok_at > now() - 2× expected_interval`.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hydration mismatch on theme tokens (SSR vs CSR) | LOW | Medium | Tokens are CSS custom properties only, never JS-driven. No `useState` color flicker. Use `next-themes` only if dark/light toggle ships (NOT in this phase). |
| SSE reconnect storm when many pages subscribe | LOW | Low | Single `EventSource` per tab via `SseProvider` + 500ms→5s exponential backoff already wired. New pages just add `useSseKind` hooks; no extra connections. |
| Tailwind v4 breaking change vs v3 patterns | LOW | Low | Already on v4 (4.2.4) and shipped Phase 3 — no patterns to migrate. shadcn confirms v4 + React 19 stable per Apr-2026 docs. |
| shadcn primitive incompatibility with React 19 | LOW | Low | Apr-2026 Context7 docs confirm `npx shadcn@latest` initializes React 19 by default. New components install cleanly into a v4 project. |
| Wipe SQL deletes real Kevin data | MEDIUM | HIGH | Mandatory `BEGIN; SELECT count; <human review>; DELETE; SELECT count; COMMIT;` flow. Names matched on EXACT title (no LIKE/ILIKE), not first/last fragments. Pre-flight COUNT must equal expected (10 names) before COMMIT. |
| Channel health endpoint is wrong because `agent_runs` schema differs | MEDIUM | LOW | Wave 0 task: `\d+ agent_runs` over bastion psql; adjust query. If `agent_name` doesn't disambiguate channels, derive from `inputJson` payload or extend agent_runs writers (out-of-scope hack). |
| Demo names match a real Kevin contact | LOW | HIGH | Kevin enumerated the names manually in CONTEXT D-03; confidence is high. The startup-guard (D-04 option b) acts as belt-and-suspenders. |
| Calendar UNION duplicates events (same title appears in Notion CC + Google) | MEDIUM | MEDIUM | UPSERT on `(date_trunc('minute', start_at), title)` in the read query, prefer `calendar_events_cache` source over Notion if both present (Google is canonical for actual meetings; Notion CC is canonical for deadlines). |
| Button audit incomplete; ships with broken buttons | MEDIUM | MEDIUM | Phase 11 PLAN.md must enumerate every interactive surface in a checklist. Plan-checker rejects PLAN.md if any button is "left ambiguous". |
| Vercel build fails on new shadcn deps | LOW | LOW | shadcn just adds source files into `components/ui/` — no new package deps. `radix-ui` already in package.json. |
| Old `/inbox-merged` clients break when status filter drops | LOW | LOW | Only consumer is the Phase 11 dashboard itself. Backward-compat: contract grows a new `classification` field; renderers ignoring it just see same kinds. |
| Persistent chat bubble z-index conflicts with shadcn Toaster (top-right) | LOW | LOW | Bubble bottom-right; Toaster top-right; no overlap. |

## Validation Architecture

> Including this section per workflow.nyquist_validation: true.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.4 (unit) + Playwright 1.51.1 (e2e) |
| Config files | `apps/dashboard/vitest.config.ts`, `apps/dashboard/playwright.config.ts`, services use root `vitest.config.ts` |
| Quick run command | `pnpm -F @kos/dashboard test` |
| Full e2e command | `pnpm -F @kos/dashboard e2e` |
| Lighthouse | `pnpm -F @kos/dashboard lhci` (LHCI 0.14 already configured) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| REQ-1 | `/today` renders with stat tiles + channel health + captures-today list | unit | `pnpm -F @kos/dashboard test src/app/\(app\)/today/TodayView.test.tsx` | ❌ Wave 0 |
| REQ-1 | `/today` aggregates captures from email + capture_text + capture_voice + mention_events | integration | `pnpm -F @kos/dashboard-api test tests/today.test.ts` | ✅ exists; needs extension |
| REQ-1 | `/today` SSR with zero data renders calmly (D-12) | e2e | `pnpm -F @kos/dashboard e2e --grep "today empty state"` | ❌ Wave 0 |
| REQ-3 | Visual regression — every page snapshot matches mission-control aesthetic baseline | e2e snapshot | `pnpm -F @kos/dashboard e2e --grep "visual"` | ❌ Wave 0 — requires Playwright `toMatchScreenshot` baselines |
| REQ-3 | LCP < 2500ms, INP < 200ms on /today | lhci | `pnpm -F @kos/dashboard lhci` | ✅ already wired |
| REQ-12 | Inbox surfaces all classifications (urgent/important/informational/junk) with pills | unit | `pnpm -F @kos/dashboard-api test tests/email-drafts.test.ts -t "all classifications"` | ✅ exists; extend |
| REQ-12 | Approve/Edit/Skip Server Actions still work end-to-end | e2e | `pnpm -F @kos/dashboard e2e --grep "inbox approve"` | ❌ Wave 0 |
| REQ-12 | Keyboard J/K/Enter/E/S still navigates after redesign | e2e | `pnpm -F @kos/dashboard e2e --grep "inbox keyboard"` | ❌ Wave 0 |
| Phase | Demo names absent from prod after wipe | smoke | `psql -c "SELECT count(*) FROM inbox_index WHERE title IN (...)"` returning 0 | ❌ Wave 0 — write `scripts/verify-phase-11-wipe.sh` |
| Phase | Real Telegram capture appears in /today within 30s | manual+e2e | Operator script: send Telegram → poll `/today` for 30s | ❌ Wave 0 |
| Phase | Every button on every page either fires a request OR is removed | e2e | `pnpm -F @kos/dashboard e2e --grep "button audit"` parametric over `data-testid` registry | ❌ Wave 0 |
| Phase | Empty state regression (each page renders with zero data) | unit | `pnpm -F @kos/dashboard test --grep "empty state"` parametric | ❌ Wave 0 |
| Phase | Bundle size budget — no new heavy deps (e.g., d3, recharts) | size-limit | Add `size-limit` to package.json scripts | ❌ Wave 0 (optional) |

### Sampling Rate

- **Per task commit:** `pnpm -F @kos/dashboard typecheck && pnpm -F @kos/dashboard test`
- **Per wave merge:** `pnpm -r typecheck && pnpm -r test && pnpm -F @kos/dashboard e2e`
- **Phase gate:** All e2e green + LHCI passes thresholds + `verify-phase-11-wipe.sh` returns 0 + manual smoke (send Telegram capture, see in /today)

### Wave 0 Gaps

- [ ] `apps/dashboard/tests/e2e/inbox.spec.ts` — covers REQ-12 keyboard + classification pills
- [ ] `apps/dashboard/tests/e2e/today.spec.ts` — covers REQ-1 stat tiles + captures list
- [ ] `apps/dashboard/tests/e2e/visual.spec.ts` — Playwright `toMatchScreenshot` baselines for /today, /inbox, /entities, /calendar, /integrations-health
- [ ] `apps/dashboard/tests/e2e/button-audit.spec.ts` — parametric click test over a data-testid registry
- [ ] `apps/dashboard/tests/e2e/empty-states.spec.ts` — auth as test user with empty DB; render every page
- [ ] `services/dashboard-api/tests/integrations-health.test.ts` — agent_runs aggregation
- [ ] `services/dashboard-api/tests/today.test.ts` — extend with capture sources
- [ ] `services/dashboard-api/tests/calendar.test.ts` — extend with calendar_events_cache UNION
- [ ] `scripts/verify-phase-11-wipe.sh` — demo-names-absent assertion, exits non-zero if any found
- [ ] `services/dashboard-api/tests/seed-pollution-handler.test.ts` — Vitest handler-integration test asserting 503 when seed pollution detected, non-503 when clean (replaces the originally-planned `scripts/verify-startup-guard.mjs` per checker feedback — avoids global-mutation hatch in production db.ts)

## Open Questions (RESOLVED)

1. **agent_runs schema for channel-health derivation.**
   - **RESOLVED (Wave 0 / Plan 11-00):** Wave 0 schema-verification task ran `SELECT DISTINCT agent_name, COUNT(*) FROM agent_runs GROUP BY 1` over the bastion and confirmed `agent_name` granularity is sufficient (per-channel rows: telegram-bot, gmail-poller, granola-poller, calendar-reader, etc.). No `channel_health` table required — derivation lives in `services/dashboard-api/src/handlers/integrations.ts` (Plan 11-06).
   - What we know: `agent_runs` exists since migration 0001; columns include `agentName`, `inputHash`, `outputJson`, `status`, `startedAt`, `finishedAt`, `captureId` (per usage in `inbox.ts:138-150`).
   - What's unclear: Is `agent_name` granular enough to map to channels? E.g., does the gmail-poller write `agent_name='gmail-poller'`? Does telegram-bot write its own row?
   - Recommendation: Wave 0 task — `psql -c "SELECT DISTINCT agent_name, COUNT(*) FROM agent_runs GROUP BY 1 ORDER BY 1"` over bastion. If granularity insufficient, derive from `outputJson->>'channel'` payload OR add a separate `channel_health` table that each channel writes to (heavier; defer).

2. **`capture_text` column shape.**
   - **RESOLVED (Wave 0 / Plan 11-00):** `\d+ capture_text` over bastion verified column names; verified shape recorded in `11-WAVE-0-SCHEMA-VERIFICATION.md`. Plans 11-04 and 11-05 reference that doc as the source of truth for UNION queries.
   - What we know: Phase 1 mig 0001 introduced this table; Telegram and Chrome both write to it.
   - What's unclear: Is there a `source_kind` discriminator column or do they share a single text body? Need to verify before writing the today aggregation query.
   - Recommendation: Wave 0 — `\d+ capture_text` over bastion.

3. **Settings page scope (D-06 button audit).**
   - **RESOLVED (Plan 11-07):** Phase 11 Plan 11-07 implements the button-audit + settings-wiring decision. Per the recommendation below, sidebar links that don't yet wire to a working surface are removed (D-06 'wire or remove' — remove path chosen for Phase 11; future polish phase may add back).
   - What we know: Currently a stub. The sidebar links to it.
   - What's unclear: Does Phase 11 wire Settings to something useful (env channel toggles, token refresh, manual scheduler trigger) or REMOVE the link (D-06 says "wire or remove")?
   - Recommendation: Plan-time decision. If wiring: surface (a) Telegram bot token rotation, (b) channel-toggle (disable LinkedIn polling temporarily), (c) "Run scheduler now" buttons (morning-brief, day-close). If removing: hide sidebar link until Phase 999.x.

4. **Inbox kind: extend `'draft_reply'` vs add `'classified_email'`.**
   - **RESOLVED (recommendation adopted):** Add optional `classification` field to existing `'draft_reply'` kind; renderers branch on classification. Cheaper than a new kind. Migration: zero (zod schema additive change). Implemented in Plan 11-03 (InboxItemSchema extension).
   - What we know: Contract `InboxItemKindSchema` has 4 values today.
   - What's unclear: D-05 wants ALL classified emails surfaced. Two contract paths.
   - Recommendation: Add optional `classification` field to existing `'draft_reply'` kind; renderers branch on classification. Cheaper than new kind. Migration: zero (zod schema additive change).

5. **Wipe execution venue.**
   - **RESOLVED (Wave 0 / Plan 11-00):** Plan-time bastion-reachability check completed in Wave 0; if not reachable, `cdk deploy KosData --context bastion=true` re-provisions in ~5 min. Plan 11-01 Task 3 (operator checkpoint) executes the wipe through the bastion + SSM port-forward flow.
   - What we know: Bastion already deployed for Phase 4 work; teardown is on operator todo.
   - What's unclear: Is the bastion still reachable? Or do we need a fresh `cdk deploy --context bastion=true`?
   - Recommendation: Plan-time check via `aws ec2 describe-instances --filters Name=tag:Name,Values=KosBastion`. If gone, re-provision is 5 min.

6. **Startup-guard placement (Lambda init vs first-request).**
   - **RESOLVED (recommendation adopted):** Lambda handler entry (post-bearer-check, pre-route). Implemented in Plan 11-01 Task 2 — see `services/dashboard-api/src/index.ts` integration. Cost: ~5ms per cold start, cached for warm container lifetime; fail-loud with HTTP 503.
   - Recommendation: Lambda init (module-scope IIFE on cold start). Cost: ~1 SELECT per cold start (~ms). Fail-loud: throws → init failure → next invocation tries again, every 1 in N requests sees a 503. Aggressive enough that operator notices. Logged to Sentry as `dashboard-api-seed-pollution-detected`.

## Sources

### Primary (HIGH confidence)
- Filesystem inspection: `apps/dashboard/src/**`, `services/dashboard-api/src/**`, `packages/contracts/src/**`, `packages/db/drizzle/**` (every file referenced above)
- `.planning/HANDOFF-2026-04-26-FULL-DAY.md` — current live state
- `.planning/STATE.md` — locked decisions across all phases
- `.planning/phases/11-frontend-rebuild-real-data-wiring-button-audit-mission-contr/11-CONTEXT.md` — phase decisions
- `CLAUDE.md` — stack constraints
- `/tmp/mission-control/frontend/src/{pages/Dashboard.tsx, components/GlassCard.tsx, components/StatusBadge.tsx, components/Sidebar.tsx, index.css}` — visual reference
- Context7 `/shadcn-ui/ui` — confirmed `npx shadcn@latest add` works on Next 15 + React 19 + Tailwind v4 (Apr-2026 docs)

### Secondary (MEDIUM confidence)
- shadcn/ui Apr-2026 release notes — confirmed React 19 + Tailwind v4 support is stable, non-breaking on existing v3 projects
- Repo-wide `grep -rln "Damien|Christina|Jan Eriksson|..."` — confirmed seed names appear ONLY in `services/content-writer-platform/test/agent.test.ts` + `services/azure-search-indexer-entities/test/handler.test.ts` (test fixtures, not prod paths) and in `CLAUDE.md` (description string only). Zero hits in `scripts/`, `migrations/`, or any prod code path.

### Tertiary (LOW confidence — flagged for Wave 0)
- `agent_runs` schema granularity for channel-health derivation (Open Question 1)
- `capture_text` column shape (Open Question 2)
- Bastion still reachable (Open Question 5)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `agent_runs.agent_name` column granular enough to derive per-channel health | Workstream D + Data Layer | Wave 0 verification fails → must extend agent_runs writers (out-of-scope) OR build a `channel_health` table. ~0.5 day rework. |
| A2 | `capture_text`/`capture_voice` column shapes match the today-aggregation query | Data Layer (today's captures SQL) | SQL throws on first hit. Catch in `services/dashboard-api/tests/today.test.ts` extension. ~30 min fix. |
| A3 | Bastion + SSM port-forward still reachable as of plan execution | Workstream B (wipe) | Re-provision: `cdk deploy KosData --context bastion=true` — 5 min added to first wave. |
| A4 | Demo names appear ONLY in test fixtures + CLAUDE.md description, never in prod-write paths | Workstream B (D-04 mechanism choice) | Repo-wide grep confirms; if a write path is found, switch to (a) DB CHECK constraint instead of (b) startup guard. |
| A5 | shadcn `progress`/`sheet`/`badge`/`popover` add cleanly to Next 15 + React 19 + Tailwind v4 | Current State Inventory + Implementation Approach A | Confirmed via Context7. If add fails, fallback to hand-rolled Radix wrappers (radix-ui already in package.json). |
| A6 | Visual SSR matches CSR (no hydration mismatch) when using only CSS custom properties | Risks & Mitigations | Theme palette is CSS-only; risk is near-zero. If a future phase adds JS-driven theme switching, revisit. |
| A7 | `email_drafts.classification` column always populated by Phase-11 plan execution time | Implementation Approach C + pill mapping | Verified — `updateEmailDraftClassified` always sets a non-null classification before status changes from `pending_triage`. Pill mapping already handles `pending_triage` as "Triaging…". |
| A8 | Calendar-reader Lambda's `calendar_events_cache` table is being populated continuously (HANDOFF says yes) | Workstream D — /calendar | Verified — STATE.md "Live RIGHT NOW" table lists Google Calendar 30-min polling as live + verified. |

**Empty assumption table?** No — 8 assumptions flagged. Wave 0 schema verification (A1, A2) is the highest-leverage cheap risk reduction.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions in `package.json` verified; shadcn/Tailwind v4/React 19 compatibility confirmed via Context7
- Architecture: HIGH — entire codebase inspected; layer-by-layer responsibility map grounded in real files
- Pitfalls: MEDIUM — risks named are real; some (channel-health derivation) need Wave 0 verification
- Visual reference: HIGH — mission-control source read directly; ports translated 1:1

**Research date:** 2026-04-26
**Valid until:** 2026-05-26 (stable codebase; only risk is shadcn breaking change)

## RESEARCH COMPLETE
