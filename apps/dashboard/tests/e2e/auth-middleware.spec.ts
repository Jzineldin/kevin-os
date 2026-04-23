import { test, expect } from './fixtures';

/**
 * Auth middleware E2E — maps to INF-12 (03-VALIDATION.md Wave 0).
 *
 * Requires a running dev server or Vercel preview URL with:
 *   - KOS_DASHBOARD_BEARER_TOKEN set server-side
 *   - KOS_TEST_BEARER_TOKEN in the Playwright runner env (must match)
 *
 * When KOS_TEST_BEARER_TOKEN is absent (local dev without secrets) the
 * positive-path test is skipped so CI on a stripped preview doesn't
 * fail spuriously.
 */
test.describe('auth-middleware', () => {
  test('unauthenticated GET /today redirects to /login?return=/today', async ({ page }) => {
    const response = await page.goto('/today', { waitUntil: 'commit' });
    // After the 302 we land on /login; Playwright follows redirects by default.
    expect(response?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/login');
    expect(page.url()).toContain('return=%2Ftoday');
  });

  test('POST /api/auth/login with invalid token returns 401 and no cookie', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { token: 'definitely-not-the-real-token' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid' });
    const setCookie = res.headers()['set-cookie'];
    expect(setCookie).toBeFalsy();
  });

  test('POST /api/auth/login with malformed body returns 400', async ({ request }) => {
    const res = await request.post('/api/auth/login', { data: { notToken: 'abc' } });
    expect(res.status()).toBe(400);
  });

  test('login flow → access granted to /today → logout → redirect back', async ({ page, request }) => {
    const token = process.env.KOS_TEST_BEARER_TOKEN;
    test.skip(!token, 'KOS_TEST_BEARER_TOKEN not set');

    const login = await request.post('/api/auth/login', { data: { token } });
    expect(login.status()).toBe(200);

    await page.goto('/today');
    expect(page.url()).toMatch(/\/today$/);

    await request.post('/api/auth/logout');

    await page.goto('/today', { waitUntil: 'commit' });
    expect(page.url()).toContain('/login');
  });
});
