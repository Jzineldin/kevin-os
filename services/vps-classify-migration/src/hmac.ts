/**
 * HMAC-SHA256 verifier for the VPS classify_and_save adapter (MIG-01).
 *
 * Auth pair (D-10-01 / Phase 4 RESEARCH HMAC pattern):
 *   - `Authorization: Bearer <shared_secret>`     — pre-shared bearer token
 *   - `X-KOS-Signature: t=<unix_seconds>,v1=<hex_sha256(secret, t + "." + body)>`
 *
 * Signing string is `${unix_seconds}.${request_body_raw_bytes}` — identical to
 * the ios-webhook (CAP-02) algorithm so VPS-side `classify_and_save.py`
 * implementers can crib the verified Python from `services/vps-freeze-patched/`
 * once Plan 10-01 lands the production secret.
 *
 * Threat mitigations:
 *   T-10-01-01 (Spoofing):  Bearer + HMAC pair gates the Lambda. A leaked
 *     bearer alone fails because v1 covers the body bytes and timestamp.
 *   T-10-01-02 (Replay):    drift > 300s → reject. Adapter does NOT add a
 *     replay cache — the downstream `capture.received` consumer has its own
 *     idempotency belt via `capture_id` ULID. (D-10-01 Test 4: in-window
 *     replay is acceptable; dedup happens upstream.)
 *   T-10-01-03 (Timing):    `crypto.timingSafeEqual` for both Bearer and
 *     v1 comparisons. Length-mismatch short-circuits BEFORE the call (the
 *     timingSafeEqual throw path leaks length information through stack
 *     unwinding timing).
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
export const DRIFT_SECONDS = 300;

/**
 * Constant-time string compare. Returns false on length mismatch WITHOUT
 * calling `timingSafeEqual` (which throws on mismatched lengths and leaks
 * length information through the throw-path stack timing).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the `X-KOS-Signature` header against the raw request body.
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

/**
 * Plan-spec helper: validate HMAC over `body + timestamp` style (the plan's
 * Task 1 action describes `validateHmac(body, timestamp, signature, secret)`).
 *
 * Internally delegates to `verifySignature` after re-shaping the inputs into
 * the canonical `t=...,v1=...` header form. Lets the handler call either
 * surface — the fully-formed header form (preferred — matches the X-KOS-
 * Signature wire shape exactly), or this loose-args form for tests that
 * want to assert each component in isolation.
 *
 * Returns `true` only when the signature matches AND |now - timestamp| <= 300s.
 */
export function validateHmac(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  // Empty inputs short-circuit to false to match the "reject if missing" leg
  // of `verifySignature` without leaking which input was empty.
  if (!body && body !== '') return false;
  if (!timestamp || !signature || !secret) return false;
  const header = `t=${timestamp},v1=${signature}`;
  return verifySignature(secret, header, body, nowSec).ok;
}
