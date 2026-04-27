/**
 * @kos/service-telegram-bot /chat integration (Phase 11 Plan 11-03).
 *
 * When Kevin types `/ask <question>` or `/chat <question>` to the bot,
 * the message is routed here instead of the standard capture flow. We
 * HTTP-POST the query to the Vercel `/api/chat` proxy (which in turn
 * calls dashboard-api's POST /chat — Sonnet 4.6 + Kevin Context +
 * hot entities) and reply to the same Telegram thread with the answer.
 *
 * Non-commands (plain text, voice) still flow through the capture
 * pipeline unchanged — this is strictly additive.
 *
 * Why HTTP-via-Vercel vs direct Lambda invoke:
 *   - Direct invoke requires a cross-stack ref (capture-stack ←
 *     dashboard-stack.functionArn) which complicates the CDK
 *     dependency graph.
 *   - Vercel proxy is already deployed, already bearer-auth'd, and
 *     telegram-bot runs outside the VPC (D-05) with unrestricted
 *     egress — HTTP just works.
 *
 * Timeout: the chat handler can take 8-15s for a cold Bedrock call.
 * Telegram's webhook timeout is 25s so we stay well within.
 */

export interface ChatAnswer {
  answer: string;
  citations: Array<{ entity_id: string; name: string }>;
}

export interface InvokeChatArgs {
  message: string;
}

export async function invokeChat({ message }: InvokeChatArgs): Promise<ChatAnswer> {
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
      // Vercel middleware accepts EITHER `Cookie: kos_session=<token>`
      // OR `Authorization: Bearer <token>`. Cookie is simpler here.
      cookie: `kos_session=${bearer}`,
    },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`chat endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as ChatAnswer;
  return {
    answer: parsed.answer ?? '',
    citations: parsed.citations ?? [],
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
