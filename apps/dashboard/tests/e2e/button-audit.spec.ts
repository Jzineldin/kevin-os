import { test, expect } from '@playwright/test';
import { BUTTON_REGISTRY } from '../../src/lib/button-registry';

/**
 * Button audit (Phase 11 Plan 11-07 — D-06: every interactive surface must
 * either fire a request, navigate, or be removed).
 *
 * Parametric test that iterates over BUTTON_REGISTRY (Wave 3 populates;
 * Wave 0 ships an empty array). Each entry has:
 *   - id: stable data-testid that MUST exist in the rendered DOM
 *   - route: page where the button lives
 *   - expect: 'navigate' | 'request' | 'kbd' — what should happen on click
 *
 * Wave 4 (Plan 11-08) flips this whole describe-block from .skip() to
 * active once the registry is populated.
 *
 * Skipped unless PLAYWRIGHT_BASE_URL is set.
 */
test.describe('button audit (Phase 11 — wire-or-remove)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  for (const entry of BUTTON_REGISTRY) {
    test(`button ${entry.id} on ${entry.route} ${entry.expect}s on click`, async ({
      page,
    }) => {
      test.skip(true, 'Wave 4 (Plan 11-08) activates after Wave 3 populates the registry');
      await page.goto(entry.route);
      const target = page.locator(`[data-testid="${entry.id}"]`);
      await expect(target).toBeVisible();

      if (entry.expect === 'navigate') {
        const before = page.url();
        await target.click();
        await expect.poll(() => page.url()).not.toBe(before);
      } else if (entry.expect === 'request') {
        const reqPromise = page.waitForRequest(() => true, { timeout: 5_000 });
        await target.click();
        await reqPromise;
      } else {
        // 'kbd' — keyboard-bound surfaces verified separately
      }
    });
  }

  // When BUTTON_REGISTRY is empty (Wave 0..2), still emit one placeholder
  // so the file's test count is non-zero and vitest/playwright pickup is
  // confirmed at infrastructure level.
  if (BUTTON_REGISTRY.length === 0) {
    test('placeholder — BUTTON_REGISTRY not yet populated', async () => {
      test.skip(true, 'Wave 3 (Plan 11-07) populates the registry');
    });
  }
});
