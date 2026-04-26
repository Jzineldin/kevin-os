/**
 * Gmail API v1 wrapper for the gmail-poller (replaces EmailEngine).
 *
 * Two entry points:
 *   - listNewMessageIds(args): returns Gmail message IDs received within a
 *     bounded time window. Uses `users.messages.list` with the search query
 *     `newer_than:Nm in:inbox` (Gmail's native search; no need for the
 *     History API + state row, at the cost of fetching ~5min of overlap
 *     each poll — idempotency at the email_drafts UNIQUE(account,message)
 *     constraint absorbs the duplication).
 *   - fetchMessage(args): returns the full message body parsed into
 *     CaptureReceivedEmailInbox shape (matches the schema email-triage
 *     already consumes via `kind: email_inbox`).
 *
 * Why polling + `newer_than:` instead of History API:
 *   - History API requires per-account `last_history_id` state. Polling +
 *     idempotent UNIQUE constraint is one table fewer for one extra
 *     `messages.list` call per cycle — net simpler.
 *   - Quota cost per poll: 1 list + N gets. At 1 email / 5 min average,
 *     N = 1, so ~12 quota units per minute per account. Free tier covers
 *     this orders of magnitude over.
 *
 * Body decoding:
 *   - Gmail returns body as base64url-encoded MIME parts. We walk the
 *     payload tree, picking text/plain (preferred) + text/html (optional).
 *   - Multipart messages: pick the first text/plain part anywhere in the
 *     tree; same for text/html.
 *
 * Read-only scope: `https://www.googleapis.com/auth/gmail.readonly`. The
 * gmail-poller has structurally NO write path — it cannot mark messages
 * read, archive, label, or send.
 */

export interface GmailMessageMeta {
  id: string;
  threadId: string;
}

export interface GmailParsedMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: string;
}

export class GmailAuthStaleError extends Error {
  code = 'auth_stale' as const;
  constructor(message = 'gmail auth stale') {
    super(message);
    this.name = 'GmailAuthStaleError';
  }
}

interface RawGmailListResponse {
  messages?: GmailMessageMeta[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface RawGmailHeader {
  name?: string;
  value?: string;
}

interface RawGmailBody {
  data?: string;
  size?: number;
}

interface RawGmailPart {
  mimeType?: string;
  filename?: string;
  headers?: RawGmailHeader[];
  body?: RawGmailBody;
  parts?: RawGmailPart[];
}

interface RawGmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: RawGmailPart;
}

export interface ListNewArgs {
  accessToken: string;
  /**
   * Lower bound for messages to fetch, expressed as Unix epoch SECONDS.
   * Gmail's `after:` operator supports this directly. (Do NOT use
   * `newer_than:Nm` — Gmail interprets `m` as MONTHS, not minutes.)
   * Default: now - 6 minutes.
   */
  afterEpochSec?: number;
}

export async function listNewMessageIds(args: ListNewArgs): Promise<GmailMessageMeta[]> {
  const afterEpochSec =
    args.afterEpochSec ?? Math.floor(Date.now() / 1000) - 6 * 60;
  // `in:inbox` excludes sent, drafts, spam. `-in:chats` filters Hangouts/
  // Chat threads which Gmail surfaces here.
  const q = `after:${afterEpochSec} in:inbox -in:chats`;
  const out: GmailMessageMeta[] = [];
  let pageToken: string | undefined;
  // Cap to 250 messages per poll to keep the per-cycle quota bounded.
  for (let page = 0; page < 5; page += 1) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', q);
    url.searchParams.set('maxResults', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    });
    if (r.status === 401) {
      throw new GmailAuthStaleError('gmail messages.list 401');
    }
    if (!r.ok) {
      throw new Error(`gmail messages.list ${r.status}: ${await r.text()}`);
    }
    const body = (await r.json()) as RawGmailListResponse;
    for (const m of body.messages ?? []) {
      if (m.id && m.threadId) out.push({ id: m.id, threadId: m.threadId });
    }
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}

export interface FetchMessageArgs {
  accessToken: string;
  messageId: string;
}

export async function fetchMessage(args: FetchMessageArgs): Promise<GmailParsedMessage> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}`,
  );
  url.searchParams.set('format', 'full');
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  if (r.status === 401) {
    throw new GmailAuthStaleError(`gmail messages.get 401 on ${args.messageId}`);
  }
  if (!r.ok) {
    throw new Error(`gmail messages.get ${r.status}: ${await r.text()}`);
  }
  const raw = (await r.json()) as RawGmailMessage;
  return parseGmailMessage(raw);
}

function parseGmailMessage(raw: RawGmailMessage): GmailParsedMessage {
  if (!raw.id || !raw.threadId) {
    throw new Error('gmail message missing id/threadId');
  }
  const headers = headerMap(raw.payload?.headers ?? []);
  const subject = headers.get('subject') ?? '(no subject)';
  const from = headers.get('from') ?? '';
  const to = splitAddresses(headers.get('to'));
  const cc = splitAddresses(headers.get('cc'));
  const internalMs = raw.internalDate ? Number(raw.internalDate) : Date.now();
  const receivedAt = new Date(internalMs).toISOString();
  const bodyText = pickPart(raw.payload, 'text/plain') ?? '';
  const bodyHtml = pickPart(raw.payload, 'text/html');
  return {
    id: raw.id,
    threadId: raw.threadId,
    from,
    to,
    cc,
    subject,
    bodyText,
    bodyHtml,
    receivedAt,
  };
}

function headerMap(headers: RawGmailHeader[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers) {
    if (h.name && h.value) m.set(h.name.toLowerCase(), h.value);
  }
  return m;
}

function splitAddresses(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function pickPart(part: RawGmailPart | undefined, wantedMime: string): string | null {
  if (!part) return null;
  if (part.mimeType === wantedMime && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const sub of part.parts ?? []) {
    const found = pickPart(sub, wantedMime);
    if (found !== null) return found;
  }
  return null;
}

function decodeBase64Url(s: string): string {
  // Gmail uses URL-safe base64 (RFC 4648 §5) with no padding. Convert to
  // standard base64 then decode.
  const standard = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
  return Buffer.from(standard + pad, 'base64').toString('utf8');
}
