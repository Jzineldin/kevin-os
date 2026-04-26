/**
 * chrome-webhook secret loaders (Phase 5 / Plan 05-01).
 *
 * Two secrets are required:
 *   - `kos/chrome-extension-bearer`     — static Bearer token shared with
 *     the extension Options page.
 *   - `kos/chrome-extension-hmac-secret` — shared HMAC secret used for
 *     X-KOS-Signature verification.
 *
 * Both fail closed when unset / empty / the literal 'PLACEHOLDER' (DataStack
 * seeds with that), mirroring services/ios-webhook/src/secrets.ts. Each
 * value is cached per cold start.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let cachedBearer: string | null = null;
let cachedHmac: string | null = null;
let smClient: SecretsManagerClient | null = null;

function getSm(): SecretsManagerClient {
  if (smClient) return smClient;
  smClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  return smClient;
}

async function fetchSecret(arnEnv: string, label: string): Promise<string> {
  const arn = process.env[arnEnv];
  if (!arn) throw new Error(`${arnEnv} env var not set`);
  const r = await getSm().send(new GetSecretValueCommand({ SecretId: arn }));
  const v = r.SecretString;
  if (!v) throw new Error(`${label} secret is empty`);
  if (v === 'PLACEHOLDER') {
    throw new Error(
      `${label} secret is PLACEHOLDER — seed via scripts/seed-secrets.sh before accepting traffic`,
    );
  }
  return v;
}

export async function getBearer(): Promise<string> {
  if (cachedBearer) return cachedBearer;
  cachedBearer = await fetchSecret('CHROME_BEARER_SECRET_ARN', 'chrome-extension Bearer');
  return cachedBearer;
}

export async function getHmacSecret(): Promise<string> {
  if (cachedHmac) return cachedHmac;
  cachedHmac = await fetchSecret('CHROME_HMAC_SECRET_ARN', 'chrome-extension HMAC');
  return cachedHmac;
}

/** Test-only — clear cached values + client between tests. */
export function __resetSecretsForTests(): void {
  cachedBearer = null;
  cachedHmac = null;
  smClient = null;
}
