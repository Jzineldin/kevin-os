/**
 * @kos/chrome-extension — LinkedIn DM content script (Plan 05-02 / CAP-05).
 *
 * Scrapes new LinkedIn DMs from `https://www.linkedin.com/messaging/*`
 * using two complementary strategies:
 *
 *   1. **Voyager fetch interceptor** (primary). Patches `window.fetch` so
 *      every call LinkedIn itself makes to `/voyager/api/messaging/...` is
 *      observed. Both the conversations-list endpoint AND each thread-events
 *      endpoint flow through here, so we get fresh JSON envelopes the
 *      moment LinkedIn renders them — no synthetic poll, no extra API
 *      pressure on Kevin's session.
 *
 *   2. **DOM mutation observer** (fallback). Watches the message list pane
 *      for newly-rendered `[data-event-urn]`-bearing elements. Fires when
 *      LinkedIn ships a non-Voyager (e.g. WebSocket-pushed) message, or
 *      when the JSON shape drifts and the interceptor's parser bails.
 *
 * For each new message we:
 *   - sha256(message_urn) → 26-char Crockford → ULID-shaped capture_id
 *     (deterministic, so re-observation is idempotent downstream).
 *   - Build a `CaptureReceivedLinkedInDm` envelope.
 *   - HMAC-sign + Bearer-auth + POST to the linkedin-webhook Lambda.
 *
 * Cookies never leave the browser — we don't read JSESSIONID, we don't
 * forward `set-cookie`. Only the parsed message body + URNs cross the wire.
 *
 * Manifest match: `https://www.linkedin.com/messaging/*`. The script is
 * idempotent on re-injection (single-page-app navigation) — `__KOS_LI_BOOT`
 * gate prevents double-attaching the fetch interceptor.
 */

import { signRequest, formatSignatureHeader } from './_lib/hmac.js';
import { loadConfig, isConfigured } from './_lib/storage.js';
import { deterministicUlidFromString } from './_lib/ulid.js';

const VOYAGER_CONVERSATIONS_RE =
  /\/voyager\/api\/messaging\/conversations(\b|\?|\/)/;
const VOYAGER_EVENTS_RE = /\/voyager\/api\/messaging\/conversations\/[^/]+\/events/;
const POST_RETRY_LIMIT = 2;

interface VoyagerMiniProfile {
  firstName?: string;
  lastName?: string;
  publicIdentifier?: string;
}

interface VoyagerMessageEvent {
  body?: { text?: string } | string;
}

interface VoyagerEventElement {
  entityUrn?: string;
  createdAt?: number;
  from?: {
    messagingMember?: { miniProfile?: VoyagerMiniProfile };
  };
  eventContent?: {
    'com.linkedin.voyager.messaging.event.MessageEvent'?: VoyagerMessageEvent;
  };
}

interface VoyagerConversationElement {
  entityUrn?: string;
  events?: { '*elements'?: string[] };
  messages?: { '*elements'?: string[] };
}

interface VoyagerEnvelope {
  elements?: unknown[];
}

/**
 * Track which message_urns we've already forwarded during this content-script
 * lifetime. Cleared when the tab unloads — chrome.storage.local persists the
 * cross-session high-water mark in `linkedin_seen_urns` so reload doesn't
 * re-flood the webhook.
 */
const seenInMemory = new Set<string>();

/** Convert nullable strings to `'unknown'` so the schema's `name` is non-empty. */
function deriveSenderName(mp: VoyagerMiniProfile | undefined): string {
  if (!mp) return 'unknown';
  const composed = `${mp.firstName ?? ''} ${mp.lastName ?? ''}`.trim();
  return composed.length > 0 ? composed : 'unknown';
}

function deriveBody(eventContent: VoyagerEventElement['eventContent']): string | undefined {
  const m = eventContent?.['com.linkedin.voyager.messaging.event.MessageEvent'];
  if (!m) return undefined;
  if (typeof m.body === 'string') return m.body.length > 0 ? m.body : undefined;
  if (typeof m.body?.text === 'string' && m.body.text.length > 0) return m.body.text;
  return undefined;
}

