---
phase: 3
slug: dashboard-mvp
status: draft
shadcn_initialized: false
preset: manual (tokens ported from TFOS-ui.html via Tailwind v4 @theme)
created: 2026-04-23
canonical_visual_spec: TFOS-ui.html (repo root, 2102 lines)
mode: --auto (no user questions; defaults from CONTEXT.md D-01..D-41 + TFOS-ui.html :root)
---

# Phase 3 — UI Design Contract

> Visual and interaction contract for the KOS Dashboard MVP. This file is a faithful translation of `TFOS-ui.html` (the committed, production-quality HTML prototype that Kevin authored) into a machine-consumable contract. Tokens are copied verbatim from `TFOS-ui.html` `:root`; layout and motion decisions are enumerated per-view. Downstream planners and executors MUST read `TFOS-ui.html` side-by-side with this spec — this file is the extraction, the HTML is the source of truth.

**Binding upstream decisions:** CONTEXT.md D-07 (`TFOS-ui.html` is canonical), D-08 (Tailwind v4 `@theme`), D-09 (shadcn/ui primitives), D-10 (cmdk), D-11 (Geist fonts via `next/font/google`), D-12 (motion principles binding).

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn/ui CLI (component source-copy); tokens via Tailwind v4 `@theme` — **NOT** a named shadcn preset |
| Preset | not applicable — manual port of `TFOS-ui.html` `:root` to `apps/dashboard/src/app/globals.css` |
| Component library | shadcn/ui (Radix primitives) + Tailwind CSS v4 |
| Icon library | `lucide-react` (shadcn default); no emoji-as-icon overload |
| Font | `Geist` (UI) + `Geist Mono` (IDs, timestamps, kbd), both via `next/font/google`; `font-feature-settings: "cv11", "ss01", "ss03"` |
| Theme | Dark-only. Surface `#0a0c11`. No light-theme support in Phase 3. |
| Max content width | 1280px container (`max-width: 1280px; margin: 0 auto; padding: 0 32px`) |
| App shell | 220px sidebar + 1fr main; 52px topbar; `border-radius: var(--r-2xl)` app frame with subtle drop shadow (only on frame — never on interior cards) |

**Token definition file (to create):** `apps/dashboard/src/app/globals.css` — Tailwind v4 `@theme` block mirroring `TFOS-ui.html` `:root` 1:1. CSS variables stay as CSS variables (not renamed) so mockup HTML can be pasted in for parity checks during development.

---

## Color Tokens (verbatim from `TFOS-ui.html` lines 12–72)

### Surfaces

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0a0c11` | App background (outside app frame) |
| `--surface-1` | `#11141b` | Sidebar, topbar, cards, primary content surface |
| `--surface-2` | `#161a23` | Titlebar, search input, secondary button, nested card |
| `--surface-3` | `#1c2029` | Badge background, icon button, count chip |
| `--surface-hover` | `#1f2430` | Row hover (nav items, priority rows, thread rows) |

### Borders

| Token | Value | Usage |
|-------|-------|-------|
| `--border` | `#232732` | Default border on cards, inputs, separators |
| `--border-hover` | `#2d3340` | Hover border (interactive elements) |
| `--border-strong` | `#383e4d` | Focus ring, emphasized divisions |

### Text

| Token | Value | Usage |
|-------|-------|-------|
| `--text` | `#e7eaf0` | Primary body text, titles |
| `--text-2` | `#b1b6c2` | Secondary text (meta rows, preview text, descriptions) |
| `--text-3` | `#71768a` | Tertiary text (monospace IDs, timestamps, meta labels) |
| `--text-4` | `#4d5263` | Quaternary (nav group labels, kbd text) |

### Accent (restrained violet — the only brand color)

| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#7c5bff` | Primary button bg, brand mark gradient start, entity-link hover, section eyebrow |
| `--accent-2` | `#9d80ff` | Primary button hover, active-nav text, entity-link default, brand mark gradient end |
| `--accent-bg` | `rgba(124, 91, 255, 0.10)` | Active nav background, AI block background, selection highlight |
| `--accent-border` | `rgba(124, 91, 255, 0.25)` | Entity-link dotted underline, AI block border |

### Status (desaturated — per §Avoids "#34D399 not #00FF88")

| Token | Value | Usage |
|-------|-------|-------|
| `--success` | `#34d399` | Completed badges, brief pulsing dot, status indicator |
| `--warning` | `#fbbf24` | High-priority dot, deadline-approaching badge |
| `--danger` | `#f87171` | Urgent priority dot, destructive action copy, error state |
| `--info` | `#38bdf8` | Informational badges (also `--tale-forge`) |
| `--pink` | `#f472b6` | Reserved — use sparingly; not required for Phase 3 in-scope views |

### Bolag (company) tints — data source: `entity_index.org` / `project_index.bolag`

| Token | Value | Mapped to |
|-------|-------|-----------|
| `--tale-forge` | `#38bdf8` (sky-blue) | `org = "Tale Forge"` or `"tale-forge"` |
| `--outbehaving` | `#fb923c` (orange) | `org = "Outbehaving"` or `"outbehaving"` |
| `--personal` | `#a78bfa` (violet) | `org = "Personal"` or null / unmapped |

Rendered as `.badge.bolag-tf`, `.badge.bolag-ob`, `.badge.bolag-pe` with matching 0.06 alpha fill + 0.18 alpha border. Also used on calendar event bars and sidebar section chips.

### 60 / 30 / 10 Split

