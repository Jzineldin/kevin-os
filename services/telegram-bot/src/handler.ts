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
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { CaptureReceivedSchema } from '@kos/contracts';
import { getTelegramSecrets } from './secrets.js';
import { putVoiceAudio, putVoiceMeta } from './s3.js';
import { publishCaptureReceived } from './events.js';

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
      // Plan 02-10: tag this OTel span so the capture_id is queryable as
      // Langfuse session.id across triage → voice-capture → resolver.
      tagTraceWithCaptureId(capture_id);
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
      tagTraceWithCaptureId(capture_id);
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
      // Plan 02-02 bridge: transcribe-complete reads this sidecar to
      // reconstruct the capture.voice.transcribed event payload (chat_id,
      // message_id, sender) — Transcribe itself doesn't carry these.
      await putVoiceMeta(capture_id, {
        raw_ref: detail.raw_ref,
        sender: detail.sender,
        received_at: detail.received_at,
        telegram: detail.telegram,
      });
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
    context?: unknown,
  ): Promise<APIGatewayProxyResultV2> => {
    console.log('[tg] handler start');
    await initSentry();
    console.log('[tg] sentry ok');
    const { webhookSecret } = await getTelegramSecrets();
    console.log('[tg] secrets ok');
    const hdr = event.headers?.['x-telegram-bot-api-secret-token'];
    if (hdr !== webhookSecret) {
      console.log('[tg] secret mismatch');
      return { statusCode: 401, body: 'invalid secret' };
    }
    console.log('[tg] secret valid, getting bot');
    const bot = await getBot();
    console.log('[tg] bot ready, invoking callback');
    // Switched from 'aws-lambda-async' to 'aws-lambda' (2026-04-22, Wave 5
    // Gap D follow-on). The async adapter returns immediately and processes
    // updates in the background, but Lambda suspends execution after handler
    // return — so the actual update never gets processed. Sync adapter
    // returns 200 only after the full message handler completes (S3 put +
    // PutEvents + ack). That's ~1-2s for text, ~5s for voice — well within
    // the 30s Lambda timeout and Telegram's 60s webhook timeout.
    const cb = webhookCallback(bot, 'aws-lambda');
    // grammy's 'aws-lambda' adapter requires the classic 3-arg signature
    // (event, context, callback). We're in Function URL / HTTP API style
    // (2-arg promise return), so provide a minimal callback that resolves.
    const noopCallback = (_err: unknown, result: Record<string, unknown>) =>
      Promise.resolve(result);
    const res = await cb(
      event as unknown as { body?: string; headers: Record<string, string | undefined> },
      context,
      noopCallback,
    );
    console.log('[tg] callback done', JSON.stringify(res).slice(0, 200));
    return res as unknown as APIGatewayProxyResultV2;
  },
);
