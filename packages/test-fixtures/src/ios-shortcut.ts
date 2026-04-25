/**
 * Phase 4 Plan 04-00 Task 5 — iOS Shortcut HMAC payload fixtures.
 *
 * Variants cover the security invariants of the ios-webhook Lambda:
 *   - valid          → 200 (signature OK, fresh timestamp, single use)
 *   - badSignature   → 401 (signature mismatch)
 *   - drift          → 401 (timestamp >300s old — replay window expired)
 *   - replay         → 409 (signature already seen in DynamoDB cache)
 *   - missingHeader  → 400 (X-KOS-Signature absent)
 *   - emptyBody      → 400 (zero-byte body)
 *
 * `signIosShortcutBody` is the deterministic HMAC generator used by
 * tests AND — once Plan 04-01 ships — by the production ios-webhook
 * Lambda. Sharing the implementation eliminates the "tests pass but
 * Lambda rejects valid clients because the algorithms drifted" hazard.
 *
 * Algorithm (matches D-15):
 *   signaturePayload = `${timestamp}.${body}`
 *   signature        = hex(hmac_sha256(secret, signaturePayload))
 *   header           = `X-KOS-Signature: t=${timestamp},v1=${signature}`
 */
import { createHmac } from 'node:crypto';

export interface IosShortcutFixtureVariant {
  body: string;
  /** UNIX seconds (string) — what the client claims for the signature. */
  timestamp: string;
  /** Pre-computed signature (hex) for the (secret, body, timestamp) tuple. */
  signature: string;
  /** The shared secret used to produce `signature` — kept here so tests can
   * re-sign or assert non-equality. */
  secret: string;
  /** Expected HTTP status for this variant. */
  expectedStatus: number;
  /** Whether the X-KOS-Signature header should be sent at all. */
  sendSignatureHeader: boolean;
}

/** Deterministic HMAC-SHA256 over `${timestamp}.${body}` (hex output). */
export function signIosShortcutBody(
  secret: string,
  body: string,
  timestamp: number | string,
): string {
  const ts = typeof timestamp === 'number' ? String(timestamp) : timestamp;
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

const SECRET = 'test-secret-not-for-production-use';
const NOW = 1714028400; // 2026-04-25T07:00:00Z
const REPLAY_TS = NOW;
const VALID_BODY = JSON.stringify({
  timestamp: NOW,
  audio_base64: Buffer.from('fake-m4a-payload').toString('base64'),
  mime_type: 'audio/m4a',
});

const validSignature = signIosShortcutBody(SECRET, VALID_BODY, NOW);
const replaySignature = signIosShortcutBody(SECRET, VALID_BODY, REPLAY_TS);

/**
 * Six-variant fixture object. Each variant is a fully-formed (body,
 * signature, secret, expected outcome) tuple — ios-webhook Lambda tests
 * iterate over the keys.
 */
export const IOS_SHORTCUT_PAYLOAD_FIXTURES = {
  valid: {
    body: VALID_BODY,
    timestamp: String(NOW),
    signature: validSignature,
    secret: SECRET,
    expectedStatus: 200,
    sendSignatureHeader: true,
  },
  badSignature: {
    body: VALID_BODY,
    timestamp: String(NOW),
    // 64 zero hex chars — a same-shape but never-correct signature.
    signature: '0'.repeat(64),
    secret: SECRET,
    expectedStatus: 401,
    sendSignatureHeader: true,
  },
  drift: {
    // Signature is correctly computed for a 1h-old timestamp — the Lambda
    // rejects on the timestamp-vs-now drift check, NOT on signature mismatch.
    body: VALID_BODY,
    timestamp: String(NOW - 3600),
    signature: signIosShortcutBody(SECRET, VALID_BODY, NOW - 3600),
    secret: SECRET,
    expectedStatus: 401,
    sendSignatureHeader: true,
  },
  replay: {
    // Identical to `valid` — the second invocation with the same signature
    // hits the DynamoDB replay cache and returns 409.
    body: VALID_BODY,
    timestamp: String(REPLAY_TS),
    signature: replaySignature,
    secret: SECRET,
    expectedStatus: 409,
    sendSignatureHeader: true,
  },
  missingHeader: {
    body: VALID_BODY,
    timestamp: String(NOW),
    signature: validSignature,
    secret: SECRET,
    expectedStatus: 400,
    sendSignatureHeader: false,
  },
  emptyBody: {
    body: '',
    timestamp: String(NOW),
    signature: signIosShortcutBody(SECRET, '', NOW),
    secret: SECRET,
    expectedStatus: 400,
    sendSignatureHeader: true,
  },
} satisfies Record<string, IosShortcutFixtureVariant>;

export type IosShortcutFixtureKey = keyof typeof IOS_SHORTCUT_PAYLOAD_FIXTURES;
