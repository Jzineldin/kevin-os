/**
 * Browser-side deterministic ULID-shaped ID generator (Plan 05-02).
 *
 * Returns a 26-char Crockford-base32 string matching the regex
 * `/^[0-9A-HJKMNP-TV-Z]{26}$/` enforced by `CaptureReceivedLinkedInDmSchema`.
 *
 * Two flavours:
 *   - `randomUlid()`   — timestamp prefix + 16 random bytes (standard ULID).
 *   - `deterministicUlidFromString(seed)` — sha256(seed) → 26 base32 chars.
 *     Used for LinkedIn DM idempotency: the same `message_urn` always maps
 *     to the same capture_id, so re-polls during the 30-min cycle do not
 *     double-route through downstream triage. (Same trick as ses-inbound's
 *     `deterministicCaptureIdFromMessageId`.)
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomUlid(): string {
  const ts = Date.now();
  let out = '';
  let rem = ts;
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD[rem % 32] + out;
    rem = Math.floor(rem / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 16; i++) out += CROCKFORD[rand[i]! % 32];
  return out.slice(0, 26);
}

/**
 * Map a stable seed (e.g. LinkedIn `message_urn`) onto a 26-char ULID-shape.
 *
 * Modulo bias is acceptable for an idempotency key — we don't need uniform
 * randomness, only a stable function `seed -> id` that satisfies the regex.
 */
export async function deterministicUlidFromString(seed: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(seed));
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out += CROCKFORD[view[i]! % 32];
  }
  return out;
}
