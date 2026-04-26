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
 * Contract per entry:
 *   - id:     data-testid attribute on the rendered element
 *   - route:  page where the element lives (path under /app)
 *   - expect: 'navigate' (URL changes) | 'request' (network call fires) |
 *             'kbd' (keyboard-bound, asserted separately)
 *
 * D-06 (CONTEXT.md): every <button>, <Link>, kbd shortcut, tab, filter,
 * search, settings entry across the (app) route group MUST appear here OR
 * be removed from the UI. Plan 11-07 enforces the audit; Plan 11-08
 * activates the parametric test.
 */
export type ButtonRegistryEntry = {
  readonly id: string;
  readonly route: string;
  readonly expect: 'navigate' | 'request' | 'kbd';
};

export const BUTTON_REGISTRY: ReadonlyArray<ButtonRegistryEntry> = [];
