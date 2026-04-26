/**
 * Phase 5 / Plan 05-01 — typed wrapper around `chrome.storage.local`.
 *
 * Single source of truth for the three values the extension needs:
 *   - `webhookUrl`  — base URL of the chrome-webhook Lambda Function URL.
 *                     Call sites append `/highlight` (Plan 05-01) or
 *                     `/linkedin` / `/linkedin/alert` (Plan 05-03).
 *   - `bearer`      — static Bearer token for the Authorization header.
 *   - `hmacSecret`  — shared HMAC secret used by `signRequest`.
 *
 * All three are seeded by the operator via the Options page (Plan 05-01
 * Task 2). Chrome encrypts `chrome.storage.local` at rest on disk; the
 * options page is the only context that can write to it (`<script>` on
 * arbitrary web pages cannot reach extension storage — content-script
 * isolation; T-05-01-02 mitigation).
 */

export interface KosConfig {
  /** Base webhook URL — `/highlight`, `/linkedin`, etc. appended at call sites. */
  webhookUrl: string;
  /** Static Bearer token sent in the Authorization header. */
  bearer: string;
  /** Shared HMAC secret used to sign every POST body. */
  hmacSecret: string;
}

const KEYS: readonly (keyof KosConfig)[] = ['webhookUrl', 'bearer', 'hmacSecret'];

/**
 * Read all three config fields from chrome.storage.local. Missing keys
 * return as `undefined`. Callers should treat any of the three being
 * absent as "extension not yet configured" and route the user to the
 * Options page rather than firing a request that would land at a
 * placeholder URL.
 */
export async function loadConfig(): Promise<Partial<KosConfig>> {
  const out = (await chrome.storage.local.get([...KEYS])) as Partial<KosConfig>;
  return out;
}

/** Persist all three config fields atomically. */
export async function saveConfig(cfg: KosConfig): Promise<void> {
  await chrome.storage.local.set({
    webhookUrl: cfg.webhookUrl,
    bearer: cfg.bearer,
    hmacSecret: cfg.hmacSecret,
  });
}

/** True iff all three required fields are present and non-empty. */
export async function isConfigured(): Promise<boolean> {
  const c = await loadConfig();
  return Boolean(c.webhookUrl && c.bearer && c.hmacSecret);
}
