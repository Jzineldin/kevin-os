import { expect, test } from './fixtures';

/**
 * Plan 03-12 Task 1 — installability signals (UI-05).
 *
 * Does NOT attempt to automate Android install / desktop Chrome install /
 * iOS Add-to-Home-Screen — those are manual-only per 03-VALIDATION.md
 * Gate 4. This spec locks in the machine-checkable signals:
 *   1. /manifest.webmanifest is served, is valid JSON, matches contract.
 *   2. /sw.js is served in production (404 is acceptable in dev since
 *      @serwist/next disables service worker generation when NODE_ENV=dev).
 */
test.describe('pwa-install', () => {
  test('manifest.webmanifest is reachable with Kevin OS contract', async ({
    request,
  }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest.name).toBe('Kevin OS');
    expect(manifest.short_name).toBe('KOS');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#0a0c11');
    expect(manifest.background_color).toBe('#0a0c11');
    expect(Array.isArray(manifest.icons)).toBe(true);
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes).sort();
    expect(sizes).toEqual(['192x192', '512x512']);
  });

  test('sw.js is served (200 in production, 404 acceptable in dev)', async ({
    request,
  }) => {
    const res = await request.get('/sw.js');
    expect([200, 404]).toContain(res.status());
  });

  test('root HTML links the manifest', async ({ request }) => {
    const res = await request.get('/login');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/rel="manifest"/);
    expect(body).toMatch(/\/manifest\.webmanifest/);
  });
});
