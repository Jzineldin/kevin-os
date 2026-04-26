/**
 * Plan 10-01 Wave-1 HMAC verifier tests (Task 1, behaviours 1-4).
 *
 * Covers:
 *   1. valid signature passes
 *   2. invalid signature → reason='signature'
 *   3. timestamp drift > 300s → reason='drift'
 *   4. replay within 300s passes (dedup happens upstream — adapter has no
 *      replay cache, that's the consumer's `capture_id` ULID idempotency belt)
 *
 * Plus belt-and-braces:
 *   - missing header → reason='missing'
 *   - malformed header → reason='malformed'
 *   - constantTimeEquals length-mismatch
 *   - validateHmac (loose-args helper) parity with verifySignature
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  verifySignature,
  validateHmac,
  constantTimeEquals,
  DRIFT_SECONDS,
} from '../src/hmac.js';

const SECRET = 'test-classify-shared-secret';
const NOW = 1714028400; // 2026-04-25T07:00:00Z (deterministic — matches ios-webhook fixture clock)
const BODY = JSON.stringify({
  title: 'Möte med Damien — sprint planning Q2',
  is_duplicate: false,
});

function sign(secret: string, t: number, body: string): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

describe('vps-classify-migration / hmac', () => {
  it('Test 1: valid signature passes (verifySignature ok=true, timestamp echoed)', () => {
    const sig = sign(SECRET, NOW, BODY);
    const r = verifySignature(SECRET, `t=${NOW},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(true);
    expect(r.timestamp).toBe(NOW);
    expect(r.reason).toBeUndefined();
  });

  it('Test 2: invalid signature → ok=false reason=signature', () => {
    const r = verifySignature(
      SECRET,
      `t=${NOW},v1=${'0'.repeat(64)}`,
      BODY,
      NOW,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature');
    expect(r.timestamp).toBe(NOW);
  });

  it('Test 3: timestamp drift > 300s → ok=false reason=drift', () => {
    const past = NOW - (DRIFT_SECONDS + 1);
    const sig = sign(SECRET, past, BODY);
    const r = verifySignature(SECRET, `t=${past},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('drift');
    expect(r.timestamp).toBe(past);
  });

  it('Test 3a: drift exactly at 300s boundary passes (≤ 300s tolerated)', () => {
    const edge = NOW - DRIFT_SECONDS; // exactly at boundary
    const sig = sign(SECRET, edge, BODY);
    const r = verifySignature(SECRET, `t=${edge},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(true);
  });

  it('Test 4: replay within 300s passes (no cache at adapter — dedup is upstream)', () => {
    const sig = sign(SECRET, NOW, BODY);
    const header = `t=${NOW},v1=${sig}`;
    const r1 = verifySignature(SECRET, header, BODY, NOW);
    const r2 = verifySignature(SECRET, header, BODY, NOW);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('missing X-KOS-Signature → ok=false reason=missing', () => {
    expect(verifySignature(SECRET, undefined, BODY, NOW).reason).toBe('missing');
    expect(verifySignature(SECRET, '', BODY, NOW).reason).toBe('missing');
  });

  it('malformed X-KOS-Signature → ok=false reason=malformed', () => {
    expect(verifySignature(SECRET, 'totally-bogus', BODY, NOW).reason).toBe(
      'malformed',
    );
    expect(verifySignature(SECRET, `t=abc,v1=${'a'.repeat(64)}`, BODY, NOW).reason).toBe(
      'malformed',
    );
  });

  it('different secret → ok=false reason=signature (defence-in-depth)', () => {
    const sig = sign('other-secret', NOW, BODY);
    const r = verifySignature(SECRET, `t=${NOW},v1=${sig}`, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature');
  });

  it('body mutation breaks the signature (T-10-01-01 spoofing mitigation)', () => {
    const sig = sign(SECRET, NOW, BODY);
    const tampered = BODY.replace('Damien', 'Mallory');
    const r = verifySignature(SECRET, `t=${NOW},v1=${sig}`, tampered, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature');
  });

  it('constantTimeEquals — equal strings return true', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('constantTimeEquals — length-mismatch short-circuits to false (no throw)', () => {
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
    expect(constantTimeEquals('a', '')).toBe(false);
  });

  it('constantTimeEquals — same-length but different value returns false', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('validateHmac (loose-args) accepts a valid pair', () => {
    const sig = sign(SECRET, NOW, BODY);
    expect(validateHmac(BODY, String(NOW), sig, SECRET, NOW)).toBe(true);
  });

  it('validateHmac (loose-args) rejects drift > 300s', () => {
    const past = NOW - (DRIFT_SECONDS + 1);
    const sig = sign(SECRET, past, BODY);
    expect(validateHmac(BODY, String(past), sig, SECRET, NOW)).toBe(false);
  });

  it('validateHmac (loose-args) rejects empty inputs', () => {
    expect(validateHmac(BODY, '', 'sig', SECRET, NOW)).toBe(false);
    expect(validateHmac(BODY, String(NOW), '', SECRET, NOW)).toBe(false);
    expect(validateHmac(BODY, String(NOW), 'sig', '', NOW)).toBe(false);
  });
});
