/**
 * Phase 5 / Plan 05-01 — Web Crypto HMAC-SHA256 for the Chrome MV3 extension.
 *
 * MV3 service workers + content scripts expose the Web Crypto API as
 * `globalThis.crypto.subtle`. Node ≥ 20 (the vitest runtime in this repo) also
 * exposes it. We deliberately avoid `node:crypto` so the SAME implementation
 * runs in tests AND in the bundled extension (no Node polyfills shipped to
 * the browser).
 *
 * Header shape (Stripe-style canonical) — matches Phase 5 Plan 05-02 server:
 *   X-KOS-Signature: t=<unix_seconds>,v1=<hex_sha256_hmac>
 *
 *   canonical = `${secret}.${timestamp}.${body}`
 *   signature = hex_lowercase(hmac_sha256(secret, canonical))
 *
 * Note this differs from the Phase 4 iOS canonical (`${ts}.${body}`) — the
 * chrome-webhook server is the matching pair (Plan 05-02), and the secret
 * appearing inside the canonical adds defence-in-depth: an attacker who
 * captures one signed body still can't forge another timestamp without
 * also knowing the secret.
 */

/**
 * Compute hex-lowercase HMAC-SHA256(secret, message). Returns a 64-char hex
 * string. Uses Web Crypto so the implementation runs unchanged in the
 * extension service worker, content script, options page, AND vitest.
 */
export async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const bytes = new Uint8Array(sig);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export interface SignedRequest {
  /** UNIX seconds at signing time (client clock). */
  timestamp: number;
  /** 64-char lowercase hex SHA-256 HMAC. */
  signature: string;
}

/**
 * Sign a JSON request body with the shared HMAC secret. Returns the
 * `{ timestamp, signature }` pair the caller needs to assemble the
 * X-KOS-Signature header.
 *
 * The timestamp is captured at sign time, NOT at fetch time — even a slow
 * fetch retains the same timestamp, so the server's drift check is always
 * comparing to "when the user pressed Send to KOS", not "when the request
 * happened to land".
 */
export async function signRequest(body: string, secret: string): Promise<SignedRequest> {
  const t = Math.floor(Date.now() / 1000);
  const canonical = `${secret}.${t}.${body}`;
  const signature = await hmacSha256Hex(secret, canonical);
  return { timestamp: t, signature };
}

/** Format a SignedRequest into the canonical X-KOS-Signature header value. */
export function formatSignatureHeader(s: SignedRequest): string {
  return `t=${s.timestamp},v1=${s.signature}`;
}
