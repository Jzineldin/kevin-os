---
phase: 11
plan: 7
subsystem: dashboard
tags: [frontend, audit, accessibility, mission-control]
requires:
  - "11-02 (ChatBubble component shipped)"
  - "11-06 (integrations-health page exists for ChannelHealth deep-link)"
provides:
  - "Global ChatBubble mount on every (app) route"
  - "/chat visual-only shell with Phase 11-ter placeholder"
  - "11-BUTTON-AUDIT.md — 49-row D-06 audit document"
  - "Populated BUTTON_REGISTRY (30 entries) for parametric e2e (Plan 11-08)"
  - "Settings entry removed from sidebar — D-06 stub policy enforced"
affects:
  - "All (app) routes — ChatBubble visible globally"
  - "Sidebar markup — Chat enabled, Settings removed, testIds added"
  - "Topbar markup — testIds added on cmdk + new-capture + user-menu"
tech-stack:
  added: []
  patterns:
    - "data-testid catalog as TS const (analog: lib/bolag.ts)"
    - "NavItem testId prop pass-through for parametric e2e targeting"
key-files:
  created:
    - "apps/dashboard/src/app/(app)/chat/page.tsx"
    - ".planning/phases/11-frontend-rebuild-real-data-wiring-button-audit-mission-contr/11-BUTTON-AUDIT.md"
  modified:
    - "apps/dashboard/src/app/(app)/layout.tsx"
    - "apps/dashboard/src/components/app-shell/Sidebar.tsx"
    - "apps/dashboard/src/components/app-shell/Topbar.tsx"
    - "apps/dashboard/src/components/app-shell/UserMenu.tsx"
    - "apps/dashboard/src/components/dashboard/ChannelHealth.tsx"
    - "apps/dashboard/src/app/(app)/today/Composer.tsx"
    - "apps/dashboard/src/app/(app)/today/DraftsCard.tsx"
    - "apps/dashboard/src/app/(app)/today/DroppedThreads.tsx"
    - "apps/dashboard/src/app/(app)/inbox/ItemDetail.tsx"
    - "apps/dashboard/src/app/(app)/inbox/ItemRow.tsx"
    - "apps/dashboard/src/app/(app)/entities/page.tsx"
    - "apps/dashboard/src/lib/button-registry.ts"
    - "apps/dashboard/tests/unit/app-shell.test.tsx"
  deleted:
    - "apps/dashboard/src/app/(app)/settings/page.tsx"
decisions:
  - "Settings: REMOVE — current /settings page is a stub ('not wired in Phase 3'); per D-06 strict no-half-implemented-buttons rule, the entry is deleted. Phase 12 reintroduces."
  - "Composer voice button NOT BUILT — current Composer is text-only; voice capture lives on Telegram bot path (Phase 11-bis). Flagged in audit, no action this plan."
  - "Extended ButtonRegistryEntry.expect type to include 'open' | 'select' so drawer/dropdown triggers and selection actions are typed accurately."
  - "PriorityList row NO-OP confirmed — already has zero onClick in current code; rendered as motion.div without click handler. No removal needed."
  - "Calendar event without linked_entity_id NO-OP confirmed — already a div without onClick when linked_entity_id is absent."
metrics:
  duration_minutes: 10
  completed: "2026-04-26T20:08:38Z"
---

# Phase 11 Plan 11-07: Button Audit + Global ChatBubble + Settings Decision Summary

D-06 enforced across the entire (app) route group: 49 surfaces audited, 30
KEEP/WIRE entries catalogued in BUTTON_REGISTRY, Settings removed, ChatBubble
mounted globally, /chat visual-only shell shipped.

---

## Audit Row Counts

| Verdict | Count |
|---|---|
| KEEP (already wired, testid present) | 22 |
| WIRE (testid + minor change applied in Task 2) | 22 |
| REMOVE (deleted in Task 2) | 2 (Settings page + sidebar entry) |
| NO-OP (already non-interactive) | 2 (PriorityList row, Calendar event w/o entity) |
| NOT BUILT (deferred to Phase 11-bis) | 1 (Composer voice button) |
| **Total surfaces audited** | **49** |

## Settings Verdict

**REMOVE** — applied autonomously per plan brief. The page was a literal
stub ("Settings stub — not wired in Phase 3.") with zero working buttons.
D-06's "no half-implemented buttons" rule + RESEARCH Open Q3
recommendation made this a clear-cut REMOVE.

Removed surfaces:

- `apps/dashboard/src/app/(app)/settings/page.tsx` (deleted)
- `apps/dashboard/src/app/(app)/settings/` (directory deleted)
- Sidebar `<NavItem href="/settings" …>` (deleted)
- `Settings` import from lucide-react in Sidebar (deleted)
- `SEGMENT_LABEL.settings` mapping in Topbar (deleted)

Phase 12 will reintroduce a real Settings surface (token rotation,
channel toggles, manual scheduler triggers).

## BUTTON_REGISTRY Length

**30 entries**, broken down by route:

- 9 sidebar entries (nav-today/inbox/calendar/integrations-health/chat/people/projects + sidebar-cmdk + sidebar-logout)
- 3 topbar entries (topbar-cmdk + topbar-new-capture + topbar-user-menu)
- 1 global (chat-bubble)
- 6 today entries (composer-send + 3 draft actions + dropped-row + mc-channel-bar)
- 4 inbox entries (row-click + approve + edit + skip)
- 4 entities filter chips (person/project/company/document)
- 1 chat shell (chat-page)

