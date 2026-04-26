/**
 * Phase 5 / Plan 05-01 — chrome-webhook HMAC + Bearer verifier.
 *
 * Header format (Stripe-style — matches the canonical the Chrome extension's
 * `apps/chrome-extension/src/lib/hmac.ts` produces):
 *
 *   X-KOS-Signature: t=<unix_seconds>,v1=<hex_sha256_hmac>
 *   canonical    = `${secret}.${t}.${body}`
 *   signature    = hex_lowercase(hmac_sha256(secret, canonical))
 *
 * Tolerance: ±300 seconds (matches the iOS webhook drift window — operator
 * mental model: "if your laptop clock is within 5 minutes you're fine").
 *
 * The Bearer check + HMAC check are BOTH required — Bearer is the cheap
 * gate that bounces unauthenticated bots; HMAC binds the signed timestamp
 * to the body so a stolen Bearer alone cannot forge captures from a
 * different time or with mutated content (T-05-01-01 mitigation pair).
 *
 * Both compares are constant-time (`timingSafeEqual`); the Bearer compare
 * also short-circuits on length mismatch BEFORE the call (timingSafeEqual
 * throws on different-length buffers + the throw stack-frame leaks length
 * timing — same defence-in-depth as services/ios-webhook/src/hmac.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyResult {
  ok: boolean;
  /** 'missing' / 'malformed' / 'drift' / 'signature' on rejection. */
  reason?: 'missing' | 'malformed' | 'drift' | 'signature';
  /** Parsed `t=` value when the header parsed (regardless of outcome). */
  timestamp?: number;
}

const HEADER_RE = /^t=(\d+),v1=([0-9a-f]+)$/;
const DRIFT_SECONDS = 300;

/**
 * Verify a chrome-webhook X-KOS-Signature header against the raw body.
 *
 * @param secret  Shared HMAC secret (from Secrets Manager).
 * @param header  Raw header value, or undefined if absent.
 * @param body    Raw request body bytes as a UTF-8 string. MUST be the
 *                exact bytes the client signed.
 * @param nowSec  Current UNIX seconds (injected so tests can pin clock).
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  nowSec: number,
): VerifyResult {
  if (!header || header.length === 0) {
    return { ok: false, reason: 'missing' };
  }
  const m = HEADER_RE.exec(header);
  if (!m) {
    return { ok: false, reason: 'malformed' };
  }
  const t = Number(m[1]);
  const v1Hex = m[2]!;
  if (!Number.isFinite(t) || !Number.isInteger(t)) {
    return { ok: false, reason: 'malformed' };
  }

  if (Math.abs(nowSec - t) > DRIFT_SECONDS) {
    return { ok: false, reason: 'drift', timestamp: t };
  }

  // Stripe-style canonical with the secret prefix — must match
  // apps/chrome-extension/src/lib/hmac.ts.
  const expectedHex = createHmac('sha256', secret)
    .update(`${secret}.${t}.${body}`)
    .digest('hex');

  if (expectedHex.length !== v1Hex.length) {
    return { ok: false, reason: 'signature', timestamp: t };
  }

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(v1Hex, 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return { ok: false, reason: 'signature', timestamp: t };
  }
  const equal = timingSafeEqual(expectedBuf, actualBuf);
  if (!equal) {
    return { ok: false, reason: 'signature', timestamp: t };
  }
  return { ok: true, timestamp: t };
}

/**
 * Constant-time Bearer compare. Returns false on any mismatch (including
 * a missing header or wrong scheme); returns true only when the header is
 * `Bearer <expected>` and the token bytes match exactly.
 */
export function verifyBearer(expected: string, header: string | undefined): boolean {
  if (!header) return false;
  const PREFIX = 'Bearer ';
  if (!header.startsWith(PREFIX)) return false;
  const presented = header.slice(PREFIX.length);
  // Length-mismatch short-circuit BEFORE timingSafeEqual (which throws on
  // mismatched lengths and the throw leaks length info).
  if (presented.length !== expected.length) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
