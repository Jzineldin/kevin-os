/**
 * Root auth gate for the dashboard.
 *
 * Runs on the Vercel Edge runtime (Next.js default for middleware). Per
 * 03-RESEARCH.md P-01, Edge cannot import `@kos/db`, `pg`, or any
 * `@aws-sdk/*` package — this file is deliberately dependency-free aside
 * from the tiny in-repo `constantTimeEqual` util.
 *
 * Behaviour (03-05-PLAN.md Task 1 must_haves):
 *   - Public paths pass through: /login, /api/auth/*, Next internals,
 *     favicon, sw.js, manifest, /icons/*.
 *   - Everything else requires a valid `kos_session` cookie matching
 *     KOS_DASHBOARD_BEARER_TOKEN (constant-time compare).
 *   - Missing / wrong cookie → 302 /login?return=<original-path>.
 *
 * The matcher in `config.matcher` already excludes Next static assets,
 * but we keep an in-handler early-return as defence-in-depth so the
 * invariant is visible at the call site.
 */
import { NextRequest, NextResponse } from 'next/server';
import { constantTimeEqual } from '@/lib/constant-time';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout'];
const COOKIE = 'kos_session';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/')) ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    pathname === '/sw.js' ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/icons/')
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE)?.value;
  const expected = process.env.KOS_DASHBOARD_BEARER_TOKEN;

  if (!token || !expected || !constantTimeEqual(token, expected)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('return', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Matcher excludes Next static output + favicon + PWA assets so the
  // middleware never runs on those paths at all (cheaper than an
  // in-handler bypass, and the bypass is kept as defence-in-depth above).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest\\.webmanifest|icons/).*)'],
};
