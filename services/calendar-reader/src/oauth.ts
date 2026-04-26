/**
 * Google OAuth refresh-token → access-token exchange (Plan 08-01 Task 1).
 *
 * D-04: per-account refresh tokens stored in Secrets Manager
 *   kos/gcal-oauth-kevin-elzarka
 *   kos/gcal-oauth-kevin-taleforge
 * with shape `{ client_id, client_secret, refresh_token }`. The refresh_token
 * itself NEVER leaves Secrets Manager; only the short-lived access_token (1h
 * TTL on Google's end) is held in module scope and reused across invocations.
 *
 * Cache TTL is set 10 min before Google's stated `expires_in` so the renewal
 * happens proactively, never reactively. A 60 s safety margin on top of that
 * covers small clock skew between Lambda + Google.
 *
 * The 401-on-events.list path (gcal.ts) bumps `forceRefresh()`; that re-fetches
 * the token even if cached.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export type GcalAccount = 'kevin-elzarka' | 'kevin-taleforge';

export interface GcalOAuthCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let smClient: SecretsManagerClient | null = null;
const cache = new Map<GcalAccount, TokenCache>();

function getSecretsClient(): SecretsManagerClient {
  if (!smClient) {
    smClient = new SecretsManagerClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
    });
  }
  return smClient;
}

async function loadCreds(account: GcalAccount): Promise<GcalOAuthCreds> {
  const secretId = `kos/gcal-oauth-${account}`;
  const r = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!r.SecretString) {
    throw new Error(
      `Secret ${secretId} missing — run scripts/bootstrap-gcal-oauth.mjs --account ${account}`,
    );
  }
  let parsed: GcalOAuthCreds;
  try {
    parsed = JSON.parse(r.SecretString) as GcalOAuthCreds;
  } catch {
    throw new Error(
      `Secret ${secretId} is not valid JSON — run scripts/bootstrap-gcal-oauth.mjs --account ${account}`,
    );
  }
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new Error(
      `Secret ${secretId} missing client_id/client_secret/refresh_token — re-run scripts/bootstrap-gcal-oauth.mjs --account ${account}`,
    );
  }
  return parsed;
}

async function exchangeRefreshToken(
  account: GcalAccount,
  creds: GcalOAuthCreds,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    if (resp.status === 400 && /invalid_grant/.test(errBody)) {
      throw new Error(
        `Google OAuth refresh token expired or revoked for ${account}. Re-run scripts/bootstrap-gcal-oauth.mjs --account ${account}.`,
      );
    }
    throw new Error(`Google OAuth ${resp.status} for ${account}: ${errBody}`);
  }
  const tok = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!tok.access_token) {
    throw new Error(`Google OAuth response missing access_token for ${account}`);
  }
  return {
    accessToken: tok.access_token,
    expiresIn: typeof tok.expires_in === 'number' ? tok.expires_in : 3600,
  };
}

/**
 * Fetch a (possibly cached) access token for the given account.
 *
 * - Re-uses the in-memory cache if the cached token expires more than 60 s
 *   from now (giving outbound calls headroom even on slow VPC NATs).
 * - Cache TTL = `expires_in - 10 min` so renewal happens before Google
 *   actually expires the token (T-08-CAL-05 mitigation).
 */
export async function getAccessToken(account: GcalAccount): Promise<string> {
  const now = Date.now();
  const cached = cache.get(account);
  if (cached && cached.expiresAt > now + 60_000) return cached.accessToken;

  const creds = await loadCreds(account);
  const { accessToken, expiresIn } = await exchangeRefreshToken(account, creds);
  cache.set(account, {
    accessToken,
    // refresh 10 min early so retries inside the same invocation never hit a
    // truly-expired token.
    expiresAt: now + expiresIn * 1000 - 600_000,
  });
  return accessToken;
}

/**
 * Drop the cached token for `account` so the next `getAccessToken()` re-runs
 * the refresh-token exchange. Called from the handler after a 401 from
 * events.list so the retry uses a fresh token.
 */
export function invalidateToken(account: GcalAccount): void {
  cache.delete(account);
}

/** Test-only helper to clear the module-scope cache between cases. */
export function __resetForTests(): void {
  cache.clear();
  smClient = null;
}
