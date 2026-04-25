import { test, expect } from './fixtures';

// Plan 03-10 Task 3 — Calendar Week view (Command Center Deadline + Idag).
test.describe('calendar', () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'needs deployed preview');

  test('renders week grid + disabled Month tab', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    // Either the grid or the empty state must render — both prove routing works.
    const grid = page.getByTestId('calendar-week');
    await expect(grid).toBeVisible();
    // Month tab is present but disabled with the Phase 8 tooltip.
    const monthTab = page.getByTestId('month-tab');
    await expect(monthTab).toBeDisabled();
  });

  test('event bars carry bolag data attribute when present', async ({ page }) => {
    // Only runs when KOS_TEST_EXPECT_EVENTS=1 (preview has seeded Command Center rows).
    test.skip(
      process.env.KOS_TEST_EXPECT_EVENTS !== '1',
      'preview must have seeded Command Center events',
    );
    await page.goto('/calendar');
    const events = page.getByTestId('calendar-event');
    await expect(events.first()).toBeVisible();
    // bolag attribute is one of the three known classes.
    const bolagAttr = await events.first().getAttribute('data-bolag');
    expect(bolagAttr).toMatch(/^bolag-(tf|ob|pe)$/);
  });
});
