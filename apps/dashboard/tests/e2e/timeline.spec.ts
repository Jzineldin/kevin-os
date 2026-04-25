import { test, expect } from './fixtures';

// Plan 03-10 Task 2 — react-window v2 virtualization + cursor pagination.
const SEEDED = process.env.KOS_TEST_ENTITY_ID;

test.describe('timeline', () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'needs deployed preview');
  test.skip(!SEEDED, 'KOS_TEST_ENTITY_ID must point at a seeded Person');

  test('initial rows render from SSR', async ({ page }) => {
    await page.goto(`/entities/${SEEDED}`);
    const list = page.getByTestId('timeline-list');
    await expect(list).toBeVisible();
    const rows = page.getByTestId('timeline-row');
    // At least one row — the seeded entity must have some mention_events.
    await expect(rows.first()).toBeVisible();
  });
});
