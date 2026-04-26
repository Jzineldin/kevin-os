/**
 * Catalog of every interactive surface (button / link / kbd-bound) in the
 * (app) route group. Each entry is a stable data-testid that MUST be present
 * in the rendered DOM — used by tests/e2e/button-audit.spec.ts for parametric
 * click verification (Phase 11 Plan 11-08, Wave 4).
 *
 * Wave 3 (Plan 11-07 — button audit) populates this file. Wave 0 ships an
 * empty stub so downstream test files (button-audit.spec.ts) can import
 * BUTTON_REGISTRY without breaking the build.
 *
 * Source of truth: `.planning/phases/11-.../11-BUTTON-AUDIT.md`. Only KEEP
 * + WIRE rows are listed here — REMOVED surfaces no longer exist in the
 * DOM, NO-OP surfaces are non-interactive, NOT-BUILT surfaces are deferred.
 *
 * Contract per entry:
 *   - id:     data-testid attribute on the rendered element
 *   - route:  page where the element lives (path under /app)
 *   - expect: 'navigate' (URL changes) | 'request' (network call fires) |
 *             'kbd' (keyboard-bound, asserted separately) |
 *             'open' (opens overlay/dialog/sheet/dropdown) |
 *             'select' (selects an item without nav)
 *
 * D-06 (CONTEXT.md): every <button>, <Link>, kbd shortcut, tab, filter,
 * search, settings entry across the (app) route group MUST appear here OR
 * be removed from the UI. Plan 11-07 enforces the audit; Plan 11-08
 * activates the parametric test.
 */
export type ButtonRegistryEntry = {
  readonly id: string;
  readonly route: string;
  readonly expect: 'navigate' | 'request' | 'kbd' | 'open' | 'select';
};

export const BUTTON_REGISTRY: ReadonlyArray<ButtonRegistryEntry> = [
  // --- Sidebar (visible on every route — pick /today as the reference) ---
  { id: 'nav-today', route: '/today', expect: 'navigate' },
  { id: 'nav-inbox', route: '/today', expect: 'navigate' },
  { id: 'nav-calendar', route: '/today', expect: 'navigate' },
  { id: 'nav-integrations-health', route: '/today', expect: 'navigate' },
  { id: 'nav-chat', route: '/today', expect: 'navigate' },
  { id: 'nav-people', route: '/today', expect: 'navigate' },
  { id: 'nav-projects', route: '/today', expect: 'navigate' },
  { id: 'sidebar-cmdk', route: '/today', expect: 'open' },
  { id: 'sidebar-logout', route: '/today', expect: 'navigate' },

  // --- Topbar (also visible on every route) ---
  { id: 'topbar-cmdk', route: '/today', expect: 'open' },
  { id: 'topbar-new-capture', route: '/today', expect: 'open' },
  { id: 'topbar-user-menu', route: '/today', expect: 'open' },

  // --- ChatBubble (mounted globally) ---
  { id: 'chat-bubble', route: '/today', expect: 'open' },

  // --- /today ---
  { id: 'today-composer-send', route: '/today', expect: 'request' },
  { id: 'drafts-approve', route: '/today', expect: 'navigate' },
  { id: 'drafts-edit', route: '/today', expect: 'navigate' },
  { id: 'drafts-skip', route: '/today', expect: 'navigate' },
  { id: 'dropped-row', route: '/today', expect: 'navigate' },
  { id: 'mc-channel-bar', route: '/today', expect: 'navigate' },

  // --- /inbox ---
  { id: 'inbox-row-click', route: '/inbox', expect: 'select' },
  { id: 'inbox-approve-btn', route: '/inbox', expect: 'request' },
  { id: 'inbox-edit-btn', route: '/inbox', expect: 'open' },
  { id: 'inbox-skip-btn', route: '/inbox', expect: 'request' },

  // --- /entities (filter chips render only when no ?type= filter) ---
  { id: 'entity-filter-person', route: '/entities', expect: 'navigate' },
  { id: 'entity-filter-project', route: '/entities', expect: 'navigate' },
  { id: 'entity-filter-company', route: '/entities', expect: 'navigate' },
  { id: 'entity-filter-document', route: '/entities', expect: 'navigate' },

  // --- /chat (Phase 11-ter shell) ---
  { id: 'chat-page', route: '/chat', expect: 'select' },
];
