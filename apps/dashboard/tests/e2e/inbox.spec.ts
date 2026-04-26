import { test, expect } from '@playwright/test';

/**
 * Inbox E2E (Phase 11 Plan 11-03 — D-05: drop urgent-only filter, surface ALL
 * classifications with status pills).
 *
 * Skipped unless PLAYWRIGHT_BASE_URL is set. The inbox is data-driven; the
 * tests degrade gracefully when the live preview env happens to have an
 * empty inbox (no classified rows + no entity routings + no dead-letters).
 *
 * - "renders pills for classified email rows": after D-05 lands, the inbox
 *   must show classified email rows each with a Pill component
 *   (data-testid `inbox-row-pill`).
 * - "approve hidden on terminal status": skipped/sent/failed rows must NOT
 *   render the Approve / Skip controls (read-only display).
 * - "keyboard J/K still navigates after redesign": D-11 accessibility floor
 *   regression check.
 */
test.describe('inbox (Phase 11 — classification + status flows)', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  test('renders pills for classified email rows (or shows empty state)', async ({
    page,
  }) => {
    await page.goto('/inbox');
    const pills = page.locator('[data-testid="inbox-row-pill"]');
    const empty = page.getByText('Inbox clear. ✅');

    await expect(pills.first().or(empty)).toBeVisible({ timeout: 30_000 });
    if (await empty.isVisible().catch(() => false)) {
      test.info().annotations.push({
        type: 'note',
        description:
          'empty inbox in this preview env — live pill rendering verified by Plan 11-03 unit + visual baseline',
      });
      return;
    }
    // At least one pill rendered.
    const count = await pills.count();
    expect(count).toBeGreaterThan(0);
  });

  test('approve button hidden on terminal-status item', async ({ page }) => {
    await page.goto('/inbox');
    const empty = page.getByText('Inbox clear. ✅');
    if (await empty.isVisible().catch(() => false)) {
      test.skip(true, 'empty inbox — terminal row not available in this env');
      return;
    }

    // Find a row pill text indicating terminal status. Pill labels per
    // Plan 11-02 mapping table:
    //   URGENT — Sent / URGENT — Failed / Skipped (any classification).
    const sent = page.getByText('URGENT — Sent').first();
    const skipped = page.getByText('Skipped').first();
    const terminalPill = (await sent.count()) > 0 ? sent : skipped;

    if ((await terminalPill.count()) === 0) {
      test.skip(
        true,
        'no terminal-status rows in this env — single-tenant data variability',
      );
      return;
    }

    await terminalPill.click();
    // Detail-pane Approve button is hidden — count() should be 0.
    await expect(
      page.locator('[data-testid="inbox-approve-btn"]'),
    ).toHaveCount(0);
  });

  test('keyboard J/K still navigates after redesign (D-11 floor)', async ({
    page,
  }) => {
    await page.goto('/inbox');
    const empty = page.getByText('Inbox clear. ✅');
    const legend = page.getByText(
      /J \/ K to nav · Enter approve · E edit · S skip/,
    );
    await expect(empty.or(legend)).toBeVisible({ timeout: 30_000 });

    if (await empty.isVisible().catch(() => false)) {
      test.info().annotations.push({
        type: 'note',
        description: 'empty inbox — keyboard contract verified by unit suite',
      });
      return;
    }

    // J/K bounded — never errors, never overflows. After two presses
    // (one down + one up) the selection should still be on a valid row.
    await page.keyboard.press('j');
    await page.waitForTimeout(150);
    await page.keyboard.press('k');
    await page.waitForTimeout(150);
    const selectedCount = await page
      .locator('[aria-pressed="true"]')
      .count();
    expect(selectedCount).toBeGreaterThanOrEqual(1);
  });
});
