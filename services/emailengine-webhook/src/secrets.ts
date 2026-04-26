/**
 * EmailEngine-webhook shared X-EE-Secret loader (CAP-07 / Plan 04-03).
 *
 * Pulls `kos/emailengine-webhook-secret` from AWS Secrets Manager once per
 * cold start and caches the value in module scope. Operator pre-seeds the
 * value via `scripts/seed-secrets.sh` after CDK deploy; until then the
 * secret string is the literal `'PLACEHOLDER'`.
 *
 * `getWebhookSecret` deliberately throws when the secret is unset OR still
 * 'PLACEHOLDER' — the handler MUST fail closed: a Lambda accepting traffic
 * with the placeholder secret would let any attacker who guessed the literal
 * string forge `messageNew` events into kos.capture.
 *
 * Mirrors services/ios-webhook/src/secrets.ts conventions verbatim so a
 * single hardening playbook covers both webhook surfaces.
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
 * Resolve the EmailEngine webhook secret from Secrets Manager.
 * @throws if `EE_WEBHOOK_SECRET_ARN` is unset, or the secret value is empty /
 *         the literal string 'PLACEHOLDER'.
 */
export async function getWebhookSecret(): Promise<string> {
  if (cached) return cached;
  const arn = process.env.EE_WEBHOOK_SECRET_ARN;
  if (!arn) {
    throw new Error('EE_WEBHOOK_SECRET_ARN env var not set');
  }
  const r = await getSm().send(new GetSecretValueCommand({ SecretId: arn }));
  const v = r.SecretString;
  if (!v) {
    throw new Error('emailengine webhook secret is empty');
  }
  if (v === 'PLACEHOLDER') {
    throw new Error(
      'emailengine webhook secret is PLACEHOLDER — seed via scripts/seed-secrets.sh before accepting traffic',
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