interface ParsedMessage {
  capture_id: string;
  channel: 'linkedin';
  kind: 'linkedin_dm';
  conversation_urn: string;
  message_urn: string;
  from: { name: string; li_public_id?: string };
  body: string;
  sent_at: string;
  received_at: string;
}

/**
 * Map one Voyager event element into our schema-shaped envelope.
 * Returns null when the element fails any required-field check.
 */
async function buildEnvelope(
  ev: VoyagerEventElement,
  fallbackConversationUrn: string,
): Promise<ParsedMessage | null> {
  const messageUrn = ev.entityUrn;
  if (!messageUrn) return null;
  const body = deriveBody(ev.eventContent);
  if (!body) return null;

  const conversationUrn =
    extractConversationUrn(messageUrn) ?? fallbackConversationUrn;
  if (!conversationUrn) return null;

  const mp = ev.from?.messagingMember?.miniProfile;
  const sentAtMs = typeof ev.createdAt === 'number' ? ev.createdAt : Date.now();
  const captureId = await deterministicUlidFromString(messageUrn);
  return {
    capture_id: captureId,
    channel: 'linkedin',
    kind: 'linkedin_dm',
    conversation_urn: conversationUrn,
    message_urn: messageUrn,
    from: {
      name: deriveSenderName(mp),
      ...(mp?.publicIdentifier ? { li_public_id: mp.publicIdentifier } : {}),
    },
    body,
    sent_at: new Date(sentAtMs).toISOString(),
    received_at: new Date().toISOString(),
  };
}

/**
 * Voyager event URNs look like `urn:li:fs_event:(2-AAA,5-BBB)` — the
 * conversation URN is the first inner segment. Extracting it lets us label
 * messages even when the parent conversations endpoint hasn't been observed.
 */
