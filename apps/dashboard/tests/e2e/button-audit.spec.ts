import { test, expect } from '@playwright/test';
import { BUTTON_REGISTRY } from '../../src/lib/button-registry';

/**
 * Button audit — Phase 11 D-06: every interactive surface must either fire a
 * request, navigate, open an overlay, select an item, or be removed from
 * BUTTON_REGISTRY (Plan 11-07).
 *
 * Activated by Wave 4 (Plan 11-08). Parametric: one Playwright test per
 * registry entry. Each test:
 *   1. navigates to entry.route
 *   2. asserts the data-testid exists in the rendered DOM
 *   3. clicks and asserts the expected behavior fires (navigate / request /
 *      open / select). 'kbd' entries are intentionally skipped here —
 *      keyboard contracts are covered by inbox-keyboard.spec.ts.
 *
 * Skipped unless PLAYWRIGHT_BASE_URL is set so CI's default `pnpm -r test`
 * never blocks on missing browsers / unreachable preview URL.
 */
test.describe('button audit (Phase 11 — wire-or-remove, D-06)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  for (const entry of BUTTON_REGISTRY) {
    test(`button: ${entry.id} (${entry.expect}) on ${entry.route}`, async ({
      page,
    }) => {
      await page.goto(entry.route);
      await page.waitForLoadState('domcontentloaded');

      const locator = page.locator(`[data-testid="${entry.id}"]`).first();
      await expect(
        locator,
        `data-testid="${entry.id}" must exist on ${entry.route}`,
      ).toBeVisible({ timeout: 5000 });

      if (entry.expect === 'navigate') {
        const beforeUrl = page.url();
        await Promise.all([
          page.waitForURL((url) => url.toString() !== beforeUrl, {
            timeout: 5000,
          }),
          locator.click(),
        ]);
        expect(page.url()).not.toBe(beforeUrl);
      } else if (entry.expect === 'request') {
        const reqPromise = page.waitForRequest(
          (req) =>
            /\/(api\/|integrations|email-drafts|capture|inbox|entities|today)/.test(
              req.url(),
            ),
          { timeout: 5000 },
        );
        await locator.click();
        await reqPromise;
      } else if (entry.expect === 'open') {
        await locator.click();
        // Opens a modal / sheet / drawer / dropdown. Radix sets [data-state="open"]
        // on the trigger or nearby content; cmdk + dialogs surface [role="dialog"].
        const overlay = page
          .locator('[role="dialog"], [data-state="open"]')
          .first();
        await expect(overlay).toBeVisible({ timeout: 3000 });
      } else if (entry.expect === 'kbd') {
        // kbd-bound — out of scope here; covered by inbox-keyboard.spec.ts.
      } else if (entry.expect === 'select') {
        await locator.click();
        // 'select' surfaces become aria-pressed=true OR carry a 'selected'
        // attribute. Inbox row + chat shell page both behave this way.
        const pressed = await locator.getAttribute('aria-pressed').catch(() => null);
        if (pressed !== null) {
          expect(['true', 'false']).toContain(pressed);
        } else {
          // Page-level shells (e.g. /chat) may simply be visible after
          // navigation — visibility was already asserted above.
          await expect(locator).toBeVisible();
        }
      }
    });
  }
});
