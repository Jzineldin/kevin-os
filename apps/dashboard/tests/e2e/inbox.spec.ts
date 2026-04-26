import { test, expect } from '@playwright/test';

/**
 * Inbox E2E (Phase 11 Plan 11-03 — D-05: drop urgent-only filter, surface ALL
 * classifications with status pills).
 *
 * Wave 0 ships skipped placeholders so Wave 2/3 can fill them in without
 * touching the test infrastructure. Mirrors `inbox-keyboard.spec.ts`'s
 * PLAYWRIGHT_BASE_URL skip-guard pattern.
 *
 * - "all classifications render with pills": after D-05 lands, the inbox must
 *   show urgent / important / informational / junk items each with a Pill
 *   component carrying the right tone.
 * - "approve flow on draft": Approve button on a draft-status row → server
 *   action fires; row dissolves on optimistic re-render.
 * - "skip is hidden on terminal status": skipped/sent/failed rows must NOT
 *   render the Approve / Skip controls (read-only).
 */
test.describe('inbox (Phase 11 — classification + status flows)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  test('all classifications render with pills', async ({ page }) => {
    test.skip(true, 'Wave 2 will implement (Plan 11-03)');
    await page.goto('/inbox');
    await expect(page.getByTestId('pill-classification-urgent').first()).toBeVisible();
    await expect(page.getByTestId('pill-classification-informational').first()).toBeVisible();
  });

  test('approve flow on draft', async ({ page }) => {
    test.skip(true, 'Wave 2 will implement (Plan 11-03)');
    await page.goto('/inbox');
    const firstApprove = page.getByRole('button', { name: /^Approve$/ }).first();
    await firstApprove.click();
    // Server action → optimistic dissolve. Wave 2 fills the assertion.
  });

  test('skip is hidden on terminal status', async ({ page }) => {
    test.skip(true, 'Wave 2 will implement (Plan 11-03)');
    await page.goto('/inbox');
    // Find a row tagged with status="skipped" or "sent" — assert no Approve / Skip buttons.
  });
});
