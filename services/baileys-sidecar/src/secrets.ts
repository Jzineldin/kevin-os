/**
 * baileys-sidecar secret loader (Phase 5 / Plan 05-05 — CAP-06).
 *
 * One secret needed:
 *   - `kos/baileys-webhook-secret` — shared bearer-like secret used in the
 *     `X-BAILEYS-Secret` header. Same value is also passed back when this
 *     Lambda calls the Baileys Fargate container's `/media/{id}` endpoint
 *     to fetch decrypted audio bytes (bidirectional trust).
 *
 * Fail-closed posture matches services/chrome-webhook/secrets.ts +
 * services/ios-webhook/src/secrets.ts:
 *   - missing env arn          → throw
 *   - empty SecretString       → throw
 *   - literal `'PLACEHOLDER'`  → throw  (CDK seeds with this)
 *
 * Cached per cold start. Use `__resetSecretsForTests()` in vitest to clear.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let cachedSecret: string | null = null;
let smClient: SecretsManagerClient | null = null;

function getSm(): SecretsManagerClient {
  if (smClient) return smClient;
  smClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  return smClient;
}

export async function getWebhookSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const arn = process.env.BAILEYS_WEBHOOK_SECRET_ARN;
  if (!arn) throw new Error('BAILEYS_WEBHOOK_SECRET_ARN env var not set');
  const r = await getSm().send(new GetSecretValueCommand({ SecretId: arn }));
  const v = r.SecretString;
  if (!v) throw new Error('baileys-webhook secret is empty');
  if (v === 'PLACEHOLDER') {
    throw new Error(
      'baileys-webhook secret is PLACEHOLDER — seed via scripts/seed-secrets.sh before accepting traffic',
    );
  }
  cachedSecret = v;
  return cachedSecret;
}

/** Test-only — clear cached value + client between tests. */
export function __resetSecretsForTests(): void {
  cachedSecret = null;
  smClient = null;
}
