import { test, expect } from './fixtures';

// Plan 03-10 Task 1 — entity dossier (Person + Project per D-03).
// Requires PLAYWRIGHT_BASE_URL + KOS_TEST_BEARER_TOKEN + KOS_TEST_ENTITY_ID.
const SEEDED = process.env.KOS_TEST_ENTITY_ID;

test.describe('entity', () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'needs deployed preview');
  test.skip(!SEEDED, 'KOS_TEST_ENTITY_ID must point at a seeded Person');

  test('Person dossier renders AI block + stats + linked projects', async ({ page }) => {
    await page.goto(`/entities/${SEEDED}`);
    await expect(page.getByTestId('entity-dossier')).toBeVisible();
    await expect(page.getByTestId('ai-block')).toBeVisible();
    await expect(page.getByTestId('stats-rail')).toBeVisible();
    await expect(page.getByTestId('linked-work')).toBeVisible();
    await expect(page.getByTestId('edit-entity-button')).toBeVisible();
    await expect(page.getByTestId('merge-duplicates-link')).toHaveAttribute(
      'href',
      new RegExp(`/entities/${SEEDED}/merge$`),
    );
  });
});
