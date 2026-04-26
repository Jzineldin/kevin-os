/**
 * Browser-side HMAC-SHA256 signer for the KOS extension webhooks.
 *
 * Plan 05-02 (LinkedIn DM scraper). Mirrors the server-side verifier in
 * `services/linkedin-webhook/src/hmac.ts`:
 *
 *   X-KOS-Signature: t=<unix_seconds>,v1=<hex_sha256(secret, t + "." + body)>
 *
 * Owned by Plan 05-02. Plan 05-01 (Chrome highlight) will reach for the same
 * helper from `apps/chrome-extension/src/lib/hmac.ts` once it merges; the
 * `_lib/` directory is the merge-conflict-free location until those plans
 * unify under a single `lib/` path.
 *
 * SubtleCrypto is available in MV3 service workers AND content scripts (it is
 * part of the Window/Worker globals exposed by the browser). No Node.js
 * `crypto` import — that wouldn't bundle to the extension.
 */

export interface SignedEnvelope {
  /** UNIX seconds at signing time. */
  timestamp: number;
  /** Lowercase hex sha256 over `${timestamp}.${body}`. */
  v1: string;
}

const enc = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Sign a request body with the shared HMAC secret.
 *
 * @param body          Raw request body string (must match the bytes the
 *                      server reads from `event.body`).
 * @param secret        Shared HMAC secret (loaded from chrome.storage.local).
 * @param nowSecOverride Pinned UNIX-seconds clock — tests inject this so the
 *                      computed signature is deterministic. Production callers
 *                      omit it; defaults to `Math.floor(Date.now()/1000)`.
 */
export async function signRequest(
  body: string,
  secret: string,
  nowSecOverride?: number,
): Promise<SignedEnvelope> {
  const t = nowSecOverride ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`));
  return { timestamp: t, v1: bytesToHex(sig) };
}

/** Render `t=<ts>,v1=<hex>` for the X-KOS-Signature header. */
export function formatSignatureHeader(env: SignedEnvelope): string {
  return `t=${env.timestamp},v1=${env.v1}`;
}