- **60% dominant:** `--bg` (#0a0c11) + `--surface-1` (#11141b). Dark neutral palette across app background, sidebar, main pane.
- **30% secondary:** `--surface-2` / `--surface-3` + `--text-2` / `--text-3`. Cards, inputs, secondary buttons, meta text.
- **10% accent:** `--accent` / `--accent-2` — reserved exclusively for:
  1. Brand mark gradient (sidebar, login splash)
  2. Primary CTA button fill (Approve, Send reply, Confirm merge)
  3. Active sidebar nav item (background + text)
  4. Entity links (`.ent` — dotted underline + hover fill)
  5. Command palette selected row
  6. Focus ring (`:focus-visible` outline)
  7. AI block accent border + eyebrow label
  8. Selection highlight (`::selection`)

Accent is NEVER used on: generic hover states, borders of ordinary cards, icon buttons, count chips, badges (except command-palette-selected), or status dots.

### Destructive

- `--danger` (#f87171) is the semantic destructive color. Used for: urgent priority dot, Revert/Cancel-merge button text (ghost button with danger text), delete confirmation dialog headline. Destructive primary buttons use `--danger` as background with white text — but Phase 3 has no such primary destructive action (see §Copywriting).

---

## Typography (verbatim from `TFOS-ui.html` `:root --fs-*`)

### Scale

| Token | Size | Role | Weight | Line Height |
|-------|------|------|--------|-------------|
| `--fs-xs` | 11px | Section eyebrow labels, nav-group labels, kbd text, badge text, meta rows | 600 (eyebrow/section) / 500 (badge) | 1.4 |
| `--fs-sm` | 12px | Meta rows, draft preview, secondary body, search-bar text | 400 | 1.55 |
| `--fs-base` | 13px | Body default (document baseline via `html, body`), nav items, input text | 400 | 1.5 |
| `--fs-md` | 14px | Card titles, button text, breadcrumb, priority title, brand-name | 500 | 1.5 |
| `--fs-lg` | 16px | Doc subhead, brief prose | 400 | 1.55 |
| `--fs-xl` | 20px | — (reserved; not used by in-scope views) | — | — |
| `--fs-2xl` | 28px | Mockup-level titles, (login splash heading) | 700 | 1.2 |
| `--fs-3xl` | 36px | Doc title (spec page only; not used in live app) | 700 | 1.1 |

**Live-app effective scale for Phase 3 views:** 11 / 12 / 13 / 14 / 16 (five sizes). The 20/28/36 tokens are declared for parity with the mockup but not required by in-scope views.

### Weights

Two weights used across UI chrome:
- **400 regular** — body, inputs, meta rows, nav items (non-active)
- **600 semibold** — section eyebrows, primary CTA, active-nav, priority numbers, brand-name (note: brand-name uses 600, priority-title uses 500 — 500 is the single permitted third weight for card titles / button labels, appearing in 4 specific component contexts only: card titles, button text, breadcrumb, brand-name)

**Decision:** Declared weights = **400, 500, 600**. 700 is loaded via `next/font` (for `fs-2xl` / `fs-3xl` mockup titles + doc-title) but NOT used in-app views. 300 is loaded but unused (kept for future parity with mockup font-face declaration).

### Line heights

- Body (`<html>` global): **1.5**
- Prose (brief text, draft preview): **1.55** (loosened for scanning)
- Priority title, card title: **1.5**
- Page heading (`.h-page`, 22px): **1.2** equivalent (`letter-spacing: -0.012em`)
- Mockup titles (28px / 36px): **1.1–1.2** (`letter-spacing: -0.018em` / `-0.022em`)

### Mono usage

`Geist Mono` is used on: `capture_id`, timestamps, entity IDs, `.kbd` shortcut badges, priority numbers (`01`, `02`, `03`), monospace traffic-light URL bar (titlebar), `.mono` utility class. Never used for body text.

### Letter spacing

- Section eyebrows (11px, uppercase): `letter-spacing: 0.1em` or `0.14em` (see per-usage in `TFOS-ui.html`)
- Page heading (22px): `letter-spacing: -0.012em`
- Mockup title (28px): `letter-spacing: -0.018em`
- Doc title (36px): `letter-spacing: -0.022em`
- All body text: default (0)

---

## Spacing Scale

The mockup does not expose spacing as CSS variables — it uses direct px values clustered on a **4 / 8 / 12 / 14 / 16 / 18 / 22 / 24 / 28 / 32 / 40 / 48 / 80** pattern. For Tailwind v4 parity we declare a **4px base-unit scale** with a few permitted 2px-step exceptions that appear throughout `TFOS-ui.html`.

### Declared tokens (all multiples of 4 where possible)

| Token | Value | Usage |
|-------|-------|-------|
| `xs` | 4px | Icon gap, nav-item internal gap before count, inline chip padding |
| `sm` | 8px | Compact element spacing (gap between adjacent badges, meta-row inline gaps) |
| `md` | 16px | Default card padding (inline), brief-header margin, avatar + body gap |
| `lg` | 24px | Section padding (card interior), brief padding (24px horizontal) |
| `xl` | 32px | Container horizontal padding, today-grid gap, main padding |
| `2xl` | 48px | Main-narrow horizontal padding (per-entity layout) |
| `3xl` | 64px | (reserved; used by login splash top offset) |
| **Exception 6px** | 6px | Nav-item vertical padding, priority-row action button gap, avatar status dot. Permitted because `TFOS-ui.html` uses 6px consistently for compact-interactive vertical rhythm where 4px is too tight and 8px is too loose. |
| **Exception 14px** | 14px | Card padding on draft-card, thread-row, side-card interior. Permitted because `--r-xl: 12px` radii paired with 14px padding is the recurring card rhythm in the mockup. |
| **Exception 18px** | 18px | Sidebar vertical padding, brand padding-bottom. Permitted per `TFOS-ui.html` line 151, 157. |
| **Exception 22px** | 22px | Brief card top/bottom padding. Permitted per `TFOS-ui.html` line 277. |

### Composite patterns

- **Card interior:** `padding: 14px 16px` (draft-card), `padding: 16px 18px` (side-card), `padding: 22px 24px` (brief card)
- **Section gap:** `gap: 28px` (today-main column), `gap: 32px` (today-grid columns), `gap: 24px` (today-side column)
- **Sidebar nav item:** `padding: 6px 10px; gap: 10px` (icon-to-label)
- **Topbar:** `height: 52px; padding: 0 24px; gap: 16px`
- **Page content:** `padding: 32px 40px` (main) or `padding: 32px 48px` (main-narrow)

Exceptions are normative, not deviations — they are part of the committed design.

---

## Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--r-sm` | 4px | Badges, kbd, selection-highlight |
| `--r-md` | 6px | Buttons, input, icon-btn, brand-mark, nav-item, topbar-btn |
| `--r-lg` | 8px | Cards (draft, side, priority-list outer), thread-row inner |
| `--r-xl` | 12px | Brief card |
| `--r-2xl` | 16px | App frame outer radius |

---

## Motion Contract (binding — from `TFOS-ui.html` §Motion principles lines 2063–2072)

These are NORMATIVE. The gsd-ui-auditor will flag violations.

1. **Easing:** All transitions use `cubic-bezier(0.16, 1, 0.3, 1)` (`--ease`). A secondary `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)` is declared but ease is the default.
2. **Durations:** `120ms` for hover/focus (`--t-fast`), `180ms` for state changes (`--t-base`), `280ms` for entry (`--t-slow`). **Never over 280ms.**
3. **Hover:** Changes `border-color` and/or `background` only. **Never `transform` on hover.** No movement, no scale.
4. **Entry animations:** `opacity` + `translateY(6px)` max. Never slide more than 8px. Keyframe `@keyframes fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`.
5. **Loading:** Single 6×6 pulsing dot. `@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }` — 2.4s `ease-in-out` infinite. **No spinners. No skeleton screens.**
6. **Real-time updates:** Fade-in only. New row in a list slides `4px` max. **No layout reflow on existing rows.** Implementation: `framer-motion` `AnimatePresence` for insertions; the list container must be stable/virtualized (react-window). `FlipMove`-style reorder animations are **banned**.
7. **Click feedback:** `scale(0.98)` on buttons. 80ms in, 80ms out. This is the only permitted transform on interaction.
8. **Sidebar nav active state:** **Instant. No transition.** The `transition: background var(--t-fast) var(--ease)` on `.nav-item` applies only to hover — the `.active` class toggles without transition.
9. **Brief-dot indicator:** Pulses continuously (status health). Entity-link hover color change is `--t-fast`.

**Framer Motion usage:** Permitted only for (a) list-insertion fade-in (rule 6), (b) page-entry `fade-up` on route change, (c) command palette dialog open/close. All other animations are pure CSS transitions to keep bundle weight low and GPU cost minimal.

---

## What This UI Deliberately Avoids (binding — lines 2077–2085)

Copied from §"What this UI deliberately avoids":

1. **No glassmorphism, no neumorphism.** No backdrop-blur, no inset shadows.
2. **No gradients on cards.** Only two permitted gradients exist:
   - Brand mark: `linear-gradient(135deg, var(--accent), var(--accent-2))`
   - AI block ("What you need to know"): subtle accent-tinted gradient on the block wrapper only
3. **No drop shadows on UI elements.** Only the app frame itself has a shadow (depth from page bg).
4. **No hover-grow. No card-tilt. No parallax.**
5. **No bright neon accents.** Single muted violet (`--accent #7c5bff`). Status colours stay desaturated.
6. **No emoji-as-icon overload.** Emoji permitted only for: Spår tags (bilingual-native UX affordance), explicit status indicators (e.g., ⏳ pending / ✅ done in Notion row pass-through). Never as primary navigation icons.
7. **No skeleton loaders.** Load budgets (<1.5s Today, <500ms entity per D-34) make them unnecessary. If load exceeds budget, the single 6×6 pulsing dot rule applies.
8. **No bouncy springs, no elastic eases, no swirl animations.**

---

## View Contracts (in-scope for Phase 3)

Five views + command palette are in scope per CONTEXT.md D-01. Each has a dedicated section mapping mockup → implementation.

### View 1 — Today (`/` after auth)

**Maps to:** `TFOS-ui.html` §01 Today (first mockup). Requirement: UI-01.

**Layout:**
- Container: 1280px max-width, `padding: 32px 40px`
- Grid: `grid-template-columns: 1fr 320px; gap: 32px` (today-main | today-side)
- Page heading: `.h-page` (22px, weight 600, `letter-spacing: -0.012em`) = "Tisdag 23 april" (localized day/date in user's language = Swedish) + `.h-page-meta` (13px, `--text-3`) = "3 prioriteringar · 2 drafts · 1 möte om 20 min" (count summary)

**Main column sections (stacked, `gap: 28px`):**
1. **AI Morning Brief** (`.brief`)
   - `linear-gradient(180deg, var(--surface-2), var(--surface-1))` bg; `border: 1px solid var(--border)`; `border-radius: var(--r-xl)`; `padding: 22px 24px`
   - Header: `brief-dot` (6×6 pulsing success dot) + "AI Morning Brief · 07:00" (12px, `--text-3`)
   - Body: 15px prose, `line-height: 1.65`, with inline `.ent` spans (accent-2, dotted accent-border underline) for entity links that deep-link to `/entities/[id]`
   - Entry animation: `fade-up var(--t-slow) var(--ease) backwards`
   - **Phase 3 placeholder state** (per D-05): Brief body = `"Brief generated daily at 07:00 — ships with Phase 7."` Single success dot still pulses to indicate the pipeline is healthy.
2. **Top 3 Priorities** (`.priority-list`)
   - `.h-section` eyebrow: "TOP 3 PRIORITIES" + count chip (3)
   - 3 `.pri-row` children, border-separated by `gap: 1px` on `var(--border)` container
   - Each row: `grid-template-columns: 24px 1fr auto`; mono priority number (01/02/03); title (14px, weight 500); meta row (11px, `--text-3`) with `.ent-tag` accent-2 link + bolag badge; right-side `.pri-actions` (fade in on hover, `opacity: 0→1` via `--t-fast`)
3. **Drafts to Review** (`.draft-card` × N)
   - `.h-section` eyebrow: "DRAFTS TO REVIEW" + count chip
   - Each draft: `border: 1px solid var(--border); border-radius: var(--r-lg); padding: 14px 16px; background: var(--surface-1); flex-direction: column; gap: 10px`
   - Draft meta row: "från Maria · Almi · för 12 minuter sedan" (`--text-3` with `--text-2` on subject)
   - 2-line clamped preview (`-webkit-line-clamp: 2`)
   - Actions: `.btn` Approve (primary) + `.btn` Edit + `.btn.ghost` Skip, aligned via `.btn-stack` margin-left auto
4. **Dropped Threads** (`.thread-row` × N, inside `.side-card`)
   - Eyebrow "DROPPED THREADS" + count
   - Each row: 28×28 avatar + title + last-ping timestamp; hover → `surface-2` bg

**Side column sections (stacked, `gap: 24px`):**
1. **Today's meetings** (`.side-card` > `.meeting-row` list)
   - Mono `meeting-time` (56px wide) + title + meta; active meeting uses `.meeting-now` (accent-2 time color)
2. **Voice/text dump zone** (composer)
   - Textarea in `surface-2` bg, `--border`; placeholder `"Dumpa allt — en tanke, en idé, ett möte. KOS sorterar."` (Swedish — composer is the capture affordance; pass-through language)
   - Primary button: `"Skicka"` — posts to `/api/capture` → `dashboard-api` → publishes `kos.capture` event with a fresh ULID `capture_id`
   - On successful submit: composer clears; a fade-in toast (`.toast` via shadcn `toast`) with mono `capture_id` appears top-right, auto-dismiss in 3s
   - Live status affordance: single 6×6 pulsing dot transitions `success` → `warning` if the event hasn't been ack'd within 5 seconds (SSE `capture_ack` kind)

**Empty states:**
- No priorities: `.h-section` + centered `--text-3` copy: `"No priorities yet. KOS surfaces them from Command Center every morning."`
- No drafts: `.h-section` + centered `--text-3` copy: `"No drafts awaiting review. ✅"` (✅ permitted here per §Avoids rule 6)
- No meetings today: side-card renders with single `--text-3` line: `"Nothing on your calendar today."`

**Loading:** Single 6×6 pulsing dot (success color) centered in the grid area while the initial RSC `GET /today` resolves. Never shown in practice at <1.5s TTI budget.

**Error:** If `/today` fetch fails, main column shows a single `.side-card` with copy: `"Couldn't load today. Retrying…"` — the SSE reconnection loop handles retry transparently. No retry button (ADHD-friendly: system heals itself).

### View 2 — Person / Project Dossier (`/entities/[id]`)

**Maps to:** `TFOS-ui.html` §02 Person dossier + §03 Project dossier. Requirements: UI-02, ENT-08.

**Layout:** `.main-narrow` (32px 48px, max 920px) OR grid with left rail — mockup uses a two-column layout with:
- Main content column (`.doc-*` hierarchy)
- 260–320px right side rail with stats (`.pstat-*`)

**Entity header (top of page):**
- Breadcrumb in topbar: `Entities / {type} / {name}` with `.crumb` on non-final segments
- 40–48px avatar (initial or icon) + name (20–22px, weight 600) + bolag badge + status badge
- Meta row: `"Person · Swedish-first · Role: {role} · Org: {org}"` — 13px `--text-2`

**Sections (stacked, `gap: 28px`):**

1. **"What you need to know" AI Block** (`.ai-block`)
   - Dual-tone bg: `background: linear-gradient(180deg, rgba(124, 91, 255, 0.06), transparent); border: 1px solid var(--accent-border); border-radius: var(--r-xl); padding: 20px 22px`
   - Eyebrow: accent-uppercase "WHAT YOU NEED TO KNOW" + cache-age meta ("cached 4h ago")
   - Body: 15px prose with inline entity links (same `.ent` treatment as brief)
   - Placeholder if no cached block yet: `"Summary generates on next morning brief. Until then, see timeline below."`

2. **Linked work** — Tabs: Projects · Tasks · Documents
   - Tabs component: shadcn `Tabs`; active underline is accent; inactive is `--text-3`
   - Project cards: bolag-tinted left border (4px), title, last-touch timestamp
   - Tasks table (`.task-row.head` header row in `--surface-2`, 11px uppercase): Status · Title · Deadline · Spår (bolag)

3. **Timeline** (chronological, reverse-chron)
   - `.h-section` "TIMELINE" + total-count chip
   - Virtualized list (react-window) of `mention_events + agent_runs` joined rows
   - **Initial SSR load:** 50 rows per D-35
   - Row types (icon prefix): email (✉), transcript (🎙), doc (📄), task (✓), decision (⚡), merge (⟲)
   - Row: `grid-template-columns: 20px 88px 1fr; gap: 12px; padding: 10px 0; border-bottom: 1px dashed var(--border)`
   - Mono timestamp (88px column, 11px `--text-3`) + icon + title/snippet
   - Snippet uses `.tl-snippet` (12px, `--text-2`, 2-line clamp, italic for quoted content)
   - Click row → deep-link to source (Notion page / transcript / email thread)

**Side rail (`.pstat-*`):**
- `pstat-label` (11px uppercase `--text-3`) over each stat
- Stats for Person: First contact, Total mentions, Last activity, Linked projects count, Active threads
- Stats for Project: Owner, Status, Deadline, Last activity, Linked entities count
- Manual edit button at bottom: `.btn` "Edit entity" → opens shadcn `Dialog` per D-29

**Empty states:**
- No AI block: `"Summary generates on next morning brief. Until then, see timeline below."`
- Empty timeline: centered `--text-3` copy: `"No activity yet. New mentions appear here in real-time."` + single pulsing dot (`--info` color — this entity is being watched)
- No linked projects: tab body shows `"No projects linked to this entity yet."`

**Merge entry point:** On the side rail, below stats, a `.btn.ghost` `"Merge duplicates"` routes to `/entities/[id]/merge` (see View 3.5 below). Uses `--text-3` until hover reveals.

### View 3 — Inbox (`/inbox`)

**Maps to:** `TFOS-ui.html` §04 Inbox. Requirements: UI-04, ENT-09 approval surface.

**Layout:** Two-pane Superhuman-style:
- Left pane (`280px` fixed): queue list
- Right pane (`1fr`): focused item detail

**Queue list (left pane, `.inbox-queue`):**
- Sticky header: count chip + filter tabs (All · Drafts · Entity routing · New entities)
- Rows: `grid-template-columns: 20px 1fr auto; gap: 10px; padding: 12px 14px`
- Each row: kind icon + 1-line title + 2-line preview + bolag chip + `.kbd` hint ("J / K to nav") displayed once at bottom of queue only
- Selected row: `border-left: 2px solid var(--accent); background: var(--accent-bg)` — no transition (matches §Motion rule 8: snappy selection)
- Hover: `background: var(--surface-hover)`; **transition: none** on selection change (instant), `--t-fast` on hover only

**Focused item (right pane):**
- Header: from/subject/timestamp + destination entity chips
- Body: rendered email OR draft reply preview OR entity-routing diff OR new-entity profile preview (four item kinds)
- Action bar (sticky bottom): Approve (primary) · Edit · Skip (ghost) · destructive "Reject" for new-entity kind (danger ghost)
- Keyboard shortcut badges as `.kbd`: `[J]` next, `[K]` prev, `[Enter]` approve, `[E]` edit, `[S]` skip, `[Esc]` close pane

**Keyboard contract (binding — from mockup + §Specifics):**
- `J` — next item in queue
- `K` — previous item
- `Enter` — Approve (primary action on focused item)
- `E` — open inline edit mode (shadcn `Input` / `Textarea` for the draft body, same pane, not a modal)
- `S` — Skip (moves item to bottom of queue, no archival)
- `Esc` — collapse right pane / close edit mode (one level at a time)
- `⌘K` / `Ctrl+K` — open global command palette (overrides Inbox focus)
- Unused letter shortcuts reserved: no `D`, no `A`, no `R` binding to avoid accidental destructive interpretation
- All shortcuts shown in `<kbd>` elements visible at the bottom of the right pane (not hidden behind a `?` overlay)
- Focus management: J/K apply optimistic-select via React 19 `useOptimistic`; server action fires in background; if server reports conflict, row reverts + a fade-in toast reports `"Already handled elsewhere"`

**Item kinds (4, each with its own render):**
1. **Draft reply** — From/To/Subject header + proposed body + "approve sends via SES"
2. **Ambiguous entity routing** — Two candidate entities side-by-side with confidence scores + "Merge & continue" action → routes to `/entities/[target]/merge?source=[source]`
3. **New entity confirmation** — Proposed entity profile (Name/Type/Org/Role/Relationship) + "Confirm & create" OR "Reject"
4. **Resume merge** (partial-failure recovery per D-28) — keyed to `merge_id`; Resume / Revert / Cancel actions

**Empty state:** When queue is empty, left pane shows centered `--text-3` copy: `"Inbox clear. ✅"` with single success pulsing dot. Right pane shows: `"Nothing to review. KOS surfaces drafts as they arrive."`

**Loading:** Single pulsing dot (accent color) in right pane while item fetches on J/K nav; rarely visible at expected latencies.

**Real-time behaviour:** New items arrive via SSE `inbox_item` kind. Inserted at top with 4px slide-down + fade-in (`AnimatePresence`). Existing row order never reflows mid-session unless Kevin sorts explicitly. Queue count chip animates number change with a fade, not a roll.

### View 3.5 — Merge Review (`/entities/[id]/merge?source=[sourceId]`)

**Maps to:** no mockup (not in `TFOS-ui.html`); design derived from CONTEXT.md D-27, D-28.

**Layout:** Two-column dedicated route (per D-27 — this is consequential enough to warrant a page, not a modal):
- Container: `main-narrow` style (32px 48px, max 960px)
- Grid: `grid-template-columns: 1fr 1fr; gap: 32px`
- Left: canonical (target) entity card
- Right: source (to-be-archived) entity card with visual "will be archived" overlay (reduced opacity 0.8, `--text-3` eyebrow "ARCHIVING")

**Diff panel (below columns):**
- "Fields that differ" section: 2-column diff (left vs right values) with merge direction indicator (`→` showing target will retain left's value; editable via radio toggle per-field)
- "Relations to rewrite" section: count of `mention_events`, `agent_runs`, `LinkedProjects` rows that will be re-pointed to canonical; not individually editable

**Action bar (sticky bottom):**
- Primary: `.btn.primary` `"Confirm merge"` — opens shadcn `Dialog` confirm
- Secondary: `.btn` `"Cancel"` — goes back to `/entities/[id]`
- Destructive signal: confirm dialog headline uses `--danger` text; body copy explains archive (not delete) per Phase 3 archive-never-delete policy

**Confirm dialog copy (binding):**
- Headline: `"Merge {source.name} into {target.name}?"`
- Body: `"The source entity will be archived, not deleted. All mentions, tasks, and projects will be re-pointed to {target.name}. This is logged to the audit table. You can revert this within 7 days from the Inbox Resume card."`
- Primary button: `"Yes, merge"` (accent bg — consequential but not destructive since it's archive)
- Secondary: `"Cancel"` (ghost)

**Partial-failure state (post-merge):**
- If merge fails mid-transaction, user is redirected to `/inbox?focus=resume-{merge_id}`
- Inbox shows a dedicated "Resume?" card with three actions: Resume / Revert / Cancel
- `merge_id` (ULID) displayed in `.mono` for audit reference

### View 4 — Calendar (`/calendar`)

**Maps to:** `TFOS-ui.html` §05 Calendar. Requirement: UI-03.

**Layout:**
- Page header: `.h-page` "Calendar" + `.h-page-meta` "This week · 8 events" + right-aligned view switcher (Week / Month — Month defers to Phase 8; Phase 3 ships Week only; Month tab renders disabled with tooltip "Month view ships with Phase 8")
- Week grid: 7 columns × time-row grid; `gap: 1px` on `--border` bg for separator effect
- Day header row: day name + date (11px uppercase `--text-3`); today column gets `border-top: 2px solid var(--accent)`
- Event bars: absolute-positioned inside time cells; bolag-colored left border (4px), `--surface-2` bg, 12px title + 11px `--text-3` time range
- Hover on event: `background: rgba(124, 91, 255, 0.22)` + `transform: translateY(-1px)` — **EXCEPTION** to the no-hover-transform rule, sanctioned by mockup line 742. This is the single permitted hover-transform in the entire app.
- Click event → `/entities/[id]` where id = linked project/person

**Data source (Phase 3):** Command Center `Deadline` + `Idag` filtered Notion rows only (per D-04). Google Calendar merge is Phase 8.

**Empty state:** Centered copy: `"Nothing scheduled this week."` + `--text-3` meta: `"Events from Command Center Deadline and Idag columns appear here."`

**Loading:** Single pulsing dot (accent color) centered while initial fetch resolves.

**Real-time behaviour:** SSE `timeline_event` kind triggers a re-fetch of the week. New events fade-in at their correct grid position (no slide from outside the grid).

### View 5 — Global Command Palette (modal, `⌘K` / `Ctrl+K`)

**Maps to:** `TFOS-ui.html` §07 Command palette. Requirement: cross-view navigation.

**Library:** `cmdk` (per D-10) via shadcn `Command` component.

**Layout:**
- Centered modal, 560px wide, `background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--r-xl); box-shadow: 0 24px 80px -16px rgba(0, 0, 0, 0.6)`
- Input at top: 13px, 48px height, `--surface-2` bg; placeholder: `"Search or type a command…"`
- Results below grouped by `.palette-section` labels (10px uppercase `--text-4`): "Entities · Views · Actions"
- Selected row: `background: var(--accent-bg); color: var(--accent-2)` — no transition (matches snappy-decision rule 8)
- Keyboard: `↑/↓` navigate, `Enter` select, `Esc` close, `⌘K` again toggles

**Root data (Phase 3 — string-contains match only per D-10):**
- Entities: `entity_index` rows, fetched once on open, fuzzy-indexed client-side (fuse.js optional; plain `toLowerCase().includes()` acceptable for <1000 entities)
- Views: Today (`/`), Inbox (`/inbox`), Calendar (`/calendar`), Settings (`/settings`, stub)
- Actions: "Logout", "Approve selected" (only active when Inbox queue has a selection), "Copy session cookie" (dev affordance)

**Deferred (not in Phase 3):** Natural-language routing ("what did Christina say about timing") — requires AGT-04 auto-context loader; see Phase 6.

**Loading state:** The palette input is always interactive on open (no network call for first render — entities fetched lazy from RSC cache). If network query is required (not in Phase 3), single pulsing dot in results area.

**Empty-match state:** `--text-3` copy: `"No match. Type to search entities and commands."`

### Login (`/login`, unauthenticated only)

**Maps to:** no mockup (auth flow implied). Requirement: D-19.

**Layout:**
- Centered card on `--bg`, 420px wide, `surface-1` fill
- Brand mark (22×22 gradient) + "Kevin OS" wordmark centered at top
- Single `<input type="password">` for Bearer token (labeled `"Paste session token"` — no username field)
- Primary button: `"Sign in"` — accent fill
- Below button: 12px `--text-3` help text: `"iOS users: add this page to home screen via Safari's Share menu. Chrome / Edge: install via the address-bar icon after sign-in."` (per D-32 documentation requirement)
- On error: inline red `--danger` text below input: `"Token rejected. Check it and try again."` (no stack trace, no technical detail)
- On success: 302 to `?return=` path or `/`

---

## Sidebar (persistent across all `(app)` routes)

**Layout:** 220px fixed width, `--surface-1` bg, `border-right: 1px solid var(--border)`, `padding: 18px 12px`, flex column with `gap: 4px`.

**Sections (top to bottom):**
1. **Brand** — 22×22 accent-gradient mark + "Kevin OS" (14px weight 600) + 6×6 success-dot status indicator (pulses continuously). Padding `4px 10px 18px`.
2. **Nav group 1 — Views:**
   - Today (`/`) — house icon, kbd `[T]`
   - Inbox (`/inbox`) — inbox icon, kbd `[I]`, count chip
   - Calendar (`/calendar`) — calendar icon, kbd `[C]`
   - Chat (disabled) — chat icon, `--text-4`, tooltip "Ships with Phase 4"
3. **Nav label: "ENTITIES"** (11px uppercase `--text-4`)
   - People (`/entities?type=person`) — users icon, count
   - Projects (`/entities?type=project`) — folder icon, count
   - (Companies + Documents deferred per D-03)
4. **Nav label: "QUICK"**
   - Command palette trigger — search icon + `⌘K` kbd badge (right-aligned)
5. **Bottom-pinned:**
   - Settings (`/settings`, stub) — cog icon
   - Logout — log-out icon, `--text-3` until hover reveals

**Active state:** `background: var(--accent-bg); color: var(--accent-2)`. **Instant — no transition** (rule 8).

**Keyboard shortcuts (T / I / C):** Single-key jumps when no text input is focused. Uses the same tinykeys pattern used in Inbox.

---

## Topbar (persistent across all `(app)` routes)

**Height:** 52px, `--surface-1` bg, `border-bottom: 1px solid var(--border)`, `padding: 0 24px`, flex row `gap: 16px`.

**Contents:**
- Left: `.breadcrumb` (14px weight 500) — e.g., `Today` or `Entities / Person / Maria Svensson`; separator is `/` in `--text-4`
- Center-spacer (`flex: 1`)
- Search bar trigger (280px wide, clickable; opens command palette) — placeholder: "Search entities, views…" + `⌘K` kbd on the right
- Topbar buttons: `Approve selected` (context-only, Inbox), `New capture` (opens composer focus from anywhere)
- Right: user avatar (22×22, initial "K" on accent gradient) — click opens shadcn `DropdownMenu` with logout

---

## Copywriting Contract

Per CLAUDE.md "calm-by-default output principle" + TFOS-ui.html tone + PROJECT.md ADHD compatibility + D-41 (UI chrome English, data as-authored).

### Language rules

- **UI chrome:** English (labels, button text, empty states, errors, help text)
- **Data:** Pass-through — entity names, Notion content, transcripts, briefs render in whatever language they were authored in (Swedish-English code-switched is expected and correct)
- **Swedish terms kept as-is in data context:** "Ägare", "Bolag", "Idag", "Spår", "Deadline", "Tisdag", bolag proper names (Tale Forge, Outbehaving). These appear as pass-through from Command Center fields.
- **Bilingual sample in views:** Voice/text composer placeholder is Swedish (`"Dumpa allt — en tanke, en idé, ett möte. KOS sorterar."`) because it is prompting user capture (data side, not UI chrome).

### Tone

- Short. Scannable. One-line messages. No paragraph-long error descriptions.
- Plain verbs, never "Please" / "Would you like to" boilerplate.
- No stack traces or technical detail surfaced to user (ADHD-hostile + single-user so no blame deflection needed).
- Emoji use: restricted to ✅ (done / empty-inbox celebration), ⏳ (pending), 🎙 (transcript kind), ✉ (email kind), 📄 (doc), ⚡ (decision), ⟲ (merge). Never as primary navigation icon.

### Copy table (binding)

| Element | Copy |
|---------|------|
| **Primary CTA — Inbox item** | `"Approve"` (sends draft via SES OR confirms entity routing OR creates new entity, depending on item kind) |
| **Secondary — Inbox item** | `"Edit"` / `"Skip"` |
| **Destructive — Inbox new-entity** | `"Reject"` (ghost button, `--danger` text on hover) |
| **Primary CTA — Merge page** | `"Confirm merge"` |
| **Merge confirmation dialog headline** | `"Merge {source.name} into {target.name}?"` |
| **Merge confirmation dialog body** | `"The source entity will be archived, not deleted. All mentions, tasks, and projects will be re-pointed to {target.name}. This is logged to the audit table. You can revert this within 7 days from the Inbox Resume card."` |
| **Merge confirmation primary** | `"Yes, merge"` |
| **Merge confirmation secondary** | `"Cancel"` |
| **Primary CTA — Voice/text composer** | `"Skicka"` (Swedish — data side, consistent with composer placeholder language) |
| **Primary CTA — Login** | `"Sign in"` |
| **Empty state — Today priorities** | heading: `"No priorities yet."` body: `"KOS surfaces them from Command Center every morning."` |
| **Empty state — Today drafts** | heading: `"No drafts awaiting review. ✅"` body: (none) |
| **Empty state — Today meetings** | body only: `"Nothing on your calendar today."` |
| **Empty state — Inbox** | heading: `"Inbox clear. ✅"` body: `"Nothing to review. KOS surfaces drafts as they arrive."` |
| **Empty state — Entity timeline** | body: `"No activity yet. New mentions appear here in real-time."` |
| **Empty state — AI block (dossier)** | body: `"Summary generates on next morning brief. Until then, see timeline below."` |
| **Empty state — Calendar week** | heading: `"Nothing scheduled this week."` body: `"Events from Command Center Deadline and Idag columns appear here."` |
| **Empty state — Command palette** | `"No match. Type to search entities and commands."` |
| **Error — /today fetch failed** | `"Couldn't load today. Retrying…"` |
| **Error — Inbox item conflict** | `"Already handled elsewhere."` (toast, auto-dismiss 4s) |
| **Error — Capture submit failed** | `"Capture didn't reach KOS. Retry?"` (toast with retry button, auto-dismiss disabled until retry or dismiss) |
| **Error — Login token rejected** | `"Token rejected. Check it and try again."` |
| **Error — SSE stream dropped** | (silent — auto-reconnect; no user-facing message) |
| **Loading — any view initial** | (no copy — single 6×6 pulsing dot only) |
| **Offline banner (PWA)** | `"Offline · last synced {relative time} · some actions disabled"` (no retry button — reconnects automatically) |
| **Phase-3 placeholder — Morning Brief** | `"Brief generated daily at 07:00 — ships with Phase 7."` |
| **Phase-3 placeholder — Chat nav** | (tooltip on disabled item) `"Ships with Phase 4"` |
| **Phase-3 placeholder — Calendar month view** | (tooltip on disabled tab) `"Month view ships with Phase 8"` |
| **Phase-3 placeholder — iOS install help** | `"iOS users: add this page to home screen via Safari's Share menu. Chrome / Edge: install via the address-bar icon after sign-in."` |
| **Destructive confirmation (merge)** | see headline + body rows above |
| **Logout confirmation** | (none — logout is instant from avatar dropdown; cookie clear + redirect to `/login`) |

### Destructive actions inventory (Phase 3)

Only one truly destructive surface in scope: **entity merge** (archive, not delete — but irreversible without Resume/Revert flow). All other "destructive-looking" actions (Skip, Reject, Cancel merge) are reversible or no-ops:

| Action | Surface | Confirmation |
|--------|---------|--------------|
| Confirm entity merge | `/entities/[id]/merge` | shadcn `Dialog` with explicit archive-not-delete copy (see above) |
| Reject new entity (Inbox) | Inbox right pane | No dialog — just moves to archived Inbox list; reversible from Inbox filter "Archived" (deferred to Phase 3.5) |
| Skip Inbox item | Inbox right pane | No dialog — `S` key is single-keystroke; reversible (item returns to bottom of queue) |
| Logout | Avatar dropdown | No dialog — cookie clear + redirect. Re-auth required; no data loss. |

---

## Component Inventory (shadcn/ui + supporting libs)

### Required shadcn/ui components (initial install per D-09)

| Component | Install command | Used in |
|-----------|-----------------|---------|
| `button` | `npx shadcn@latest add button` | All CTAs, icon buttons |
| `card` | `npx shadcn@latest add card` | Brief, draft card, side card, merge columns |
| `dialog` | `npx shadcn@latest add dialog` | Manual entity edit (D-29), merge confirmation |
| `command` | `npx shadcn@latest add command` | Global command palette (D-10 — wraps cmdk) |
| `input` | `npx shadcn@latest add input` | Login, entity edit fields, composer |
| `textarea` | `npx shadcn@latest add textarea` | Voice/text dump composer, Inbox edit mode |
| `tabs` | `npx shadcn@latest add tabs` | Per-entity "Linked work" + Calendar Week/Month switcher |
| `separator` | `npx shadcn@latest add separator` | Card section dividers |
| `scroll-area` | `npx shadcn@latest add scroll-area` | Inbox queue, timeline, command palette results |
| `sonner` / `toast` | `npx shadcn@latest add sonner` | Capture ack, error toasts, SSE notification |
| `avatar` | `npx shadcn@latest add avatar` | Thread rows, entity header, user dropdown |
| `tooltip` | `npx shadcn@latest add tooltip` | Disabled nav items, truncated-text reveals |
| `kbd` | (custom — shadcn `kbd` is in official registry under 2025) `npx shadcn@latest add kbd` | Every shortcut hint across app |
| `dropdown-menu` | `npx shadcn@latest add dropdown-menu` | User avatar menu (logout), Inbox filter menu |

**Add-on-demand (not in initial install):** `select`, `checkbox`, `radio-group`, `popover`, `alert-dialog`, `skeleton` (NEVER INSTALL — skeletons are banned per §Avoids).

### Supporting libraries

| Library | Version pin | Role |
|---------|-------------|------|
| `lucide-react` | latest (shadcn default) | All navigation + inline icons |
| `framer-motion` | ^11.x | AnimatePresence for list insertion, route transitions only (rules 4 + 6 only) |
| `cmdk` | pinned via shadcn `command` | Command palette engine |
| `react-window` | ^1.8.x | Timeline virtualization (50+ rows per D-35) |
| `tinykeys` | ^3.x | J/K/Enter/E/S keyboard shortcuts (Inbox), T/I/C (sidebar) |
| `@serwist/next` | latest | PWA service worker (D-30) |

No `@radix-ui/*` direct imports — always via shadcn `components/ui/*` wrappers.

---

## Accessibility (binding)

1. **Keyboard-first everywhere.** All interactive elements reachable by `Tab`. Inbox J/K/Enter/E/S must work with screen-reader focus intact.
2. **Focus indicators visible.** `:focus-visible` ring uses `--accent` (2px, offset 2px, `box-shadow: 0 0 0 2px var(--accent)`) — never `outline: none` without replacement.
3. **Color contrast.** All text colors meet WCAG AA against `--bg #0a0c11`:
   - `--text` (#e7eaf0) on `--bg`: 15.9:1 ✅
   - `--text-2` (#b1b6c2) on `--bg`: 10.5:1 ✅
   - `--text-3` (#71768a) on `--bg`: 5.4:1 ✅ (AA for normal text)
   - `--text-4` (#4d5263) on `--bg`: 2.9:1 ❌ — **USED ONLY for section labels ≥ 11px uppercase bold + non-load-bearing text**. Never for body or clickable targets. Flagged for future contrast audit; acceptable per WCAG as decorative.
   - `--accent-2` (#9d80ff) on `--bg`: 6.2:1 ✅ (AA for normal text)
4. **`<kbd>` elements** used for every shortcut badge (semantic HTML).
5. **Screen-reader labels** on all icon-only buttons (`aria-label` or `<span class="sr-only">`).
6. **Skip-to-content link** at top of every `(app)` route (visible on focus only).
7. **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables all entry animations, pulse, fade-up — instant state changes only. Skeleton-dot still pulses but at half-speed OR disables (executor choice, documented).
8. **Heading hierarchy:** Each route has exactly one `<h1>` (the `.h-page` element). `.h-section` renders as `<h2>`. No heading levels skipped.
9. **Form labels:** Every input has an associated `<label>` (visible or `.sr-only`). Login form uses visible `"Paste session token"` label.
10. **Dialogs trap focus** (shadcn `Dialog` handles natively); `Esc` closes.
11. **Entity links (`.ent`)** are `<a>` elements with `href` — never `<span onClick>`; enables right-click + open-in-new-tab.
12. **Live region for SSE notifications:** A visually-hidden `<div aria-live="polite">` announces new Inbox items as "New inbox item: {title}" for screen readers. Suppressed under reduced-motion preference.

---

## Responsive Behaviour

**Primary viewport:** 1280–1920px desktop (Kevin's primary device is a laptop/desktop dashboard — per UI-05 "desktop-primary").

**Breakpoints:**
- **≥ 1280px (default, design target):** Full layout as specified (220px sidebar + 1fr main + 320px side rail on Today).
- **768–1279px (tablet / smaller laptop):** Today-side rail collapses below today-main (single-column stack); per-entity side rail collapses to bottom accordion; Inbox becomes single-pane (queue OR detail, `Esc` or back-button returns to queue); sidebar stays visible (220px).
- **< 768px (mobile / Android PWA):** Sidebar becomes bottom-tab nav (Today / Inbox / Calendar + palette trigger + avatar); all views single-column; Inbox becomes full-screen single-pane with a "back" icon in place of Esc; topbar compresses to 44px height; voice/text composer becomes bottom-anchored sticky.

**No mobile-first approach.** Desktop-primary per UI-05. Mobile PWA is a first-class fallback but not the design target.

**Touch targets:** ≥ 44×44px on all interactive elements at <768px (exception to the 26px icon-btn rule which only applies desktop).

---

## PWA Contract

Per D-30, D-31, D-32, D-33.

**Manifest (`apps/dashboard/public/manifest.webmanifest`):**
- `name`: "Kevin OS"
- `short_name`: "KOS"
- `theme_color`: `#0a0c11`
- `background_color`: `#0a0c11`
- `display`: `standalone`
- `orientation`: `portrait-primary` (mobile) / `any` (desktop)
- `icons`: 192×192 + 512×512 derived from brand mark (Kevin monogram on accent gradient)
- `start_url`: `/`
- `scope`: `/`

**Service worker (via `@serwist/next`):**
- Static asset cache via Workbox default
- **Today view runtime cache:** `GET /today` (API response) + `/` (HTML) with **24-hour stale-while-revalidate** strategy (D-31)
- Offline fallback: Serves cached Today response with `<div class="offline-banner">Offline · last synced {relative time} · some actions disabled</div>` overlay (token: `--warning` text on `--surface-2` bg, fixed top)
- No proactive `beforeinstallprompt` banner (D-33) — installs happen via browser address-bar icon or a later `/settings` "Install" button

**iOS handling:** Safari Add-to-Home-Screen shortcut only; documented in `/login` help text (D-32). No standalone PWA manifest behavior on iOS — EU DMA regression locks this.

---

## Bolag (Company) Color Mapping — Binding Rules

Every entity-linked UI element that surfaces an `entity.org` or `project.bolag` value renders the corresponding bolag tint:

| `org` / `bolag` value | Token | Badge class | Used on |
|-----------------------|-------|-------------|---------|
| `"Tale Forge"` / `"tale-forge"` | `--tale-forge` (#38bdf8) | `.badge.bolag-tf` | Entity cards, calendar event left-border, Inbox item chip, sidebar section chip, timeline row accent |
| `"Outbehaving"` / `"outbehaving"` | `--outbehaving` (#fb923c) | `.badge.bolag-ob` | Same surfaces as above |
| `"Personal"` or null / unmapped | `--personal` (#a78bfa) | `.badge.bolag-pe` | Same surfaces as above |

Unknown bolag values fall back to `--personal`. Mapping happens at render time via a small helper (`lib/bolag.ts`) — never hardcoded per-view.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official (`ui.shadcn.com`) | `button, card, dialog, command, input, textarea, tabs, separator, scroll-area, sonner, avatar, tooltip, kbd, dropdown-menu` | not required (official registry) |
| Third-party registries | **none declared** | not applicable |

No third-party shadcn registries are declared for Phase 3. Executors MUST NOT pull from third-party registries without re-running the UI research gate. If a third-party block is needed (e.g., a calendar week-view block), the executor halts, the researcher re-runs the safety vetting gate, and the result is appended to this table with timestamped evidence.

---

## Mockup-to-Code Fidelity Rules (binding)

1. **Paste-parity during development:** The mockup HTML per view can be pasted directly into a scratch page in the dev build; it must render identically because CSS variables are 1:1 ported.
2. **Deviations require documentation.** Any executor who deviates from the mockup's visual target MUST append a row to a `DEVIATIONS.md` in the phase folder with: element, mockup value, implementation value, reason.
3. **Auditor reference:** The gsd-ui-auditor compares the implemented DOM computed styles against `TFOS-ui.html` `:root` + per-view rules. Any mismatch on tokens is a fail.
4. **Tokens never hardcoded.** All colors, spacing, radii, fonts come from the CSS variables OR Tailwind v4 `@theme` exposed aliases. Raw hex in TSX is a lint fail (planner to add `eslint-plugin-design-tokens` or equivalent).
5. **Motion rules are lint-enforced** where possible: an ESLint rule forbids `transform:` + `hover:` on the same element, and bans `skeleton` component imports entirely.

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS (English UI chrome + Swedish data pass-through; all empty/error copy from table above; destructive confirm includes archive-not-delete language)
- [ ] Dimension 2 Visuals: PASS (no glassmorphism / no neumorphism / no drop shadows on interior cards / no card-tilt; only sanctioned hover-transform on calendar event)
- [ ] Dimension 3 Color: PASS (60% surfaces / 30% secondary / 10% accent restricted to 8-element list; desaturated status; bolag mapping rules binding)
- [ ] Dimension 4 Typography: PASS (5-size effective scale 11/12/13/14/16; 3-weight declared 400/500/600; Geist + Geist Mono via next/font; mono reserved for IDs/timestamps/kbd)
- [ ] Dimension 5 Spacing: PASS (4px-base scale + 4 normative exceptions 6/14/18/22 per mockup; card/section/sidebar rhythms enumerated)
- [ ] Dimension 6 Registry Safety: PASS (shadcn official only; no third-party; skeleton component explicitly banned)

**Approval:** pending (gsd-ui-checker to upgrade to `approved YYYY-MM-DD`)

---

## References

- **Canonical visual spec:** `TFOS-ui.html` (repo root, 2102 lines) — 7 views + token card + motion rules + avoids list
- **Companion narrative:** `TFOS-overview.html` (repo root, 1111 lines)
- **Phase decisions:** `.planning/phases/03-dashboard-mvp/03-CONTEXT.md` D-01..D-41
- **Requirements:** `.planning/REQUIREMENTS.md` UI-01..UI-06, ENT-07, ENT-08, INF-12
- **Validation contract:** `.planning/phases/03-dashboard-mvp/03-VALIDATION.md`
- **Stack rationale:** `.planning/phases/03-dashboard-mvp/03-RESEARCH.md`
- **Cross-phase locks:** `.planning/STATE.md` #7 (SSE via Postgres LISTEN/NOTIFY), #8 (Bearer token), #12 (archive-never-delete)
- **Project constraints:** `CLAUDE.md` §"Recommended Stack" (Next.js 15 + Tailwind v4 + shadcn) + §"What NOT to Use" (no AppSync, Pusher, Supabase Realtime, Cognito, Clerk)
