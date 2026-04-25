import { test, expect } from '@playwright/test';

/**
 * Today view smoke E2E (Plan 03-08). Asserts the top-level layout sections
 * render and the shell chrome is present. Full SSE round-trip is covered
 * by Plan 03-12.
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
});
