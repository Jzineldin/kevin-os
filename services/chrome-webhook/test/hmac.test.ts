/**
 * Phase 5 / Plan 05-01 — chrome-webhook HMAC + Bearer verifier tests.
 *
 * Asserts the SAME canonical contract the Chrome extension's
 * `apps/chrome-extension/src/lib/hmac.ts` ships:
 *   canonical = `${secret}.${t}.${body}`
 *   signature = hex_lowercase(hmac_sha256(secret, canonical))
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature, verifyBearer } from '../src/hmac';

const SECRET = 'test-hmac-not-for-production-use';
const NOW = 1714028400;
const BODY = JSON.stringify({ hello: 'world' });

function sign(body: string, t: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${secret}.${t}.${body}`).digest('hex');
}

describe('verifySignature', () => {
  it('valid signature within drift window → ok', () => {
    const sig = sign(BODY, NOW);
    const r = verifySignature(SECRET, `t=${NOW},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(true);
    expect(r.timestamp).toBe(NOW);
  });

  it('missing header → reason=missing', () => {
    const r = verifySignature(SECRET, undefined, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing');
  });

  it('malformed header → reason=malformed', () => {
    const r = verifySignature(SECRET, 'this-is-not-a-signature', BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('drift > 300s in past → reason=drift', () => {
    const past = NOW - 3600;
    const sig = sign(BODY, past);
    const r = verifySignature(SECRET, `t=${past},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('drift');
    expect(r.timestamp).toBe(past);
  });

  it('drift > 300s in future → reason=drift', () => {
    const future = NOW + 3600;
    const sig = sign(BODY, future);
    const r = verifySignature(SECRET, `t=${future},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('drift');
  });

  it('signature mismatch (any body byte mutated) → reason=signature', () => {
    const sig = sign(BODY, NOW);
    const mutated = BODY.replace('world', 'WORLD');
    const r = verifySignature(SECRET, `t=${NOW},v1=${sig}`, mutated, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature');
  });

  it('signature mismatch (different secret used) → reason=signature', () => {
    const sig = sign(BODY, NOW, 'different-secret');
    const r = verifySignature(SECRET, `t=${NOW},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature');
  });
});

describe('verifyBearer', () => {
  it('matches valid Bearer token', () => {
    expect(verifyBearer('abc', 'Bearer abc')).toBe(true);
  });
  it('rejects missing Authorization header', () => {
    expect(verifyBearer('abc', undefined)).toBe(false);
  });
  it('rejects wrong scheme', () => {
    expect(verifyBearer('abc', 'Token abc')).toBe(false);
  });
  it('rejects token mismatch', () => {
    expect(verifyBearer('abc', 'Bearer xyz')).toBe(false);
  });
  it('rejects empty token', () => {
    expect(verifyBearer('abc', 'Bearer ')).toBe(false);
  });
  it('rejects different-length token (no timingSafeEqual length-throw leak)', () => {
    expect(verifyBearer('abc', 'Bearer abcd')).toBe(false);
  });
});
