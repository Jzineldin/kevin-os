import { test } from './fixtures';

// Maps to INF-12 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-02 (middleware + cookie session).
test.describe('auth-middleware', () => {
  test.fixme('unauthenticated request to /today redirects to /login?return=…', async () => {
    // GET /today without cookie, expect 302 -> /login?return=%2Ftoday.
  });

  test.fixme('valid Bearer login sets httpOnly kos_session cookie', async () => {
    // POST /api/auth/login with KOS_TEST_BEARER_TOKEN, assert Set-Cookie
    // kos_session; HttpOnly; Secure; SameSite=Lax; Max-Age=90d.
  });

  test.fixme('logout clears the cookie and redirects to /login', async () => {
    // POST /api/auth/logout -> expect Set-Cookie clearing kos_session +
    // 302 to /login.
  });
});
