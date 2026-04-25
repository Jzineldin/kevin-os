/**
 * /api/palette-entities — thin passthrough that the client-side Command
 * Palette hits on first open. The palette is a client component and cannot
 * use the SigV4 client directly (credentials are server-only — see
 * 03-RESEARCH §16 + ESLint guard in Plan 03-01). Putting the fetch behind
 * a Node-runtime route handler keeps AWS_ACCESS_KEY_ID_DASHBOARD +
 * AWS_SECRET_ACCESS_KEY_DASHBOARD server-side only.
 *
 * Middleware already enforced the kos_session cookie before this handler
 * runs (P-05 blanket matcher + in-handler early-return only exempts the
 * /login + /api/auth/* paths).
 */
import { NextResponse } from 'next/server';
import { getPaletteEntities } from '@/components/palette/palette-root';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const entities = await getPaletteEntities();
  return NextResponse.json({ entities });
}
