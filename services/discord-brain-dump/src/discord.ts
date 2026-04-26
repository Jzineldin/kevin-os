/**
 * @kos/service-discord-brain-dump — Discord REST API wrapper.
 *
 * Phase 10 Plan 10-04 / CAP-10. Polls the Discord channel-messages endpoint
 * once per 5-min Scheduler fire; the cursor (`?after=<message_id>`) is owned
 * by `cursor.ts` (DynamoDB) and supplied by `handler.ts`. This module is the
 * narrow Discord-protocol seam:
 *
 *   - constructs a `GET /api/v10/channels/{id}/messages` request,
 *   - validates the response against `DiscordChannelMessageSchema`,
 *   - filters out bot-authored messages (we never want the system to
 *     re-ingest its own posts),
 *   - paginates forward (oldest-first) by recursively walking with
 *     `?after=<oldest_id_in_last_page>` until the page returns < limit OR a
 *     safety cap of MAX_PAGES is hit (prevents an infinite loop if Discord's
 *     pagination changes behavior),
 *   - converts 401/403/429/5xx into typed errors so the handler can choose
 *     graceful-degrade vs. fail-loud per the 05-06-DISCORD-CONTRACT.md
 *     graceful-degradation matrix.
 *
 * Discord pagination semantics (validated against the Discord API docs as of
 * 2026-04): `?after=<id>` returns messages strictly newer than `<id>`,
 * sorted **oldest-first within the page**, up to `limit=100`. So advancing
 * the cursor between pages means picking the LAST item in the last page
 * (the oldest unseen message of the next batch is the youngest of the
 * previous batch + 1). This is the correct forward-walk for catch-up after
 * an outage.
 *
 * Rate-limit handling: Discord global ceiling is 50 RPS, per-channel read
 * ceiling 10 RPS — at our 12-fires/hr we're 4 orders of magnitude under
 * either. But operator-side ad-hoc invocations can burst, so we honor
 * `Retry-After` on 429 with one sleep + retry; second 429 throws so the
 * handler can defer to the next 5-min fire.
 */
import { DiscordChannelMessageSchema, type DiscordChannelMessage } from '@kos/contracts';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_LIMIT = 50;
const MAX_PAGES = 10; // safety cap — 10 × 50 = 500 messages/run max
const RATE_LIMIT_RETRY_CAP_MS = 10_000; // do not sleep > 10s on 429

// ---------------------------------------------------------------------------
// Typed error hierarchy — handler decides graceful-degrade vs. fail-loud.
// ---------------------------------------------------------------------------

export class DiscordAuthError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DiscordAuthError';
    this.status = status;
  }
}

