/**
 * @kos/service-telegram-bot — CAP-01 ingress Lambda.
 *
 * Realizes D-01 (Telegram-only capture via grammY on Lambda webhook) and
 * D-02 stage-1 (immediate "⏳ Klassificerar…" / "⏳ Transkriberar…" ack).
 * D-04 is enforced structurally: this Lambda only does S3 put + PutEvents;
 * agent routing happens later via EventBridge rules.
 *
 * Threat mitigations:
 *  - T-02-WEBHOOK-01 (spoofing): `x-telegram-bot-api-secret-token` is
 *    validated BEFORE any body parsing; mismatch returns 401.
 *  - T-02-WEBHOOK-04 (EoP, non-Kevin user): `ctx.from.id` is checked against
 *    `KEVIN_TELEGRAM_USER_ID`; non-Kevin messages are silently dropped
 *    (returns 200 to Telegram so it stops retrying) and NO event is published.
 *  - T-02-WEBHOOK-03 (info disclosure): bot token only flows through the
 *    cached `getTelegramSecrets()` helper; never logged.
 *  - T-02-S3-01 (path traversal): S3 key is built from the ULID + UTC date,
 *    never from user input.
 */
import { Bot, webhookCallback } from 'grammy';
import { ulid } from 'ulid';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { init as sentryInit, wrapHandler } from '@sentry/aws-serverless';
import { CaptureReceivedSchema } from '@kos/contracts';
import { getTelegramSecrets } from './secrets.js';
import { putVoiceAudio } from './s3.js';
import { publishCaptureReceived } from './events.js';

sentryInit({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  sampleRate: 1,
});

/** Access-control: only Kevin's Telegram user ID may produce events (ASVS V4). */
function kevinTelegramUserId(): number {
  const raw = process.env.KEVIN_TELEGRAM_USER_ID;
  if (!raw) throw new Error('KEVIN_TELEGRAM_USER_ID env var not set');
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`KEVIN_TELEGRAM_USER_ID is not an integer: ${raw}`);
  }
  return n;
}

let botPromise: Promise<Bot> | null = null;
async function getBot(): Promise<Bot> {
  if (botPromise) return botPromise;
  botPromise = (async () => {
    const { botToken } = await getTelegramSecrets();
    // Optional botInfo injection (TELEGRAM_BOT_INFO_JSON) lets tests and
    // operators skip grammY's startup getMe call. Production leaves it unset.
    const botInfoRaw = process.env.TELEGRAM_BOT_INFO_JSON;
    const botInfo = botInfoRaw ? JSON.parse(botInfoRaw) : undefined;
    const bot = botInfo ? new Bot(botToken, { botInfo }) : new Bot(botToken);
    const kevinId = kevinTelegramUserId();

    bot.on('message:text', async (ctx) => {
      if (ctx.from?.id !== kevinId) return; // silent drop — access control
      const capture_id = ulid();
      const detail = {
        capture_id,
        channel: 'telegram' as const,
        kind: 'text' as const,
        text: ctx.message.text,
        sender: { id: ctx.from.id, display: ctx.from.first_name },
        received_at: new Date().toISOString(),
        telegram: {
          chat_id: ctx.chat.id,
          message_id: ctx.message.message_id,
        },
      };
      CaptureReceivedSchema.parse(detail);
      await publishCaptureReceived(detail);
      try {
        await ctx.reply('⏳ Klassificerar…', {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      } catch (err) {
        // Ack is best-effort; event is already published.
        console.warn('stage-1 ack (text) failed:', err);
      }
    });

    bot.on('message:voice', async (ctx) => {
      if (ctx.from?.id !== kevinId) return;
      const capture_id = ulid();
      const file = await ctx.getFile();
      if (!file.file_path) {
        throw new Error('telegram getFile returned no file_path');
      }
      const { botToken: token } = await getTelegramSecrets();
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        throw new Error(`telegram file download failed: ${resp.status}`);
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const mimeType = ctx.message.voice.mime_type ?? 'audio/ogg';
      const { bucket, key } = await putVoiceAudio(capture_id, bytes, mimeType);
      const detail = {
        capture_id,
        channel: 'telegram' as const,
        kind: 'voice' as const,
        raw_ref: {
          s3_bucket: bucket,
          s3_key: key,
          duration_sec: ctx.message.voice.duration,
          mime_type: mimeType,
        },
        sender: { id: ctx.from.id, display: ctx.from.first_name },
        received_at: new Date().toISOString(),
        telegram: {
          chat_id: ctx.chat.id,
          message_id: ctx.message.message_id,
        },
      };
      CaptureReceivedSchema.parse(detail);
      await publishCaptureReceived(detail);
      try {
        await ctx.reply('⏳ Transkriberar…', {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      } catch (err) {
        console.warn('stage-1 ack (voice) failed:', err);
      }
    });

    return bot;
  })();
  return botPromise;
}

/** Test-only hook to reset the cached Bot promise between tests. */
export function __resetBotForTests(): void {
  botPromise = null;
}

export const handler = wrapHandler(
  async (
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyResultV2> => {
    const { webhookSecret } = await getTelegramSecrets();
    const hdr = event.headers?.['x-telegram-bot-api-secret-token'];
    if (hdr !== webhookSecret) {
      return { statusCode: 401, body: 'invalid secret' };
    }
    const bot = await getBot();
    const cb = webhookCallback(bot, 'aws-lambda-async');
    const res = await cb(event, {});
    return res as unknown as APIGatewayProxyResultV2;
  },
);