Skipped because removed/no-op: nav-settings, priority-row, calendar event
without entity link, capture-row.

## Files Modified + LOC Delta

| File | LOC delta | Notes |
|---|---|---|
| `(app)/chat/page.tsx` | +75 | NEW — Phase 11-ter shell |
| `(app)/settings/page.tsx` | -19 | DELETED |
| `(app)/layout.tsx` | +5 | ChatBubble import + global mount |
| `components/app-shell/Sidebar.tsx` | +13 / -19 | testIds, Settings removed, Chat enabled |
| `components/app-shell/Topbar.tsx` | +5 / -1 | testIds, SEGMENT_LABEL fixed |
| `components/app-shell/UserMenu.tsx` | +1 | topbar-user-menu testId |
| `components/dashboard/ChannelHealth.tsx` | +1 | mc-channel-bar testId |
| `(app)/today/Composer.tsx` | +1 / -1 | testid rename |
| `(app)/today/DraftsCard.tsx` | +9 / -3 | 3 testIds on draft actions |
| `(app)/today/DroppedThreads.tsx` | +1 | dropped-row testId |
| `(app)/inbox/ItemDetail.tsx` | +12 / -2 | save/cancel testIds |
| `(app)/inbox/ItemRow.tsx` | +1 | inbox-row-click testId |
| `(app)/entities/page.tsx` | +1 | entity-filter-{type} testid template |
| `lib/button-registry.ts` | +51 / -3 | populated 30-entry registry |
| `tests/unit/app-shell.test.tsx` | +18 / -10 | reflect Chat enabled, Settings removed |
| `.planning/.../11-BUTTON-AUDIT.md` | +143 | NEW |

**Total:** ~285 lines added, ~60 deleted across 16 files (one new audit doc, one new chat shell, one deleted settings page, 13 modified components/tests).

## Surfaces That Needed Actual Handler Wiring

Almost all WIRE verdicts were testid-only additions — the handlers were
already correctly wired. The exceptions:

1. **Sidebar Chat link** — flipped from `disabled + disabledTooltip="Ships with Phase 4"` to a real `href="/chat"` with `testId="nav-chat"`. The /chat page itself ships as a static placeholder until Phase 11-ter wires the conversational backend.

2. **`/chat` shell created** — RSC page with "Phase 11-ter ships Sonnet 4.6 + entity-graph context" placeholder text. Static, no SSE, no client interactivity. Gives the global ChatBubble a deep-link counterpart.

3. **Topbar `SEGMENT_LABEL` cleanup** — removed `settings: 'Settings'` mapping (dead key after page deletion); added `chat` and `integrations-health` mappings so breadcrumbs render correctly on those routes.

4. **`composer-submit` → `today-composer-send`** — testid renamed to match the audit table convention. No callsite references existed for the old name (verified via grep).

## Auto-fixed Deviations (Rules 1-3)

### [Rule 3 - Blocking] Stale Next.js validator types

**Found during:** Task 2 typecheck (after settings page deletion)
**Issue:** `.next/types/validator.ts` retained a `import("../../src/app/(app)/settings/page.js")` reference, causing TS2307. Pre-existing build cache that Next.js's RSC type generator did not auto-prune.
**Fix:** `rm -rf apps/dashboard/.next/types` — Next.js regenerates on next build/typecheck. Re-running `tsc --noEmit` produced clean output.
**Files modified:** none committed (cache only)

### [Rule 1 - Bug] app-shell.test.tsx asserted removed surfaces

**Found during:** Task 2 unit test run.
**Issue:** Two tests asserted UI invariants that this plan intentionally invalidated:
  - `it('renders brand + all top-level nav items')` expected `Settings` text
  - `it('renders the Chat item disabled with UI-SPEC tooltip copy')` asserted `data-disabled="true"` on Chat
**Fix:** Updated both tests to reflect Phase 11 contracts (Settings absent, Chat enabled with `nav-chat` testId + real href). Added comment block documenting the Phase 11 invariant changes.
**Files modified:** `apps/dashboard/tests/unit/app-shell.test.tsx`
**Commit:** 224a5fe (rolled into Task 2)

## Authentication Gates Encountered

None — no production secrets touched, no remote API calls during execution.

## Self-Check: PASSED

Verified all 11-07 commits exist:

- `9cd8a1a` — Task 1 audit doc (FOUND)
- `224a5fe` — Task 2 audit verdicts applied (FOUND)
- `99f5e31` — Task 3 BUTTON_REGISTRY populated (FOUND)

Verified key created files exist:

- `.planning/phases/11-.../11-BUTTON-AUDIT.md` (FOUND, 67 table rows)
- `apps/dashboard/src/app/(app)/chat/page.tsx` (FOUND, contains "Phase 11-ter")
- `apps/dashboard/src/app/(app)/settings/` (REMOVED as expected)

Verified all acceptance criteria:

- ChatBubble in layout: 3 references (import + global mount + comment) ≥ 2 ✓
- Sidebar Chat disabled: 0 actual `disabled` prop occurrences ✓ (the lone "1" match was a docstring comment, since updated)
- nav-chat testid: 1 occurrence ✓
- Settings dir: REMOVED ✓
- New testIds: 17 ≥ 8 ✓
- Registry size: 30 ≥ 10 ✓
- All 30 registry ids resolve to real data-testids in source ✓
- typecheck: exit 0 ✓
- 121 tests pass / 4 todo / 0 fail ✓
