/**
 * linkedin-webhook secrets loader (Plan 05-02 / CAP-05).
 *
 * Loads two values from AWS Secrets Manager once per cold start:
 *   - kos/linkedin-webhook-bearer  (Bearer token; pasted into the extension)
 *   - kos/linkedin-webhook-hmac    (Shared HMAC secret; same)
 *
 * Both placeholders are seeded by CDK with `RemovalPolicy.RETAIN`. The
 * operator rotates real values via `aws secretsmanager put-secret-value`
 * (see Plan 05-02 §operator-runbook). Until then `getSecrets` throws — the
 * Lambda MUST fail closed when either secret is empty / 'PLACEHOLDER',
 * otherwise an attacker who guesses the literal placeholder string could
 * forge captures (mirrors the iOS-webhook fail-closed posture).
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

interface CachedSecrets {
  bearer: string;
  hmacSecret: string;
}

let cached: CachedSecrets | null = null;
let smClient: SecretsManagerClient | null = null;

function getSm(): SecretsManagerClient {
  if (smClient) return smClient;
  smClient = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  return smClient;
}

export async function getSecrets(): Promise<CachedSecrets> {
  if (cached) return cached;
  const bearerArn = process.env.BEARER_SECRET_ARN;
  const hmacArn = process.env.HMAC_SECRET_ARN;
  if (!bearerArn) throw new Error('BEARER_SECRET_ARN env var not set');
  if (!hmacArn) throw new Error('HMAC_SECRET_ARN env var not set');
  const sm = getSm();
  const [b, h] = await Promise.all([
    sm.send(new GetSecretValueCommand({ SecretId: bearerArn })),
    sm.send(new GetSecretValueCommand({ SecretId: hmacArn })),
  ]);
  const bearer = b.SecretString;
  const hmacSecret = h.SecretString;
  if (!bearer || bearer === 'PLACEHOLDER') {
    throw new Error(
      'linkedin-webhook bearer is empty/PLACEHOLDER — seed before accepting traffic',
    );
  }
  if (!hmacSecret || hmacSecret === 'PLACEHOLDER') {
    throw new Error(
      'linkedin-webhook hmac secret is empty/PLACEHOLDER — seed before accepting traffic',
    );
  }
  cached = { bearer, hmacSecret };
  return cached;
}

/** Test-only hook to clear the cached secrets + client between tests. */
export function __resetSecretsForTests(): void {
  cached = null;
  smClient = null;
}
