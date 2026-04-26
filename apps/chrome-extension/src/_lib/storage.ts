/**
 * chrome.storage.local config helpers (Plan 05-02 LinkedIn DM scraper).
 *
 * Stores three values that the operator pastes into the options page:
 *   - webhookUrl  : Lambda Function URL base (no trailing slash)
 *   - bearer      : Bearer token (rotated via Secrets Manager)
 *   - hmacSecret  : Shared HMAC secret matching the linkedin-webhook secret
 *
 * Sibling Plan 05-01 (Chrome highlight) reuses the same three keys so the
 * options UI lands once. Until 05-01 merges, this helper lives under `_lib/`
 * to avoid path collisions; the post-merge refactor moves it to `lib/`.
 */

export interface ExtensionConfig {
  webhookUrl?: string;
  bearer?: string;
  hmacSecret?: string;
}

const KEYS = ['webhookUrl', 'bearer', 'hmacSecret'] as const;

export async function loadConfig(): Promise<ExtensionConfig> {
  const raw = await chrome.storage.local.get(KEYS as unknown as string[]);
  return {
    webhookUrl: typeof raw.webhookUrl === 'string' ? raw.webhookUrl : undefined,
    bearer: typeof raw.bearer === 'string' ? raw.bearer : undefined,
    hmacSecret: typeof raw.hmacSecret === 'string' ? raw.hmacSecret : undefined,
  };
}

export async function isConfigured(): Promise<boolean> {
  const c = await loadConfig();
  return Boolean(c.webhookUrl && c.bearer && c.hmacSecret);
}
