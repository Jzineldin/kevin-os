import { test, expect } from '@playwright/test';

/**
 * Visual regression baseline (Phase 11 Plan 11-08 — Wave 4 activates).
 *
 * Wave 0 ships skipped placeholders. Pre-rebuild PNG references live at
 * apps/dashboard/tests/visual-baseline/{today,inbox,entities,calendar}.png
 * — captured against the deployed Vercel dashboard before the rebuild
 * starts (see Plan 11-00 Task 1).
 *
 * After Wave 4 the rebuilt UI must NOT silently regress against post-rebuild
 * baselines. Wave 4 will:
 *   1. flip these tests from `.skip()` to active by removing `test.skip(...)`
 *   2. seed canonical test data (or auth as a known fixture user)
 *   3. run `playwright test --update-snapshots` once to lock in the
 *      post-rebuild baselines
 *   4. CI then fails on any unintentional pixel drift
 *
 * The PLAYWRIGHT_BASE_URL skip-guard mirrors today.spec.ts. The pre-rebuild
 * PNG references in tests/visual-baseline/ are NOT used by toHaveScreenshot()
 * — they are evidence-of-state, not Playwright snapshots.
 */
const ROUTES = ['/today', '/inbox', '/entities', '/calendar', '/integrations-health'] as const;

test.describe('visual regression (mission-control rebuild)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  for (const route of ROUTES) {
    test(`visual baseline ${route}`, async ({ page }) => {
      test.skip(true, 'Wave 4 (Plan 11-08) activates visual regression');
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveScreenshot(`${route.replace(/\//g, '_').replace(/^_/, '')}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
