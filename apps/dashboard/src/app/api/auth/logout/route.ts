/**
 * POST /api/auth/logout — clears the kos_session cookie.
 *
 * Node runtime (consistent with /api/auth/login). Emits a Set-Cookie
 * with Max-Age=0 and matching attributes so the browser evicts the
 * session immediately. Does not call Next's redirect: the LoginForm /
 * topbar caller handles navigation — this keeps the endpoint POST-only
 * (idempotent from the user's perspective; SameSite=Lax blocks cross-
 * site form CSRF).
 *
 * 03-05-PLAN.md Task 1 must_haves:
 *   - `GET /api/auth/logout` clears the cookie and 302s to /login
 *     — but CSRF-safety prefers POST + same-origin fetch. The
 *     middleware's PUBLIC_PATHS allowlist includes /api/auth/logout
 *     so the logout can execute while holding no session.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  cookieStore.set('kos_session', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return NextResponse.json({ ok: true });
}
