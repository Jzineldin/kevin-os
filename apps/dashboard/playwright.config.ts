import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for @kos/dashboard E2E tests.
 *
 * Two projects:
 *   - `chromium`         — desktop primary surface.
 *   - `mobile-android`   — Pixel 7 viewport, covers UI-05 PWA install flow
 *                          and responsive breakpoints.
 *
 * `baseURL` is driven by `PLAYWRIGHT_BASE_URL` so CI can point at a
 * Vercel preview URL without any config edit. Local default is the
 * `next dev` server on :3000.
 *
 * `storageState` carries the httpOnly `kos_session` cookie produced by
 * the auth fixture (tests/e2e/fixtures.ts). Fixture populates it at
 * global-setup time in later waves; Wave 0 skeleton leaves it unset.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    storageState: process.env.PLAYWRIGHT_STORAGE_STATE,
    trace: 'on-first-retry',
  },
  // Phase 11 Plan 11-08 — visual regression defaults. 2% pixel-diff tolerance
  // is the floor across all toHaveScreenshot() calls; individual specs may
  // tighten or loosen per-route via the options arg. Snapshots live under
  // tests/e2e/__screenshots__/<testFilePath>/<arg>.png so the Phase-11-final
  // baselines are co-located with the spec that produced them.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
  ],
  reporter: [['list']],
  retries: process.env.CI ? 2 : 0,
});
