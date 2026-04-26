import { test, expect } from '@playwright/test';

/**
 * Today view smoke E2E (Plan 03-08, extended Phase 11 Plan 11-04).
 *
 * Phase 3 baseline asserts the existing top-level layout sections render and
 * the shell chrome is present. Full SSE round-trip is covered by Plan 03-12.
 *
 * Phase 11 (Plan 11-04) extends this file with skipped placeholders for the
 * three new mission-control surfaces: stat-tile strip, channel-health strip,
 * captures-today list. Wave 2 implements them.
 *
 * Skipped unless PLAYWRIGHT_BASE_URL is set (needs a preview URL or local
 * `next dev` + reachable dashboard-api).
 */
test.describe('today', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  test('renders top-level sections (Brief, Top 3, Drafts, Composer)', async ({
    page,
  }) => {
    await page.goto('/today');
    await expect(
      page.getByRole('heading', { name: /Today/i, level: 1 }),
    ).toBeVisible();
    await expect(page.locator('.brief')).toBeVisible();
    await expect(page.getByText(/TOP 3 PRIORITIES/)).toBeVisible();
    await expect(page.getByText(/DRAFTS TO REVIEW/)).toBeVisible();
    await expect(
      page.getByPlaceholder('Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.'),
    ).toBeVisible();
  });

  test('stat tile strip renders 4 tiles', async ({ page }) => {
    test.skip(true, 'Wave 2 will implement (Plan 11-04)');
    await page.goto('/today');
    // Expected tiles: CAPTURES TODAY / DRAFTS PENDING / ENTITIES ACTIVE / EVENTS UPCOMING
    const tiles = page.locator('[data-testid^="stat-tile-"]');
    await expect(tiles).toHaveCount(4);
  });

  test('channel-health strip links to /integrations-health', async ({ page }) => {
    test.skip(true, 'Wave 2 will implement (Plan 11-04 + Plan 11-06)');
    await page.goto('/today');
    const channelStrip = page.getByTestId('today-channel-health');
    await expect(channelStrip).toBeVisible();
    await channelStrip.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/integrations-health$/);
  });

  test('captures-today list shows email + telegram + granola sources', async ({ page }) => {
    test.skip(true, 'Wave 2 will implement (Plan 11-04)');
    await page.goto('/today');
    const list = page.getByTestId('today-captures-list');
    await expect(list).toBeVisible();
    // Each row has a data-source attribute one of: email | telegram | granola | chrome | linkedin | mention
    await expect(list.locator('[data-source="email"]').first()).toBeVisible();
  });
});
