import { test, expect } from '@playwright/test';

/**
 * Visual regression — Phase 11 mission-control rebuild (Plan 11-08, Wave 4).
 *
 * Activated by Wave 4. Captures full-page screenshots of every (app) route and
 * compares them against the Phase-11-final baselines stored under
 * `__screenshots__/visual.spec.ts/`. The Wave 0 reference PNGs in
 * `tests/visual-baseline/` are kept as evidence-of-pre-rebuild state but are
 * NOT consumed by Playwright's `toHaveScreenshot()`.
 *
 * On first green run after Kevin's visual sign-off, run once with
 * `--update-snapshots` to lock in the post-rebuild baselines, commit the new
 * `__screenshots__/` directory, then re-run to confirm green.
 *
 * Skipped unless `PLAYWRIGHT_BASE_URL` is set so CI default `pnpm -r test`
 * never blocks on missing browsers.
 */
const ROUTES = [
  '/today',
  '/inbox',
  '/entities',
  '/calendar',
  '/integrations-health',
  '/chat',
] as const;

test.describe('visual regression — Phase 11 mission-control rebuild', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  for (const route of ROUTES) {
    test(`visual: ${route}`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle').catch(() => {
        // some routes use streaming SSR + SSE; fall back to domcontentloaded
        return page.waitForLoadState('domcontentloaded');
      });
      // Tolerance: 2% pixel diff covers minor rendering jitter (font kerning,
      // antialiasing, retry races on streaming data) without masking real
      // regressions like layout shift or color palette drift.
      await expect(page).toHaveScreenshot(
        `${route.replace(/\//g, '_').replace(/^_/, '')}.png`,
        {
          fullPage: true,
          maxDiffPixelRatio: 0.02,
          threshold: 0.2,
        },
      );
    });
  }
});
