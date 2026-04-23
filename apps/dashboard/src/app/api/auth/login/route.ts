/**
 * POST /api/auth/login — Bearer-token → httpOnly cookie exchange.
 *
 * Runs on the Node runtime (cookies() in App Router supports both
 * runtimes, but we pin Node here so zod + the contracts package are
 * unambiguously available; middleware stays Edge per P-01).
 *
 * Request:  { token: string }          (LoginRequestSchema)
 * Response:
 *   200 { ok: true }                   (LoginResponseSchema) + Set-Cookie
 *   400 { error: 'invalid' }           malformed body
 *   401 { error: 'invalid' }           token mismatch
 *
 * Cookie (03-CONTEXT.md D-19, 03-05-PLAN.md Task 1 acceptance):
 *   Name:      kos_session
 *   Value:     submitted token (verified equal to the env secret)
 *   HttpOnly:  true
 *   Secure:    true
 *   SameSite:  lax  (allows top-level-nav from links — the login redirect
 *                    lands on `/today` via Next router, still same-origin)
 *   Path:      /
 *   Max-Age:   90 days (60 * 60 * 24 * 90 = 7_776_000)
 *
 * Constant-time compare on the token to prevent timing leaks (T-3-05-03).
 * The submitted token is the value we store in the cookie verbatim;
 * middleware uses the same constantTimeEqual on subsequent requests.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { LoginRequestSchema, LoginResponseSchema } from '@kos/contracts/dashboard';
import { constantTimeEqual } from '@/lib/constant-time';

export const runtime = 'nodejs';

const INVALID = NextResponse.json({ error: 'invalid' as const }, { status: 401 });
const MALFORMED = NextResponse.json({ error: 'invalid' as const }, { status: 400 });

export async function POST(req: Request): Promise<Response> {
  // Body parse — accept empty / non-JSON without throwing; zod will reject it.
  const raw = await req.text();
  let parsedBody: unknown;
  try {
    parsedBody = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid' as const }, { status: 400 });
  }

  const parsed = LoginRequestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid' as const }, { status: 400 });
  }

  const expected = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!expected || !constantTimeEqual(parsed.data.token, expected)) {
    return NextResponse.json({ error: 'invalid' as const }, { status: 401 });
  }

  const cookieStore = await cookies();
  cookieStore.set('kos_session', parsed.data.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 90, // 90 days — D-19
  });

  return NextResponse.json(LoginResponseSchema.parse({ ok: true }));
}

// Keep MALFORMED + INVALID referenced to prevent unused-export lints in
// stricter configs. Re-export has no runtime cost and clarifies intent.
export const _responses = { INVALID, MALFORMED } as const;
