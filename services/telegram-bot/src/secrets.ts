/**
 * Secrets Manager cache for the Telegram bot Lambda (CAP-01).
 *
 * Both secrets are fetched in parallel on first invocation and cached in
 * module scope (Pitfall 11 — cold-start mitigation; warm invocations skip
 * the Secrets Manager round-trip entirely). Throws if either value is the
 * `PLACEHOLDER` shell written by Plan 02-00.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

let cached: { botToken: string; webhookSecret: string } | null = null;

export async function getTelegramSecrets(): Promise<{
  botToken: string;
  webhookSecret: string;
}> {
  if (cached) return cached;
  const botArn = process.env.TELEGRAM_BOT_TOKEN_SECRET_ARN;
  const hookArn = process.env.TELEGRAM_WEBHOOK_SECRET_ARN;
  if (!botArn) throw new Error('TELEGRAM_BOT_TOKEN_SECRET_ARN not set');
  if (!hookArn) throw new Error('TELEGRAM_WEBHOOK_SECRET_ARN not set');
  const [bot, hook] = await Promise.all([
    client.send(new GetSecretValueCommand({ SecretId: botArn })),
    client.send(new GetSecretValueCommand({ SecretId: hookArn })),
  ]);
  const botToken = bot.SecretString ?? '';
  const webhookSecret = hook.SecretString ?? '';
  if (!botToken || botToken === 'PLACEHOLDER') {
    throw new Error('TELEGRAM_BOT_TOKEN not seeded');
  }
  if (!webhookSecret || webhookSecret === 'PLACEHOLDER') {
    throw new Error('TELEGRAM_WEBHOOK_SECRET not seeded');
  }
  cached = { botToken, webhookSecret };
  return cached;
}

/** Test-only helper: reset the module-scope cache between tests. */
export function __resetSecretsCacheForTests(): void {
  cached = null;
}
