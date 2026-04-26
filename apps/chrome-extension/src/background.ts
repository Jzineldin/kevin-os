/**
 * Phase 5 / Plan 05-01 — MV3 service worker for the KOS Chrome extension.
 *
 * Wires the "Send to KOS" right-click context menu:
 *   1. onInstalled: register the menu (selection-context only).
 *   2. onClicked  : pull selectionText + tab metadata, sign the body via
 *      lib/hmac.signRequest, POST to <webhookUrl>/highlight with
 *      Authorization: Bearer + X-KOS-Signature.
 *
 * Service workers terminate when idle — every event handler MUST re-read
 * config from chrome.storage.local rather than relying on in-memory globals
 * (Chrome MV3 migration guide). We do exactly that via `loadConfig()`.
 *
 * The throw in the scaffold is replaced with real wiring; loading the dist
 * unpacked is now expected to succeed silently (M1).
 *
 * Threat mitigations:
 *  - T-05-01-01 (Spoofing): chrome.contextMenus.onClicked is only invoked
 *    by Chrome itself; webpages cannot fire it. We do NOT add a
 *    chrome.runtime.onMessage listener in this plan.
 *  - T-05-01-02 (Tampering): chrome.storage.local is not exposed to the
 *    page world; only this service worker + the options page can write.
 */
import { signRequest, formatSignatureHeader } from './lib/hmac.js';
import { loadConfig, isConfigured } from './lib/storage.js';

// Crockford base32 alphabet — used to mint a 26-char ULID without pulling in
// the `ulid` npm package (which assumes Node `crypto` shape).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Mint a 26-char ULID-shaped capture_id directly in the service worker.
 *
 * Real ULIDs are 48 bits of millisecond timestamp + 80 bits of randomness,
 * encoded as 26 Crockford-base32 characters. This implementation:
 *   - encodes Date.now() (milliseconds) as the first 10 chars (50 bits;
 *     ULID actually uses 48, but 50 is forward-compat through year 10889).
 *   - fills the trailing 16 chars with Web Crypto random bytes mapped onto
 *     the Crockford alphabet (5 bits per char × 16 = 80 bits as required).
 *
 * The output matches the regex `^[0-9A-HJKMNP-TV-Z]{26}$` consumed by
 * `CaptureReceivedChromeHighlightSchema.capture_id` (UlidRegex). The
 * server-side handler regenerates its own ULID via the `ulid` npm package
 * — this client-minted id is overwritten on the wire so a misbehaving
 * client can't choose its own capture_id.
 */
function generateUlid(): string {
  let ts = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[ts % 32]! + timePart;
    ts = Math.floor(ts / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += CROCKFORD[rand[i]! % 32];
  }
  return (timePart + randPart).slice(0, 26);
}

// --- Context menu registration ---------------------------------------------
// chrome.contextMenus.create is fire-and-forget; calling it twice produces a
// "Cannot create item with duplicate id" error reported via lastError. The
// onInstalled lifecycle event fires once per install/update, so the create
// is idempotent across the extension's lifetime.
//
// The optional-chained `?.addListener` calls keep the file safe to import
// under the @kos/test-fixtures MV3 stub, which exposes `runtime.onMessage`
// but not the full `onInstalled` shape. In a real browser both are always
// present, so the optional chain is a no-op at runtime.
chrome.runtime.onInstalled?.addListener(() => {
  chrome.contextMenus.create({
    id: 'kos-send-to-kos',
    title: 'Send to KOS',
    contexts: ['selection'],
  });
});

// --- Context menu click handler --------------------------------------------
chrome.contextMenus.onClicked?.addListener((info, tab) => {
  // Wrap the async work so we don't return a Promise from the listener
  // (chrome.contextMenus.onClicked listeners are fire-and-forget).
  void handleContextMenuClick(info, tab);
});

/**
 * Async handler split out from the listener so the listener itself stays
 * synchronous (Chrome ignores Promise returns from contextMenus.onClicked).
 *
 * Exported for the unit test in `test/highlight.test.ts` to invoke directly
 * without driving a real chrome.contextMenus.onClicked event.
 */
export async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (info.menuItemId !== 'kos-send-to-kos') return;

  // Empty / undefined selection → silent no-op (T-05-01-04 — accidental
  // clicks are absorbed; nothing reaches the webhook).
  const text = info.selectionText;
  if (!text || text.length === 0) return;

  // Tab url is required by CaptureReceivedChromeHighlightSchema
  // (`source_url: z.string().url()`). Chrome:// or browser-internal pages
  // expose tab.url=undefined to MV3 extensions without `tabs` permission.
  // We deliberately do NOT request `tabs` permission; in those cases the
  // capture is dropped silently.
  const sourceUrl = tab?.url;
  if (!sourceUrl) return;

  if (!(await isConfigured())) {
    // eslint-disable-next-line no-console
    console.warn('[KOS] Send to KOS: extension not configured — open Options');
    return;
  }
  const cfg = await loadConfig();
  // Type narrowing — isConfigured() guarantees all three are present.
  const webhookUrl = cfg.webhookUrl!;
  const bearer = cfg.bearer!;
  const hmacSecret = cfg.hmacSecret!;

  const captureId = generateUlid();
  const selectedAt = new Date().toISOString();
  const body = JSON.stringify({
    capture_id: captureId,
    channel: 'chrome' as const,
    kind: 'chrome_highlight' as const,
    text,
    source_url: sourceUrl,
    source_title: tab?.title ?? undefined,
    selected_at: selectedAt,
  });

  const signed = await signRequest(body, hmacSecret);
  try {
    const r = await fetch(`${webhookUrl.replace(/\/$/, '')}/highlight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'X-KOS-Signature': formatSignatureHeader(signed),
      },
      body,
    });
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn('[KOS] webhook POST failed', r.status);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[KOS] fetch threw', (e as Error).message);
  }
}