export function extractConversationUrn(eventUrn: string): string | undefined {
  const m = /^urn:li:fs_event:\(([^,]+),/.exec(eventUrn);
  if (!m) return undefined;
  return `urn:li:fs_conversation:${m[1]}`;
}

async function postToWebhook(envelope: ParsedMessage): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.webhookUrl || !cfg.bearer || !cfg.hmacSecret) {
    return; // unconfigured — silently drop
  }
  const body = JSON.stringify(envelope);
  const signed = await signRequest(body, cfg.hmacSecret);
  const url = `${cfg.webhookUrl.replace(/\/$/, '')}/linkedin`;
  let attempt = 0;
  while (attempt <= POST_RETRY_LIMIT) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.bearer}`,
          'X-KOS-Signature': formatSignatureHeader(signed),
        },
        body,
      });
      if (res.ok) return;
      // 4xx is permanent — don't retry
      if (res.status >= 400 && res.status < 500) {
        console.warn('[KOS-LI] webhook rejected', res.status);
        return;
      }
    } catch (e) {
      console.warn('[KOS-LI] webhook fetch threw', (e as Error).message);
    }
    attempt += 1;
  }
}

/**
 * Process a Voyager events response (array of MessageEvent elements). Each
 * new message_urn is forwarded once per content-script lifetime + once per
 * persistent storage session (whichever rejects first).
 */
export async function processEventElements(
  elements: unknown[],
  fallbackConversationUrn: string,
): Promise<ParsedMessage[]> {
  const persisted = await loadSeenUrns();
  const fresh: ParsedMessage[] = [];
  for (const raw of elements) {
    const ev = raw as VoyagerEventElement;
    const urn = ev.entityUrn;
    if (!urn) continue;
    if (seenInMemory.has(urn)) continue;
    if (persisted.has(urn)) {
      seenInMemory.add(urn);
      continue;
    }
    const envelope = await buildEnvelope(ev, fallbackConversationUrn);
    if (!envelope) {
      seenInMemory.add(urn);
      continue;
    }
    seenInMemory.add(urn);
    persisted.add(urn);
    fresh.push(envelope);
  }
  if (fresh.length > 0) {
    await persistSeenUrns(persisted);
    for (const env of fresh) {
      await postToWebhook(env);
    }
  }
  return fresh;
}

const SEEN_URN_KEY = 'linkedin_seen_urns';
const SEEN_URN_LIMIT = 2000; // keep cross-session memory bounded

async function loadSeenUrns(): Promise<Set<string>> {
  const raw = await chrome.storage.local.get([SEEN_URN_KEY]);
  const arr = raw[SEEN_URN_KEY];
  if (!Array.isArray(arr)) return new Set();
  return new Set(arr.filter((s): s is string => typeof s === 'string'));
}

async function persistSeenUrns(s: Set<string>): Promise<void> {
  // Keep the most-recent N — Set iteration order is insertion order, so we
  // slice from the end (newest entries) when over the limit.
  const arr = Array.from(s);
  const trimmed = arr.length > SEEN_URN_LIMIT ? arr.slice(-SEEN_URN_LIMIT) : arr;
  await chrome.storage.local.set({ [SEEN_URN_KEY]: trimmed });
}

/**
 * Walk a Voyager response that LinkedIn returned. Both the conversations
 * endpoint and the thread-events endpoint share the `{ elements: [...] }`
 * shape; thread-events elements ARE MessageEvents directly, while
 * conversations elements wrap a `messages.*elements` URN list. We only act
 * on shapes carrying body text — the conversations endpoint passes through
 * silently (its response has URN refs only, not message bodies).
 */
export async function ingestVoyagerResponse(
  url: string,
  payload: unknown,
): Promise<ParsedMessage[]> {
  if (!payload || typeof payload !== 'object') return [];
  const env = payload as VoyagerEnvelope;
  if (!Array.isArray(env.elements)) return [];

  if (VOYAGER_EVENTS_RE.test(url)) {
    // Thread events: each element is a MessageEvent w/ body.
    const conversationUrn =
      extractConversationFromEventsUrl(url) ??
      ((env.elements[0] as VoyagerEventElement | undefined)?.entityUrn
        ? extractConversationUrn(
            (env.elements[0] as VoyagerEventElement).entityUrn!,
          ) ?? ''
        : '');
    return processEventElements(env.elements, conversationUrn);
  }

  if (VOYAGER_CONVERSATIONS_RE.test(url)) {
    // Conversations list: doesn't contain bodies, but some envelopes carry
    // an inline `events` block with the latest MessageEvent. Walk + flatten.
    const inline: unknown[] = [];
    for (const raw of env.elements) {
      const conv = raw as VoyagerConversationElement & {
        events?: { elements?: unknown[] };
      };
      if (Array.isArray(conv.events?.elements)) {
        for (const ev of conv.events!.elements!) {
          inline.push(ev);
        }
      }
    }
    if (inline.length === 0) return [];
    return processEventElements(inline, '');
  }

  return [];
}

function extractConversationFromEventsUrl(url: string): string | undefined {
  const m = /\/voyager\/api\/messaging\/conversations\/([^/]+)\/events/.exec(url);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1];
  }
}

/**
 * Patch `window.fetch` so we observe Voyager responses LinkedIn itself
 * triggers. We never modify the response — we clone, parse off the clone,
 * and let LinkedIn's own code see the original Response untouched.
 *
 * Idempotent: a `__KOS_LI_BOOT` symbol on `window` prevents double-attach
 * during single-page-app navigation re-injection.
 */
export function installFetchInterceptor(): void {
  const w = globalThis as unknown as {
    __KOS_LI_BOOT?: boolean;
    fetch: typeof fetch;
  };
  if (w.__KOS_LI_BOOT) return;
  w.__KOS_LI_BOOT = true;
  const original = w.fetch.bind(globalThis);
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input as Parameters<typeof fetch>[0], init);
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        VOYAGER_CONVERSATIONS_RE.test(url) ||
        VOYAGER_EVENTS_RE.test(url)
      ) {
        // Clone before reading — LinkedIn's own consumer needs the body.
        const clone = res.clone();
        // Best-effort JSON parse; fail-silent.
        clone
          .json()
          .then((j: unknown) => {
            void ingestVoyagerResponse(url, j);
          })
          .catch(() => {});
      }
    } catch (e) {
      console.debug('[KOS-LI] interceptor parse failed', (e as Error).message);
    }
    return res;
  };
}

/**
 * MutationObserver fallback: watch the messaging pane for new
 * `[data-event-urn]` nodes. When one appears, scrape the visible text out of
 * the corresponding message bubble and synthesize a minimal envelope. This
 * path runs even if LinkedIn switches to a WebSocket-only delivery and our
 * fetch interceptor never sees the message.
 */
export function installDomObserver(target: Node = document.body): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        scanForMessages(node).catch(() => {
          /* fail-silent */
        });
      }
    }
  });
  observer.observe(target, { childList: true, subtree: true });
  return observer;
}

async function scanForMessages(root: HTMLElement): Promise<void> {
  // LinkedIn renders each message with `data-event-urn="urn:li:fs_event:(...)"`
  // on the outer `<li>` / `<article>` wrapper. The visible body lives inside
  // `.msg-s-event-listitem__body` (subject to CSS-class churn — selector list
  // stays defensive on the most stable attribute, the URN, then degrades).
  const candidates = root.matches?.('[data-event-urn]')
    ? [root]
    : Array.from(root.querySelectorAll('[data-event-urn]'));
  for (const el of candidates) {
    const urn = el.getAttribute('data-event-urn');
    if (!urn) continue;
    if (seenInMemory.has(urn)) continue;
    const bodyEl =
      el.querySelector('.msg-s-event-listitem__body') ??
      el.querySelector('[data-test-message-body]') ??
      el.querySelector('p');
    const body = bodyEl?.textContent?.trim();
    if (!body) continue;
    const senderEl =
      el.querySelector('.msg-s-message-group__profile-link') ??
      el.querySelector('[data-test-app-aware-link]');
    const senderName = senderEl?.textContent?.trim() ?? 'unknown';
    const conversationUrn = extractConversationUrn(urn) ?? '';
    if (!conversationUrn) continue;
    seenInMemory.add(urn);
    const envelope: ParsedMessage = {
      capture_id: await deterministicUlidFromString(urn),
      channel: 'linkedin',
      kind: 'linkedin_dm',
      conversation_urn: conversationUrn,
      message_urn: urn,
      from: { name: senderName },
      body,
      sent_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
    };
    await postToWebhook(envelope);
  }
}

/** Test-only state reset hook. */
export function __resetForTests(): void {
  seenInMemory.clear();
  const w = globalThis as unknown as { __KOS_LI_BOOT?: boolean };
  delete w.__KOS_LI_BOOT;
}

/**
 * Bootstrap. Called immediately at content-script load when the host is
 * `https://www.linkedin.com/messaging/*` (manifest gate). We:
 *   1. Refuse to do anything when the extension is unconfigured.
 *   2. Patch fetch (interceptor primary path).
 *   3. Attach a DOM observer (fallback for non-Voyager deliveries).
 */
async function bootstrap(): Promise<void> {
  if (!(await isConfigured())) {
    console.debug('[KOS-LI] extension not configured; skipping');
    return;
  }
  installFetchInterceptor();
  if (typeof document !== 'undefined' && document.body) {
    installDomObserver(document.body);
  }
  console.debug('[KOS-LI] linkedin content script ready');
}

// Test environments import this module without a real `chrome` runtime —
// the bootstrap call would throw before tests can install the MV3 stub.
// Guard on `chrome.storage` (present only in extension contexts and tests
// that explicitly install the MV3 stub before importing the module).
if (
  typeof chrome !== 'undefined' &&
  typeof chrome.storage !== 'undefined' &&
  typeof window !== 'undefined' &&
  /linkedin\.com\/messaging\//.test(window.location?.href ?? '')
) {
  void bootstrap();
}
