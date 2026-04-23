import { test, expect } from './fixtures';

// Maps to ENT-07 (03-VALIDATION.md Wave 0). Plan 03-11 ships the real
// transactional merge handler + review page; this spec lives as a
// preview-URL E2E that runs only when the caller provides two seeded
// entity ids (PLAYWRIGHT_SEED_SOURCE + PLAYWRIGHT_SEED_TARGET). Without
// the seed the run skips - the full round-trip requires a live
// dashboard-api Function URL + RDS, which is a Plan 12 responsibility.
test.describe('merge-audit', () => {
  test('Merge review page renders UI-SPEC-verbatim dialog copy', async ({
    page,
  }) => {
    const source = process.env.PLAYWRIGHT_SEED_SOURCE;
    const target = process.env.PLAYWRIGHT_SEED_TARGET;
    test.skip(
      !process.env.PLAYWRIGHT_BASE_URL || !source || !target,
      'needs PLAYWRIGHT_BASE_URL + seeded source+target entity ids',
    );

    await page.goto(`/entities/${target}/merge?source=${source}`);

    // Two-column layout + ARCHIVING eyebrow on source (UI-SPEC §View 3.5).
    await expect(page.getByTestId('merge-target-card')).toBeVisible();
    await expect(page.getByTestId('merge-source-card')).toBeVisible();
    await expect(page.getByText('ARCHIVING')).toBeVisible();

    // Action bar primary opens the shadcn Dialog.
    await page.getByRole('button', { name: 'Confirm merge' }).click();

    // UI-SPEC Copywriting table (binding) — verbatim assertions.
    await expect(page.getByRole('heading', { name: /^Merge .* into .*\?$/ })).toBeVisible();
    await expect(page.getByText(/archived, not deleted/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Yes, merge' })).toBeVisible();
  });

  test('Partial merge failure redirects to Inbox Resume card (feature flag)', async ({
    page,
  }) => {
    // Explicitly opt-in — requires a dashboard-api instance that has been
    // seeded with a deliberately-failing Notion fixture + the target/source
    // pair. Plan 12 wires this up against the Vercel preview.
    test.skip(
      !process.env.PLAYWRIGHT_E2E_MERGE_FAILURE,
      'requires PLAYWRIGHT_E2E_MERGE_FAILURE + seeded failure fixture',
    );

    const source = process.env.PLAYWRIGHT_SEED_SOURCE!;
    const target = process.env.PLAYWRIGHT_SEED_TARGET!;
    await page.goto(`/entities/${target}/merge?source=${source}`);
    await page.getByRole('button', { name: 'Confirm merge' }).click();
    await page.getByRole('button', { name: 'Yes, merge' }).click();

    // On failure the Server Action redirects to /inbox?focus=resume-<merge_id>.
    await page.waitForURL(/\/inbox\?focus=resume-/);
    await expect(page.getByRole('heading', { name: 'Resume merge?' })).toBeVisible();
  });
});
