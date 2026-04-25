/**
 * POST /api/auth/login + /api/auth/logout route-handler tests.
 *
 * Behaviour targets (03-05-PLAN.md Task 1 must_haves):
 *   - correct token → 200 { ok: true } + Set-Cookie: kos_session=<token>;
 *     HttpOnly; Secure; SameSite=Lax; Max-Age=7776000 (90 d)
 *   - incorrect token → 401 { error: 'invalid' }, no cookie
 *   - malformed body → 400 { error: 'invalid' }, no cookie
 *   - logout → 200 + Set-Cookie clearing kos_session (Max-Age=0)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Next's `cookies()` helper is not available outside a request context in
// unit tests, so we stub it to a minimal Map-backed implementation that
// captures what the route would emit as `Set-Cookie`.
type CookieSet = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

const cookieSets: CookieSet[] = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieSets.push({ name, value, options });
    },
  }),
}));

describe('POST /api/auth/login', () => {
  const SECRET = 'test-bearer-token-super-secret';

  beforeEach(() => {
    cookieSets.length = 0;
    vi.stubEnv('KOS_DASHBOARD_BEARER_TOKEN', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 200 + sets hardened cookie on correct token', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: SECRET }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(cookieSets).toHaveLength(1);
    const set = cookieSets[0]!;
    expect(set.name).toBe('kos_session');
    expect(set.value).toBe(SECRET);
    expect(set.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 90,
    });
  });

  it('returns 401 + no cookie on wrong token', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid' });
    expect(cookieSets).toHaveLength(0);
  });

  it('returns 400 + no cookie on malformed body', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notToken: 'abc' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid' });
    expect(cookieSets).toHaveLength(0);
  });

  it('returns 400 on empty body', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(cookieSets).toHaveLength(0);
  });

  it('returns 401 when KOS_DASHBOARD_BEARER_TOKEN unset, even with truthy submitted token', async () => {
    vi.stubEnv('KOS_DASHBOARD_BEARER_TOKEN', '');
    // Re-import to pick up fresh env — but our route reads env at call time,
    // so the existing module works.
    const { POST } = await import('@/app/api/auth/login/route');
    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'anything' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(cookieSets).toHaveLength(0);
  });
});

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    cookieSets.length = 0;
  });

  it('clears the kos_session cookie', async () => {
    const { POST } = await import('@/app/api/auth/logout/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(cookieSets).toHaveLength(1);
    const set = cookieSets[0]!;
    expect(set.name).toBe('kos_session');
    expect(set.value).toBe('');
    expect(set.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  });
});
