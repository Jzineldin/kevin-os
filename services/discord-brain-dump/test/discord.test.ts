/**
 * Discord REST wrapper unit tests (Plan 10-04 Task 1).
 *
 * Coverage:
 *   1. Empty channel → fetchNewMessages returns []
 *   2. Cursor=null + N messages → returns all N (oldest-first)
 *   3. Cursor=<id> + 3 newer → returns only the 3 newer
 *   4. Bot messages filtered out by default
 *   5. INCLUDE_BOTS opt-in lets bot messages through
 *   6. 401 → DiscordAuthError
 *   7. 403 → DiscordAuthError
 *   8. 404 → DiscordAuthError (channel deleted / bot kicked)
 *   9. 429 once → honors Retry-After + retries; second 429 → DiscordRateLimitError
 *  10. 500 → DiscordTransientError
 *  11. Pagination: first page = limit messages → walks to second page using
 *      newest-id-of-prev-page as `?after=`
 *  12. Pagination safety cap (maxPages) — stops walking after the cap
 *  13. Each returned message Zod-validates against DiscordChannelMessageSchema
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchNewMessages,
  DiscordAuthError,
  DiscordRateLimitError,
  DiscordTransientError,
} from '../src/discord.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMessage(id: string, opts: Partial<{ content: string; bot: boolean; channel_id: string; ts: string }> = {}) {
  return {
    id,
    channel_id: opts.channel_id ?? '9876543210987654321',
    type: 0,
    author: {
      id: '5555555555555555555',
      username: 'kevin.elzarka',
      discriminator: '0',
      bot: opts.bot ?? false,
    },
    content: opts.content ?? `msg-${id}`,
    timestamp: opts.ts ?? '2026-04-25T08:42:13.000+00:00',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 0,
  };
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function rateLimitResponse(retryAfterSec: number): Response {
  return new Response('{"message":"You are being rate limited.","retry_after":' + retryAfterSec + '}', {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfterSec),
      'x-ratelimit-reset-after': String(retryAfterSec),
    },
  });
}

const CHANNEL = '9876543210987654321';
const TOKEN = 'BOT_TOKEN_TEST';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discord-brain-dump / fetchNewMessages', () => {
  it('returns [] for an empty channel', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse([]));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl });
    expect(got).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/channels/${CHANNEL}/messages`);
    expect(calls[0]!.url).toContain('limit=50');
    expect(calls[0]!.url).not.toContain('after=');
    // Authorization header set with `Bot <token>`.
    const auth = (calls[0]!.init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Bot ${TOKEN}`);
  });

  it('returns all messages when cursor is null (oldest-first)', async () => {
    // Discord returns newest-first; the wrapper sorts ascending.
    const page = [fakeMessage('300'), fakeMessage('200'), fakeMessage('100')];
    const { impl } = makeFetch(() => jsonResponse(page));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl, limit: 50 });
    expect(got.map((m) => m.id)).toEqual(['100', '200', '300']);
  });

  it('passes the cursor as ?after= when present', async () => {
    const page = [fakeMessage('400'), fakeMessage('500')];
    const { impl, calls } = makeFetch(() => jsonResponse(page));
    await fetchNewMessages(CHANNEL, '300', TOKEN, { fetchImpl: impl, limit: 50 });
    expect(calls[0]!.url).toContain('after=300');
  });

  it('filters out bot-authored messages by default', async () => {
    const page = [
      fakeMessage('1', { bot: true, content: 'bot post' }),
      fakeMessage('2', { bot: false, content: 'kevin' }),
      fakeMessage('3', { bot: true, content: 'another bot' }),
    ];
    const { impl } = makeFetch(() => jsonResponse(page));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl });
    expect(got.map((m) => m.content)).toEqual(['kevin']);
  });

  it('includes bot messages when includeBots=true', async () => {
    const page = [
      fakeMessage('1', { bot: true, content: 'bot post' }),
      fakeMessage('2', { bot: false, content: 'kevin' }),
    ];
    const { impl } = makeFetch(() => jsonResponse(page));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, {
      fetchImpl: impl,
      includeBots: true,
    });
    expect(got.map((m) => m.content)).toEqual(['bot post', 'kevin']);
  });

  it('throws DiscordAuthError on 401', async () => {
    const { impl } = makeFetch(() => new Response('Unauthorized', { status: 401 }));
    await expect(
      fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(DiscordAuthError);
  });

  it('throws DiscordAuthError on 403', async () => {
    const { impl } = makeFetch(() => new Response('Forbidden', { status: 403 }));
    await expect(
      fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(DiscordAuthError);
  });

  it('throws DiscordAuthError on 404 (channel archived / bot kicked)', async () => {
    const { impl } = makeFetch(() => new Response('Not Found', { status: 404 }));
    await expect(
      fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(DiscordAuthError);
  });

  it('honors Retry-After on 429 and retries once successfully', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const { impl, calls } = makeFetch(() => {
      n++;
      if (n === 1) return rateLimitResponse(0.05);
      return jsonResponse([fakeMessage('100')]);
    });
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl, sleep });
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe('100');
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Retry-After 0.05 sec → 50 ms (rounded up).
    expect(sleeps[0]).toBe(50);
  });

  it('throws DiscordRateLimitError on two consecutive 429s', async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = makeFetch(() => rateLimitResponse(0.1));
    await expect(
      fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl, sleep }),
    ).rejects.toBeInstanceOf(DiscordRateLimitError);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws DiscordTransientError on 500', async () => {
    const { impl } = makeFetch(() => new Response('boom', { status: 500 }));
    await expect(
      fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(DiscordTransientError);
  });

  it('paginates: 50-msg first page → walks to second page with ?after=newest_of_prev', async () => {
    let call = 0;
    const firstPage = Array.from({ length: 50 }, (_, i) => fakeMessage(String(1000 + i)));
    const secondPage = [fakeMessage('1100'), fakeMessage('1101')];
    const { impl, calls } = makeFetch(() => {
      call++;
      if (call === 1) return jsonResponse(firstPage);
      return jsonResponse(secondPage);
    });
    const got = await fetchNewMessages(CHANNEL, '500', TOKEN, {
      fetchImpl: impl,
      limit: 50,
    });
    expect(got).toHaveLength(52);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('after=500');
    // Second-page ?after= = newest id of first page = '1049' (after sort asc).
    expect(calls[1]!.url).toContain('after=1049');
  });

  it('respects maxPages safety cap', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => fakeMessage(String(2000 + i)));
    const { impl, calls } = makeFetch(() => jsonResponse(fullPage));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, {
      fetchImpl: impl,
      limit: 50,
      maxPages: 2,
    });
    expect(calls).toHaveLength(2);
    expect(got).toHaveLength(100);
  });

  it('drops messages that fail Zod validation (e.g. system messages without content)', async () => {
    const goodFixture = fakeMessage('100');
    const malformedSystem = { ...fakeMessage('200'), content: undefined }; // missing content
    const { impl } = makeFetch(() => jsonResponse([goodFixture, malformedSystem]));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl });
    expect(got.map((m) => m.id)).toEqual(['100']);
  });

  it('returned messages have Zod-validated shape (channel_id + author + timestamp)', async () => {
    const page = [fakeMessage('100', { content: 'brain-dump: Almi loan callback Tuesday' })];
    const { impl } = makeFetch(() => jsonResponse(page));
    const got = await fetchNewMessages(CHANNEL, null, TOKEN, { fetchImpl: impl });
    expect(got).toHaveLength(1);
    const m = got[0]!;
    expect(m.id).toBe('100');
    expect(m.channel_id).toBe(CHANNEL);
    expect(m.author.id).toBeDefined();
    expect(m.author.username).toBeDefined();
    expect(m.content).toContain('Almi');
    expect(m.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
