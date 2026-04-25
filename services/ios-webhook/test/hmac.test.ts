/**
 * HMAC verifier tests (CAP-02 / D-01).
 *
 * The 7 tests below cover every reject path (missing, malformed, drift past,
 * drift future, signature mismatch) plus the happy path AND assert that
 * `crypto.timingSafeEqual` is the compare primitive (T-04-IOS-06).
 *
 * Signatures are generated via `signIosShortcutBody` from `@kos/test-fixtures`
 * — the SAME function the production Lambda's runtime mate `verifySignature`
 * is verified against. Sharing the signer eliminates the "tests pass but
 * Lambda rejects valid clients" hazard.
 */
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { signIosShortcutBody } from '@kos/test-fixtures';
import { verifySignature } from '../src/hmac.js';

const SECRET = 'test-secret-not-for-production-use';
const NOW = 1714028400; // 2026-04-25T07:00:00Z
const BODY = JSON.stringify({
  timestamp: NOW,
  audio_base64: Buffer.from('fake-m4a-payload').toString('base64'),
  mime_type: 'audio/m4a',
});

describe('verifySignature', () => {
  it('returns ok=true for a valid header within the drift window', () => {
    const sig = signIosShortcutBody(SECRET, BODY, NOW);
    const header = `t=${NOW},v1=${sig}`;
    const r = verifySignature(SECRET, header, BODY, NOW);
    expect(r.ok).toBe(true);
    expect(r.timestamp).toBe(NOW);
    expect(r.reason).toBeUndefined();
  });

  it('returns ok=false reason=missing when the header is absent', () => {
    const r = verifySignature(SECRET, undefined, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing');
  });

  it('returns ok=false reason=missing when the header is the empty string', () => {
    const r = verifySignature(SECRET, '', BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing');
  });

  it('returns ok=false reason=malformed when t= or v1= is absent', () => {
    expect(verifySignature(SECRET, 'v1=abcdef', BODY, NOW).reason).toBe(
      'malformed',
    );
    expect(verifySignature(SECRET, `t=${NOW}`, BODY, NOW).reason).toBe(
      'malformed',
    );
    expect(verifySignature(SECRET, 'garbage', BODY, NOW).reason).toBe(
      'malformed',
    );
    // Right shape but wrong order also rejected (regex is anchored).
    expect(
      verifySignature(SECRET, `v1=abcdef,t=${NOW}`, BODY, NOW).reason,
    ).toBe('malformed');
  });

  it('returns ok=false reason=signature when the v1 hex does not match', () => {
    // Same-length hex but a different content. Anchored regex requires
    // lowercase [0-9a-f]+ — 64 zeros parses cleanly then fails the compare.
    const header = `t=${NOW},v1=${'0'.repeat(64)}`;
    const r = verifySignature(SECRET, header, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature');
    expect(r.timestamp).toBe(NOW);
  });

  it('returns ok=false reason=drift when the timestamp is >300s in the future', () => {
    const future = NOW + 400;
    const sig = signIosShortcutBody(SECRET, BODY, future);
    const header = `t=${future},v1=${sig}`;
    const r = verifySignature(SECRET, header, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('drift');
    expect(r.timestamp).toBe(future);
  });

  it('returns ok=false reason=drift when the timestamp is >300s in the past', () => {
    const past = NOW - 3600;
    const sig = signIosShortcutBody(SECRET, BODY, past);
    const header = `t=${past},v1=${sig}`;
    const r = verifySignature(SECRET, header, BODY, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('drift');
    expect(r.timestamp).toBe(past);
  });

  it('uses crypto.timingSafeEqual for the compare primitive', async () => {
    // The `node:crypto` namespace export is frozen, so vi.spyOn on the
    // imported namespace fails with "Cannot redefine property".
    // vi.mock with a partial spread lets us replace just `timingSafeEqual`
    // with a spy while preserving the rest of the module surface.
    vi.resetModules();
    const tseSpy = vi.fn(crypto.timingSafeEqual);
    vi.doMock('node:crypto', async () => {
      const actual = await vi.importActual<typeof crypto>('node:crypto');
      return { ...actual, timingSafeEqual: tseSpy };
    });
    const { verifySignature: vsFresh } = await import('../src/hmac.js');
    const sig = signIosShortcutBody(SECRET, BODY, NOW);
    const header = `t=${NOW},v1=${sig}`;
    const r = vsFresh(SECRET, header, BODY, NOW);
    expect(r.ok).toBe(true);
    expect(tseSpy).toHaveBeenCalledTimes(1);
    vi.doUnmock('node:crypto');
    vi.resetModules();
  });
});
