/**
 * @kos/chrome-extension — background service worker (SCAFFOLD).
 *
 * MV3 service worker. Plan 05-01 wires:
 *   - context-menu entry "Send to KOS" (chrome.contextMenus)
 *   - chrome.runtime.onMessage handlers for content-highlight + content-linkedin
 *   - chrome.alarms-driven retry queue (chrome.storage.local)
 *   - HMAC signing (Bearer + X-KOS-Signature) before fetch() to chrome-webhook /
 *     linkedin-webhook Lambda Function URLs.
 *
 * Service workers terminate when idle — every event handler MUST re-read state
 * from chrome.storage.local rather than relying on in-memory globals (per
 * Chrome MV3 migration guide). The throw below blocks accidental unpacked
 * loads of the scaffold build.
 */

throw new Error('SCAFFOLD — implemented in Plan 05-01');
