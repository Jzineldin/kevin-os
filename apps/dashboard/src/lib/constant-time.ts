/**
 * Edge-runtime-safe constant-time string comparison.
 *
 * Next.js middleware runs on the Edge runtime (03-RESEARCH.md P-01),
 * where Node's `crypto.timingSafeEqual` is not available. This pure-JS
 * fallback iterates all characters of same-length inputs before
 * returning, defeating naive timing side-channels on the Bearer token
 * cookie compare.
 *
 * Invariants:
 *   - Returns false immediately for mismatched lengths (length is
 *     already leaked by the HTTP layer — protecting it buys nothing).
 *   - For same-length strings, always executes the full loop; does NOT
 *     early-return on first differing character.
 *   - Defensive: returns false for non-string inputs rather than
 *     throwing, so a missing cookie / env var cannot crash middleware.
 *
 * Used by:
 *   - apps/dashboard/src/middleware.ts (Edge)
 *   - apps/dashboard/src/app/api/auth/login/route.ts (Node)
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
