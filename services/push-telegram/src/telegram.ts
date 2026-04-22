/**
 * Telegram Bot API sender.
 *
 * Replaces the Phase 1 console.log stub with a real `POST
 * https://api.telegram.org/bot{TOKEN}/sendMessage` call. Used by both the
 * `is_reply=true` synchronous-ack path (Kevin-initiated replies like
 * voice-capture's "✅ Saved to Command Center · …") and the normal
 * active-hours send path for non-reply pushes.
 *
 * Bot API shape:
 *   POST /bot{TOKEN}/sendMessage
 *     body: { chat_id, text, [reply_parameters: { message_id }] }
 *
 * Bot API 7.0+ introduced `reply_parameters` as the canonical replacement
 * for the legacy `reply_to_message_id` field. We emit the new shape; the
 * API still accepts the legacy field for backward-compat but new integrations
 * should use reply_parameters.
 *
 * Error handling:
 *   - Any non-2xx or `ok: false` response throws; the handler catches,
 *     queues to telegram_inbox_queue with reason='send-failed', and
 *     re-throws so the EventBridge rule retries within its DLQ budget.
 *   - The token is fetched via Secrets Manager (module-scope cache — see
 *     ./secrets.ts) so cold-start overhead is bounded to ~80ms once.
 */
import { getBotToken } from './secrets.js';

export interface SendMessageInput {
  chat_id: number;
  text: string;
  reply_to_message_id?: number;
}

export interface SendMessageResult {
  ok: true;
  message_id: number;
}

export async function sendTelegramMessage(
  i: SendMessageInput,
): Promise<SendMessageResult> {
  const token = await getBotToken();
  const body: Record<string, unknown> = {
    chat_id: i.chat_id,
    text: i.text,
  };
  if (i.reply_to_message_id) {
    body.reply_parameters = { message_id: i.reply_to_message_id };
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };
  if (!res.ok || !json.ok) {
    throw new Error(
      `telegram sendMessage failed: ${res.status} ${json.description ?? 'unknown'}`,
    );
  }
  return { ok: true, message_id: json.result!.message_id };
}
