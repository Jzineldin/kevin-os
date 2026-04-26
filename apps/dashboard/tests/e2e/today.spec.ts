import { test, expect } from '@playwright/test';

/**
 * Today view smoke E2E (Plan 03-08, extended Phase 11 Plan 11-04).
 *
 * Phase 3 baseline asserts the existing top-level layout sections render and
 * the shell chrome is present. Full SSE round-trip is covered by Plan 03-12.
 *
 * Phase 11 (Plan 11-04) adds real assertions for the three new
 * mission-control surfaces: stat-tile strip, channel-health strip,
 * captures-today list. All tests run against PLAYWRIGHT_BASE_URL.
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

  test('stat-tile strip renders 4 tiles', async ({ page }) => {
    await page.goto('/today');
    const strip = page.locator('[data-testid="stat-tile-strip"]');
    await expect(strip).toBeVisible();
    // 4 StatTile components inside the strip (mc-stat-tile class from Plan 11-02).
    const tiles = strip.locator('.mc-stat-tile');
    await expect(tiles).toHaveCount(4);
  });

  test('stat-tile strip labels match spec', async ({ page }) => {
    await page.goto('/today');
    for (const label of [
      'CAPTURES TODAY',
      'DRAFTS PENDING',
      'ENTITIES ACTIVE',
      'EVENTS UPCOMING',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('channel-health strip renders and links to /integrations-health', async ({
    page,
  }) => {
    await page.goto('/today');
    const strip = page.locator('[data-testid="channel-health-strip"]');
    await expect(strip).toBeVisible();
    // Each channel row is a Link to /integrations-health (per Plan 11-02
    // ChannelHealth.tsx). When at least one channel is present the link
    // exists; if none, the empty-state renders the no-channels message.
    const links = strip.locator('a[href="/integrations-health"]');
    const linkCount = await links.count();
    if (linkCount > 0) {
      await expect(links.first()).toBeVisible();
    } else {
      await expect(strip).toContainText(/No channels configured/i);
    }
  });

  test('captures-today list renders or shows empty state', async ({ page }) => {
    await page.goto('/today');
    const list = page.locator('[data-testid="captures-list"]');
    const empty = page.locator('[data-testid="captures-list-empty"]');
    const hasList = (await list.count()) > 0;
    const hasEmpty = (await empty.count()) > 0;
    expect(hasList || hasEmpty).toBe(true);
    if (hasEmpty) {
      await expect(empty).toContainText(/No captures today/i);
    } else {
      // When non-empty, every row carries a data-source attribute that is one
      // of the 5 sources verified in Wave 0 (capture_text/capture_voice DO
      // NOT EXIST per 11-WAVE-0-SCHEMA-VERIFICATION.md).
      const rows = list.locator('[data-testid="capture-row"]');
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);
      const allowedSources = ['email', 'mention', 'event', 'inbox', 'telegram_queue'];
      const sources = await rows.evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).dataset.source ?? ''),
      );
      for (const s of sources) {
        expect(allowedSources).toContain(s);
      }
    }
  });
});
