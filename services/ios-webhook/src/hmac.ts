/**
 * HMAC-SHA256 webhook signature verifier (CAP-02 / D-01).
 * Header format: X-KOS-Signature: t=<unix_seconds>,v1=<hex_sha256(secret, t + "." + body)>
 * Tolerance: ±300 seconds; constant-time compare mandatory (timingSafeEqual).
 *
 * The signing string is `${unix_seconds}.${request_body_raw_bytes}` — exactly
 * the algorithm in `@kos/test-fixtures/src/ios-shortcut.ts` (which is shared
 * by both production and tests so the two paths cannot drift).
 *
 * Threat mitigations:
 *   - T-04-IOS-01 (replay): timestamp drift check rejects requests outside
 *     the ±300s window; the DynamoDB replay cache (replay.ts) catches the
 *     remaining short-window double-submit.
 *   - T-04-IOS-02 (tampering): HMAC covers timestamp + full body bytes; any
 *     mutation breaks the signature.
 *   - T-04-IOS-06 (timing attack): `crypto.timingSafeEqual` is the compare
 *     primitive — branch-free byte comparison even on length mismatch
 *     (we short-circuit BEFORE the call when buffers differ in length, since
 *     `timingSafeEqual` itself throws on mismatched lengths and the throw
 *     leaks length information through the unique stack-frame timing).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyResult {
  ok: boolean;
  /** 'missing' | 'malformed' | 'drift' | 'signature' on rejection. */
  reason?: 'missing' | 'malformed' | 'drift' | 'signature';
  /** Parsed `t=` value when the header parsed cleanly (regardless of outcome). */
  timestamp?: number;
}

const HEADER_RE = /^t=(\d+),v1=([0-9a-f]+)$/;
const DRIFT_SECONDS = 300;

/**
 * Verify an `X-KOS-Signature` header against the raw request body.
 *
 * @param secret   The shared HMAC secret (loaded from Secrets Manager).
 * @param header   The raw `X-KOS-Signature` header value, or undefined if absent.
 * @param bodyRaw  The raw request body bytes as a UTF-8 string. MUST be the
 *                 exact bytes the client signed — no JSON.parse round-tripping.
 * @param nowSec   Current time as UNIX seconds. Injected (rather than read from
 *                 `Date.now()` directly) so tests can pin the clock.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  bodyRaw: string,
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

  const expectedHex = createHmac('sha256', secret)
    .update(`${t}.${bodyRaw}`)
    .digest('hex');

  // Length-mismatch short-circuit: timingSafeEqual throws on different-length
  // buffers and the throw path leaks length via stack-frame timing. We bail
  // out before the call. (Same-length comparison is always constant-time.)
  if (expectedHex.length !== v1Hex.length) {
    return { ok: false, reason: 'signature', timestamp: t };
  }

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(v1Hex, 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    // Defensive: a non-hex character in v1 produces a shorter Buffer than the
    // hex string length suggests. Treat as signature mismatch.
    return { ok: false, reason: 'signature', timestamp: t };
  }

  const equal = timingSafeEqual(expectedBuf, actualBuf);
  if (!equal) {
    return { ok: false, reason: 'signature', timestamp: t };
  }
  return { ok: true, timestamp: t };
}
