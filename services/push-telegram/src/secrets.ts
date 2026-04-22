/**
 * Bot-token fetcher for push-telegram.
 *
 * Plan 02-06 replaces the Phase 1 console.log sender stub with a real
 * Telegram Bot API call, which means this Lambda now needs the bot token
 * on every warm invocation. To keep cold-starts fast (Pitfall 11 —
 * Secrets Manager is ~80ms per call) we cache the token in module scope
 * after the first fetch.
 *
 * The secret itself is seeded out-of-band (Phase 1 Plan 01-02 provisions
 * the `kos/telegram-bot-token` secret shell with SecretString='PLACEHOLDER';
 * Kevin rotates the real token in via `scripts/set-telegram-token.sh`).
 * If the operator forgot to seed the token we throw a clear error rather
 * than leaking `PLACEHOLDER` through to the Bot API (which returns 401).
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
let cachedToken: string | null = null;

/** Reset the module-scope cache; intended for tests only. */
export function __resetTokenCacheForTests(): void {
  cachedToken = null;
}

export async function getBotToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const arn = process.env.TELEGRAM_BOT_TOKEN_SECRET_ARN;
  if (!arn) throw new Error('TELEGRAM_BOT_TOKEN_SECRET_ARN not set');
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const s = r.SecretString ?? '';
  if (!s || s === 'PLACEHOLDER') {
    throw new Error(
      'telegram bot token not seeded — set kos/telegram-bot-token in Secrets Manager',
    );
  }
  cachedToken = s;
  return cachedToken;
}
