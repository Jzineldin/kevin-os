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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
  ],
  reporter: [['list']],
  retries: process.env.CI ? 2 : 0,
});
