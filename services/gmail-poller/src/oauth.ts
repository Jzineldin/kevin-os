/**
 * Google OAuth refresh-token → access-token exchange (gmail-poller).
 *
 * Reuses the same `kos/gcal-oauth-<account>` Secrets Manager secrets as
 * calendar-reader. The refresh_token is provisioned by
 * `scripts/bootstrap-google-oauth.mjs` with BOTH `calendar.readonly` AND
 * `gmail.readonly` scopes — Google issues a single refresh_token covering
 * the union of scopes consented at the OAuth screen, so one credential
 * grants both surfaces.
 *
 * Token cache is per-process and refreshes 10 min before Google's stated
 * `expires_in` to avoid reactive refresh inside hot-path Lambda
 * invocations. A 60s safety margin on top covers small clock skew.
 *
 * 401 from Gmail → caller invokes `invalidateToken()` then retries; a
 * second 401 means the refresh_token itself is revoked and we surface
 * the failure rather than burn budget on a loop.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export type GmailAccount = 'kevin-elzarka' | 'kevin-taleforge';

export interface GoogleOAuthCreds {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let smClient: SecretsManagerClient | null = null;
const cache = new Map<GmailAccount, TokenCache>();

function getSecretsClient(): SecretsManagerClient {
  if (!smClient) {
    smClient = new SecretsManagerClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
    });
  }
  return smClient;
}

async function loadCreds(account: GmailAccount): Promise<GoogleOAuthCreds> {
  const secretId = `kos/gcal-oauth-${account}`;
  const r = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!r.SecretString) {
    throw new Error(
      `Secret ${secretId} missing — run scripts/bootstrap-google-oauth.mjs --account ${account}`,
    );
  }
  let parsed: GoogleOAuthCreds;
  try {
    parsed = JSON.parse(r.SecretString) as GoogleOAuthCreds;
  } catch {
    throw new Error(
      `Secret ${secretId} is not valid JSON — re-run scripts/bootstrap-google-oauth.mjs --account ${account}`,
    );
  }
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new Error(
      `Secret ${secretId} missing client_id/client_secret/refresh_token — re-run scripts/bootstrap-google-oauth.mjs --account ${account}`,
    );
  }
  return parsed;
}

async function exchangeRefreshToken(
  account: GmailAccount,
  creds: GoogleOAuthCreds,
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
        `Google OAuth refresh token expired or revoked for ${account}. Re-run scripts/bootstrap-google-oauth.mjs --account ${account}.`,
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

export async function getAccessToken(account: GmailAccount): Promise<string> {
  const now = Date.now();
  const cached = cache.get(account);
  if (cached && cached.expiresAt > now + 60_000) return cached.accessToken;

  const creds = await loadCreds(account);
  const { accessToken, expiresIn } = await exchangeRefreshToken(account, creds);
  cache.set(account, {
    accessToken,
    expiresAt: now + expiresIn * 1000 - 600_000,
  });
  return accessToken;
}

export function invalidateToken(account: GmailAccount): void {
  cache.delete(account);
}

export function __resetForTests(): void {
  cache.clear();
  smClient = null;
}