export class DiscordRateLimitError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Discord rate-limited (Retry-After ${retryAfterMs}ms)`);
    this.name = 'DiscordRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class DiscordTransientError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DiscordTransientError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchOptions {
  /** Override the global fetch impl — used by tests to return canned responses. */
  fetchImpl?: typeof fetch;
  /** Sleep impl override — tests pass a no-op so 429-retry tests don't real-sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-page batch size (default 50). Discord caps at 100. */
  limit?: number;
  /**
   * If true, bot-authored messages flow through. Default false (we never want
   * to re-ingest our own bot's output). Set via the INCLUDE_BOTS env var on
   * the Lambda for ad-hoc backfill experiments.
   */
  includeBots?: boolean;
  /**
   * Override the cap on pages walked per call. Tests pass a small number so
   * the safety-cap path is exercised without seeding 500 fake messages.
   */
  maxPages?: number;
}

/**
 * Fetch all new messages in `channelId` strictly after `cursor`.
 *
 * Returns messages **oldest-first** (suitable for sequential emit + cursor
 * advance). On a fresh cursor (`null`), the contract per Plan 05-06 is to
 * return ZERO messages and let the cold-start path's first fire seed the
 * cursor with the latest message id (no backfill); but that policy is
 * decided by the handler, NOT here. This module's job: return whatever
 * Discord says is newer than the supplied cursor.
 *
 * Throws:
 *   - `DiscordAuthError` (401/403): bot token revoked, channel inaccessible
 *   - `DiscordRateLimitError` (429): two consecutive rate-limits
 *   - `DiscordTransientError` (5xx + 408): retry next fire
 */
export async function fetchNewMessages(
  channelId: string,
  cursor: string | null,
  botToken: string,
  opts: FetchOptions = {},
): Promise<DiscordChannelMessage[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const includeBots = opts.includeBots ?? false;

  const collected: DiscordChannelMessage[] = [];
  let after = cursor;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchOnePage(channelId, after, botToken, limit, fetchImpl, sleep);
    if (page.length === 0) break;

    // Discord returns a page sorted by id descending (newest-first) when
    // `?after=` is set; we need oldest-first for sequential cursor advance,
    // so reverse the page in place. Snowflake IDs sort lexicographically
    // monotonic with creation time — sort by id ascending to be defensive
    // against any client quirks.
    page.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const msg of page) {
      if (!includeBots && msg.author.bot === true) continue;
      collected.push(msg);
    }

    pages += 1;
    if (page.length < limit) break;
    // Next page: walk forward from the OLDEST id of the previous page +
    // 1 — which on Discord means the newest id we just saw. Discord's
    // `after` is exclusive, so passing the highest id we've seen yields the
    // next batch.
    const lastId = page[page.length - 1]!.id;
    after = lastId;
  }

  return collected;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fetchOnePage(
  channelId: string,
  after: string | null,
  botToken: string,
  limit: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<DiscordChannelMessage[]> {
  const url = buildUrl(channelId, after, limit);
  const headers = {
    Authorization: `Bot ${botToken}`,
    'User-Agent': 'KosDiscordBrainDump (https://kos.tale-forge.app, 1.0)',
    Accept: 'application/json',
  };

  // First attempt.
  let res = await fetchImpl(url, { method: 'GET', headers });
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res);
    const capped = Math.min(retryAfterMs, RATE_LIMIT_RETRY_CAP_MS);
    await sleep(capped);
    // One retry. If still 429, give up gracefully — the next 5-min fire
    // resumes from the same cursor with no data loss.
    res = await fetchImpl(url, { method: 'GET', headers });
    if (res.status === 429) {
      const retryAfterMs2 = parseRetryAfter(res);
      throw new DiscordRateLimitError(retryAfterMs2);
    }
  }

  if (res.status === 401 || res.status === 403) {
    const detail = await safeReadText(res);
    throw new DiscordAuthError(
      res.status,
      `Discord ${res.status} on /channels/${channelId}/messages — token revoked or insufficient permissions: ${detail}`,
    );
  }
  if (res.status === 404) {
    // Channel deleted / bot kicked. Treat as auth-class error so handler
    // exits cleanly and operator gets a system_alerts row.
    const detail = await safeReadText(res);
    throw new DiscordAuthError(
      404,
      `Discord 404 on /channels/${channelId}/messages — channel archived or bot kicked: ${detail}`,
    );
  }
  if (res.status >= 500 || res.status === 408) {
    const detail = await safeReadText(res);
    throw new DiscordTransientError(
      res.status,
      `Discord ${res.status} (transient) on /channels/${channelId}/messages: ${detail}`,
    );
  }
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new DiscordTransientError(
      res.status,
      `Discord ${res.status} on /channels/${channelId}/messages: ${detail}`,
    );
  }

  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new DiscordTransientError(
      200,
      'Discord /messages response was not an array',
    );
  }

  // Validate each message permissively — if a SINGLE row fails Zod we drop
  // it (do not blow up the entire batch). Discord ships the occasional
  // system message (member join, pin) shaped slightly differently; missing
  // .content is the typical culprit.
  const out: DiscordChannelMessage[] = [];
  for (const raw of json) {
    const parsed = DiscordChannelMessageSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    // No throw on parse failure — handler logs at the call-site if cursor
    // gets stuck, this fail-soft is the right policy for system messages.
  }
  return out;
}

function buildUrl(channelId: string, after: string | null, limit: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (after) params.set('after', after);
  return `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`;
}

function parseRetryAfter(res: Response): number {
  // Discord ships Retry-After as a decimal seconds string AND as a header
  // `X-RateLimit-Reset-After`. Prefer Retry-After per RFC 9111.
  const header = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-after');
  if (!header) return 1_000;
  const seconds = Number.parseFloat(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.ceil(seconds * 1000);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
