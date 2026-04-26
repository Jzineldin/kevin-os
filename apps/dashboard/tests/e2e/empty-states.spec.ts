import { test, expect } from '@playwright/test';

/**
 * Empty-state regression (Phase 11 Plan 11-08 — D-12: every page must
 * render gracefully when there is zero data).
 *
 * Wave 0 ships skipped placeholders. Wave 4 implements:
 *   1. authenticate as a known empty-DB fixture (or run with the prod
 *      kos_session cookie + a clean test owner_id)
 *   2. visit each route, assert the empty-state copy renders
 *
 * Empty-state contract (per CONTEXT D-12 + RESEARCH §"Empty state"):
 *   - "No captures today — KOS will surface as they arrive" (today)
 *   - "Inbox clear. ✅" (inbox)
 *   - "No entities yet" (entities)
 *   - "Nothing on your calendar today." (calendar)
 *   - "All channels healthy" (integrations-health)
 *
 * NEVER blank — informative copy mandated by D-12.
 */
const ROUTES: Array<{ path: string; emptyCopy: RegExp }> = [
  { path: '/today', emptyCopy: /No captures today/i },
  { path: '/inbox', emptyCopy: /Inbox clear/i },
  { path: '/entities', emptyCopy: /No entities/i },
  { path: '/calendar', emptyCopy: /Nothing on your calendar/i },
  { path: '/integrations-health', emptyCopy: /All channels healthy|No channels/i },
];

test.describe('empty states (D-12)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  for (const { path, emptyCopy } of ROUTES) {
    test(`${path} renders informative empty state with zero data`, async ({ page }) => {
      test.skip(true, 'Wave 4 (Plan 11-08) implements empty-DB fixture + assertions');
      await page.goto(path);
      await expect(page.getByText(emptyCopy)).toBeVisible();
    });
  }
});
