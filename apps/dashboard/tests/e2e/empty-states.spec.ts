import { test, expect } from '@playwright/test';

/**
 * Empty-state regression — Phase 11 D-12: every (app) page must render a
 * graceful informative empty-state when the underlying data set is zero.
 *
 * Activated by Wave 4 (Plan 11-08). Each route has a slightly different
 * empty-state contract. We treat "live data present" and "empty-state copy
 * present" as both acceptable — the test only fails if neither shows up,
 * which would indicate the page crashed or rendered blank.
 *
 * Empty-state copy contract (per CONTEXT D-12 + Plan 11-04 / 11-06 outputs):
 *   - /today              "No captures today" (CapturesList empty state)
 *   - /inbox              "Inbox clear. ✅" (InboxClient empty state)
 *   - /entities           heading present (page does not crash even if list empty)
 *   - /calendar           "No meetings" / "calendar is clear" / "Nothing on your calendar"
 *   - /integrations-health view root present even with zero channels
 */
test.describe('empty states — Phase 11 D-12', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  test('/inbox empty state copy or live rows', async ({ page }) => {
    await page.goto('/inbox');
    const rowCount = await page.locator('[data-testid="inbox-row-pill"]').count();
    if (rowCount === 0) {
      await expect(page.getByText(/Inbox clear|No.*captures|empty/i).first()).toBeVisible();
    } else {
      // Live rows present — empty-state path covered when DB is empty.
      test.info().annotations.push({
        type: 'note',
        description: 'Inbox has live items; empty-state path verified when DB is empty.',
      });
    }
  });

  test('/today CapturesList empty state', async ({ page }) => {
    await page.goto('/today');
    const empty = page.locator('[data-testid="captures-list-empty"]');
    const list = page.locator('[data-testid="captures-list"]');
    const hasEmpty = (await empty.count()) > 0;
    const hasList = (await list.count()) > 0;
    expect(hasEmpty || hasList).toBe(true);
    if (hasEmpty) {
      await expect(empty).toContainText(/No captures today/i);
    }
  });

  test('/calendar empty state copy when no events this week', async ({ page }) => {
    await page.goto('/calendar');
    const eventCount = await page.locator('[data-testid^="cal-event-"]').count();
    if (eventCount === 0) {
      await expect(
        page
          .getByText(/calendar is clear|No meetings|Nothing on your calendar/i)
          .first(),
      ).toBeVisible();
    } else {
      test.info().annotations.push({
        type: 'note',
        description:
          'Calendar has events; empty-state path not applicable this run.',
      });
    }
  });

  test('/integrations-health renders even with zero channels', async ({ page }) => {
    await page.goto('/integrations-health');
    await expect(
      page.locator('[data-testid="integrations-health-view"]'),
    ).toBeVisible();
  });

  test('/entities renders without crashing when filter is empty', async ({ page }) => {
    await page.goto('/entities');
    // Page must render without crashing even if entity list is empty —
    // assert the topbar heading + at least one in-page heading.
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});
