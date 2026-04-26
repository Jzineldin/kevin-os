/**
 * HMAC-SHA256 verifier for the linkedin-webhook (Plan 05-02 / CAP-05).
 *
 * Header: `X-KOS-Signature: t=<unix_seconds>,v1=<hex_sha256(secret, t.body)>`
 * Tolerance: ±300 seconds; constant-time compare via `timingSafeEqual`.
 *
 * Identical algorithm to `services/ios-webhook/src/hmac.ts` — the linkedin
 * Chrome extension reuses the same signing scheme so the two webhooks can
 * share an audit/rotation runbook.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyResult {
  ok: boolean;
  /** 'missing' | 'malformed' | 'drift' | 'signature' on rejection. */
  reason?: 'missing' | 'malformed' | 'drift' | 'signature';
  /** Parsed `t=` value when the header parsed cleanly. */
  timestamp?: number;
}

const HEADER_RE = /^t=(\d+),v1=([0-9a-f]+)$/;
const DRIFT_SECONDS = 300;

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
    return { ok: false, reason: 'signature', timestamp: t };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: 'signature', timestamp: t };
  }
  return { ok: true, timestamp: t };
}
