/**
 * Phase 11 Plan 11-04 part B — voice-to-chat routing.
 *
 * Kevin's voice memos normally flow through triage → voice-capture →
 * Notion Command Center. But some voice memos are *questions* to KOS,
 * not tasks to persist. This module detects those and routes them to
 * the /chat backend instead.
 *
 * Detection heuristics (deliberately conservative — err on treating as
 * capture, since misclassifying a real task as a chat query silently
 * drops it):
 *   - Transcript starts with "hej kos" / "hey kos" / "yo kos" / "kos,"
 *   - OR ends with "?" and is short (≤200 chars) — longer texts are
 *     usually narrated thoughts even if they contain a question mark.
 *   - OR is a short single-sentence interrogative starting with
 *     "vem/vad/när/varför/hur/who/what/when/why/how".
 */

const GREETING_PREFIXES = [
  'hej kos',
  'hey kos',
  'hi kos',
  'yo kos',
  'kos,',
  'kos:',
  'kos ',
];
const SWEDISH_INTERROGATIVES = [
  'vem ',
  'vad ',
  'vilken ',
  'vilka ',
  'vilket ',
  'när ',
  'varför ',
  'varfor ',
  'hur ',
];
const ENGLISH_INTERROGATIVES = [
  'who ',
  'what ',
  'which ',
  'when ',
  'where ',
  'why ',
  'how ',
];

/** Normalise a transcript for matching — lowercase + trim. */
function normalize(text: string): string {
  return text.trim().toLowerCase();
}

export interface DetectChatArgs {
  /** The Transcribe output. May be Swedish, English, or code-switched. */
  text: string;
}

export function isChatQuestion({ text }: DetectChatArgs): boolean {
  if (!text) return false;
  const t = normalize(text);
  if (t.length === 0) return false;

  // Rule 1: explicit greeting prefix — unambiguous intent.
  if (GREETING_PREFIXES.some((p) => t.startsWith(p))) return true;

  // Rule 2: short-and-ends-with-?
  if (t.endsWith('?') && t.length <= 200) return true;

  // Rule 3: single-sentence interrogative.
  // Count sentence-ending punctuation; bail if >1 (narrated thought).
  const sentenceCount = (t.match(/[.!?]/g) ?? []).length;
  if (sentenceCount <= 1 && t.length <= 200) {
    if (
      SWEDISH_INTERROGATIVES.some((w) => t.startsWith(w)) ||
      ENGLISH_INTERROGATIVES.some((w) => t.startsWith(w))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Strip a greeting prefix so the chat backend sees a clean question.
 * 'Hey KOS, vem är Robin?' → 'vem är Robin?'
 */
export function stripGreetingPrefix(text: string): string {
  const t = text.trimStart();
  const tLower = t.toLowerCase();
  for (const p of GREETING_PREFIXES) {
    if (tLower.startsWith(p)) {
      return t.slice(p.length).replace(/^[,:\s]+/, '').trim();
    }
  }
  return t;
}

export interface ChatAnswer {
  answer: string;
  citations: Array<{ entity_id: string; name: string }>;
}

export async function invokeChat(message: string): Promise<ChatAnswer> {
  const endpoint = process.env.KOS_CHAT_ENDPOINT;
  const bearer = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!endpoint || !bearer) {
    throw new Error(
      '[voice-capture] KOS_CHAT_ENDPOINT or KOS_DASHBOARD_BEARER_TOKEN missing',
    );
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `kos_session=${bearer}`,
    },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`chat endpoint ${res.status}: ${body.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as ChatAnswer;
  return {
    answer: parsed.answer ?? '',
    citations: parsed.citations ?? [],
  };
}
