/**
 * @kos/service-telegram-bot /chat integration (Phase 11 Plan 11-03).
 *
 * Routes both /ask commands and conversational plain text to kos-chat Lambda.
 * Manages per-chat-id session persistence in localStorage-like pattern
 * (for Telegram context, we store in a module-level Map keyed by chat_id).
 *
 * Why HTTP-via-Vercel vs direct Lambda invoke:
 *   - Direct invoke requires cross-stack ref which complicates CDK.
 *   - Vercel proxy is already deployed, already bearer-auth'd.
 *   - Telegram bot runs outside VPC with unrestricted egress — HTTPS just works.
 */

// Session storage — in-memory map of chat_id → sessionId.
// In production, this could be backed by DynamoDB for persistence across Lambda invocations.
// For now, per-warm-Lambda is sufficient since Telegram-to-Lambda calls are frequent.
const sessionCache = new Map<string, string>();

export async function getOrCreateChatSession(chatId: string): Promise<string | undefined> {
  return sessionCache.get(chatId);
}

export async function storeChatSession(chatId: string, sessionId: string): Promise<void> {
  sessionCache.set(chatId, sessionId);
}

export interface ChatAnswer {
  answer: string;
  citations: Array<{ entity_id: string; name: string }>;
  sessionId: string;
}

export interface InvokeChatArgs {
  message: string;
  sessionId?: string;
  source?: 'dashboard' | 'telegram';
  externalId?: string;
}

export async function invokeChat({
  message,
  sessionId,
  source = 'telegram',
  externalId,
}: InvokeChatArgs): Promise<ChatAnswer> {
  const endpoint = process.env.KOS_CHAT_ENDPOINT;
  if (!endpoint) {
    throw new Error('KOS_CHAT_ENDPOINT not set on telegram-bot Lambda');
  }
  const bearer = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!bearer) {
    throw new Error('KOS_DASHBOARD_BEARER_TOKEN not set on telegram-bot Lambda');
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      message,
      sessionId: sessionId ?? undefined,
      source,
      externalId: externalId ?? 'default',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`chat endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const parsed = (await res.json()) as ChatAnswer;
  return {
    answer: parsed.answer ?? '',
    citations: parsed.citations ?? [],
    sessionId: parsed.sessionId,
  };
}

/**
 * Telegram messages max 4096 chars. Split on newlines to keep
 * paragraphs intact; fall back to hard-slicing if a single paragraph
 * exceeds the limit. Empty parts skipped.
 */
export function splitForTelegram(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  const lines = text.split('\n');
  let buf = '';
  for (const line of lines) {
    if (buf.length + line.length + 1 > max) {
      if (buf) parts.push(buf);
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) {
          parts.push(line.slice(i, i + max));
        }
        buf = '';
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}
