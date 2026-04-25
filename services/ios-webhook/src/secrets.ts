/**
 * iOS-webhook shared HMAC secret loader (CAP-02 / D-01).
 *
 * Pulls `kos/ios-shortcut-webhook-secret` from AWS Secrets Manager once per
 * cold start and caches the value in module scope. Operator pre-seeds the
 * value via `scripts/seed-secrets.sh` after CDK deploy; until then the
 * secret string is the literal `'PLACEHOLDER'` (DataStack initialiser).
 *
 * `getWebhookSecret` deliberately throws when the secret is unset OR still
 * 'PLACEHOLDER' — the handler MUST fail closed (T-04-IOS-03 / T-04-IOS-06):
 * a Lambda accepting traffic with the placeholder secret would let any
 * attacker who guessed the literal string forge captures.
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
 * Resolve the iOS Shortcut webhook secret from Secrets Manager.
 * @throws if `WEBHOOK_SECRET_ARN` is unset, or the secret value is empty /
 *         the literal string 'PLACEHOLDER'.
 */
export async function getWebhookSecret(): Promise<string> {
  if (cached) return cached;
  const arn = process.env.WEBHOOK_SECRET_ARN;
  if (!arn) {
    throw new Error('WEBHOOK_SECRET_ARN env var not set');
  }
  const r = await getSm().send(new GetSecretValueCommand({ SecretId: arn }));
  const v = r.SecretString;
  if (!v) {
    throw new Error('iOS webhook secret is empty');
  }
  if (v === 'PLACEHOLDER') {
    throw new Error(
      'iOS webhook secret is PLACEHOLDER — seed via scripts/seed-secrets.sh before accepting traffic',
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
