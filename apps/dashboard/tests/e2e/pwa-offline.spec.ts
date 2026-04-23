import { expect, test } from './fixtures';

/**
 * Plan 03-12 Task 1 — offline behaviour (UI-05).
 *
 * Exercises the SW-cached `/today` path. Skipped locally unless
 * PLAYWRIGHT_BASE_URL is set to a real deployed URL where the SW has had a
 * chance to install + runtime-cache on the first visit. @serwist/next
 * disables SW generation in dev, so running against `next dev` would be a
 * false negative.
 *
 * The "offline banner visible" assertion uses the verbatim copy from
 * 03-UI-SPEC §Copywriting "Offline banner (PWA)":
 *   "Offline · last synced {relative time} · some actions disabled"
 */
test.describe('pwa-offline', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'requires deployed preview URL where @serwist/next ran build-time SW generation',
  );

  test('cached /today renders when offline + OfflineBanner visible', async ({
    page,
    context,
  }) => {
    // First visit — warm the SW cache for /today HTML + /api/today JSON.
    await page.goto('/today');
    await page.waitForLoadState('networkidle');

    // Give the SW one tick to claim + cache.
    await page.waitForFunction(() =>
      navigator.serviceWorker?.controller != null, { timeout: 5000 },
    ).catch(() => {
      // If the SW never claimed (first visit race), bail — the real
      // integration test runs on a second visit where it's already active.
    });

    // Simulate network loss, then reload.
    await context.setOffline(true);
    await page.reload();

    // Cached Today content OR the /offline fallback is acceptable — both
    // prove the SW is doing its job.
    await expect(page.locator('main')).toBeVisible();

    // The OfflineBanner copy must be present (fixed-top, role=status).
    const banner = page.getByRole('status').filter({ hasText: /Offline/ });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('some actions disabled');

    await context.setOffline(false);
  });
});
