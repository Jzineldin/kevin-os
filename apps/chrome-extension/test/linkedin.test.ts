/**
 * Plan 05-02 — content-linkedin.ts unit tests.
 *
 * Drives the Voyager-response ingestor + DOM observer through controlled
 * fixtures and asserts:
 *   - new message_urns trigger one POST to {webhookUrl}/linkedin
 *   - duplicate message_urns within the same content-script lifetime are
 *     suppressed (in-memory dedupe)
 *   - URNs persisted to chrome.storage.local survive a module reload
 *   - capture_id is deterministic for a given message_urn (same input →
 *     same id)
 *   - the POST carries the right Bearer + X-KOS-Signature headers
 *   - the parsed body satisfies CaptureReceivedLinkedInDmSchema
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installMV3Stub,
  uninstallMV3Stub,
  voyagerThreadEventsResponse,
} from '@kos/test-fixtures';
import { CaptureReceivedLinkedInDmSchema } from '@kos/contracts';

const FETCH_CALLS: Array<{ url: string; init?: RequestInit }> = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

function installFetchSpy(): void {
  FETCH_CALLS.length = 0;
  fetchImpl = async (_url: string, _init?: RequestInit) => {
    return new Response('{"ok":true}', { status: 200 });
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    FETCH_CALLS.push({ url, init });
    return fetchImpl(url, init);
  }) as typeof fetch;
}

beforeEach(async () => {
  installMV3Stub();
  installFetchSpy();
  // Seed config
  await chrome.storage.local.set({
    webhookUrl: 'https://webhook.example.com',
    bearer: 'test-bearer-token',
    hmacSecret: 'test-hmac-secret',
  });
  vi.resetModules();
  // SubtleCrypto is provided by jsdom 21+ via Node's WebCrypto. Verify it's
  // present — if not, the suite is misconfigured.
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'globalThis.crypto.subtle missing — content-linkedin tests need WebCrypto',
    );
  }
});

afterEach(() => {
  uninstallMV3Stub();
  vi.restoreAllMocks();
});

describe('content-linkedin: ingestVoyagerResponse', () => {
  it('forwards each new MessageEvent to the linkedin-webhook', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events?count=20';
    const fresh = await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    expect(fresh).toHaveLength(1);
    expect(FETCH_CALLS).toHaveLength(1);
    const call = FETCH_CALLS[0]!;
    expect(call.url).toBe('https://webhook.example.com/linkedin');
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-bearer-token');
    expect(headers['X-KOS-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('outgoing body satisfies CaptureReceivedLinkedInDmSchema', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events';
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    expect(FETCH_CALLS).toHaveLength(1);
    const sentBody = JSON.parse(FETCH_CALLS[0]!.init!.body as string);
    const parsed = CaptureReceivedLinkedInDmSchema.safeParse(sentBody);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kind).toBe('linkedin_dm');
    expect(parsed.data.channel).toBe('linkedin');
    expect(parsed.data.body).toBe(
      'Yo Kevin, saw your deck — can we jump on a call?',
    );
    expect(parsed.data.from.name).toBe('Damien Hateley');
    expect(parsed.data.from.li_public_id).toBe('damien-hateley');
    // capture_id is 26 Crockford-base32 chars
    expect(parsed.data.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // conversation_urn was extracted either from the URL or from the URN
    expect(parsed.data.conversation_urn).toMatch(/^urn:li:fs_conversation:/);
  });

  it('capture_id is deterministic per message_urn', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events';
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    const id1 = JSON.parse(FETCH_CALLS[0]!.init!.body as string).capture_id;
    // Reset in-memory dedupe + storage so a fresh ingest emits again
    mod.__resetForTests();
    await chrome.storage.local.set({ linkedin_seen_urns: [] });
    FETCH_CALLS.length = 0;
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    const id2 = JSON.parse(FETCH_CALLS[0]!.init!.body as string).capture_id;
    expect(id1).toBe(id2);
  });

  it('in-memory dedupe suppresses duplicate POSTs in one lifetime', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events';
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    expect(FETCH_CALLS).toHaveLength(1);
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    // Same URN — no second POST.
    expect(FETCH_CALLS).toHaveLength(1);
  });

  it('cross-session dedupe: persisted seen URNs block a fresh module load', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events';
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    expect(FETCH_CALLS).toHaveLength(1);
    // Drop in-memory state; storage retains the URN.
    mod.__resetForTests();
    FETCH_CALLS.length = 0;
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    expect(FETCH_CALLS).toHaveLength(0);
  });

  it('non-Voyager URLs are ignored', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const fresh = await mod.ingestVoyagerResponse(
      'https://www.linkedin.com/feed/',
      voyagerThreadEventsResponse,
    );
    expect(fresh).toHaveLength(0);
    expect(FETCH_CALLS).toHaveLength(0);
  });

  it('elements without a body are skipped', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events';
    const empty = {
      elements: [
        {
          entityUrn: 'urn:li:fs_event:(2-XX,5-YY)',
          createdAt: 1714000000000,
          from: {},
          eventContent: {
            // no MessageEvent at all
          },
        },
      ],
    };
    const fresh = await mod.ingestVoyagerResponse(url, empty);
    expect(fresh).toHaveLength(0);
    expect(FETCH_CALLS).toHaveLength(0);
  });

  it('skips POST when extension is unconfigured', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    await chrome.storage.local.set({
      webhookUrl: undefined,
      bearer: undefined,
      hmacSecret: undefined,
    });
    const url =
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events';
    await mod.ingestVoyagerResponse(url, voyagerThreadEventsResponse);
    expect(FETCH_CALLS).toHaveLength(0);
  });

  it('extractConversationUrn unpacks the inner conversation segment', async () => {
    const mod = await import('../src/content-linkedin.js');
    expect(
      mod.extractConversationUrn('urn:li:fs_event:(2-AAAA,5-BBBB)'),
    ).toBe('urn:li:fs_conversation:2-AAAA');
    expect(mod.extractConversationUrn('urn:li:not_an_event')).toBeUndefined();
  });
});

describe('content-linkedin: fetch interceptor', () => {
  it('installFetchInterceptor patches global fetch idempotently', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    const beforeFetch = globalThis.fetch;
    mod.installFetchInterceptor();
    expect(globalThis.fetch).not.toBe(beforeFetch);
    // Second call must NOT re-wrap.
    const afterFirst = globalThis.fetch;
    mod.installFetchInterceptor();
    expect(globalThis.fetch).toBe(afterFirst);
  });

  it('intercepted Voyager response triggers a forward', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    // Replace the underlying fetch with one that returns the Voyager body
    // when the URL matches /voyager/api/messaging/.
    fetchImpl = async (url: string) => {
      if (/\/voyager\/api\/messaging\/conversations\/[^/]+\/events/.test(url)) {
        return new Response(JSON.stringify(voyagerThreadEventsResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };
    mod.installFetchInterceptor();
    // Drive a Voyager fetch as the LinkedIn page would.
    await fetch(
      'https://www.linkedin.com/voyager/api/messaging/conversations/urn%3Ali%3Afs_conversation%3A2-AAAAAAAA/events?count=20',
    );
    // Flush microtasks (the interceptor reads the cloned body off-thread).
    await new Promise((r) => setTimeout(r, 10));
    const webhookCalls = FETCH_CALLS.filter(
      (c) => c.url === 'https://webhook.example.com/linkedin',
    );
    expect(webhookCalls).toHaveLength(1);
  });
});

describe('content-linkedin: DOM observer fallback', () => {
  it('detects newly-added [data-event-urn] nodes and forwards them', async () => {
    const mod = await import('../src/content-linkedin.js');
    mod.__resetForTests();
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root')!;
    const observer = mod.installDomObserver(root);
    // Append a synthetic LinkedIn message bubble.
    const li = document.createElement('li');
    li.setAttribute('data-event-urn', 'urn:li:fs_event:(2-CCCC,5-DDDD)');
    const bodyEl = document.createElement('p');
    bodyEl.className = 'msg-s-event-listitem__body';
    bodyEl.textContent = 'New DOM-observed message';
    li.appendChild(bodyEl);
    root.appendChild(li);
    // MutationObserver microtasks run on the next macrotask boundary in jsdom.
    // 100ms gives crypto.subtle.digest time to resolve before we assert.
    await new Promise((r) => setTimeout(r, 100));
    observer.disconnect();
    const webhookCalls = FETCH_CALLS.filter(
      (c) => c.url === 'https://webhook.example.com/linkedin',
    );
    expect(webhookCalls.length).toBeGreaterThanOrEqual(1);
    const sentBody = JSON.parse(webhookCalls[0]!.init!.body as string);
    expect(sentBody.body).toBe('New DOM-observed message');
    expect(sentBody.message_urn).toBe('urn:li:fs_event:(2-CCCC,5-DDDD)');
  });
});
