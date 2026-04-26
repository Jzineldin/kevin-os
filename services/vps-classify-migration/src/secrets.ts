/**
 * VPS classify-adapter HMAC secret loader (MIG-01).
 *
 * Pulls `kos/vps-classify-hmac-secret` from AWS Secrets Manager once per
 * cold start and caches the value in module scope. CDK creates the secret
 * with placeholder value `'PLACEHOLDER'` (Wave 0 — see `MigrationStack`);
 * Plan 10-01 cutover step rotates the value to the production secret that
 * the VPS-side `classify_and_save.py` caller is also configured with.
 *
 * Fail-closed semantics:
 *   - HMAC_SECRET_ARN unset                 → throw (Lambda misconfiguration)
 *   - secret value empty                    → throw (operator forgot to seed)
 *   - secret value === 'PLACEHOLDER'        → throw (CDK default leaked)
 *
 * Anything that lets the Lambda accept traffic with the placeholder secret
 * lets any attacker who guessed the literal string forge captures, so we
 * fail closed. Same posture as `services/ios-webhook/src/secrets.ts`.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let cached: string | null = null;
let smClient: SecretsManagerClient | null = null;

function getSm(): SecretsManagerClient {
  if (smClient) return smClient;
  smClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  return smClient;
}

/**
 * Resolve the VPS classify-adapter HMAC secret from Secrets Manager.
 * @throws if `HMAC_SECRET_ARN` is unset, or the secret value is empty /
 *         the literal string 'PLACEHOLDER'.
 */
export async function getHmacSecret(): Promise<string> {
  if (cached) return cached;
  const arn = process.env.HMAC_SECRET_ARN;
  if (!arn) {
    throw new Error('HMAC_SECRET_ARN env var not set');
  }
  const r = await getSm().send(new GetSecretValueCommand({ SecretId: arn }));
  const v = r.SecretString;
  if (!v) {
    throw new Error('vps-classify HMAC secret is empty');
  }
  if (v === 'PLACEHOLDER') {
    throw new Error(
      'vps-classify HMAC secret is PLACEHOLDER — operator must seed kos/vps-classify-hmac-secret before flipping the cutover',
    );
  }
  cached = v;
  return v;
}

/** Test-only hook to clear the cached secret + client between tests. */
export function __resetSecretsForTests(): void {
  cached = null;
  smClient = null;
}
