/**
 * Phase 5 / Plan 05-01 — highlight content script.
 *
 * For the highlight capture path, MV3's `contextMenus` API with
 * `contexts: ['selection']` already gives the service worker direct access
 * to `info.selectionText` — there is no need for the content script to
 * forward selection bytes back via `chrome.runtime.sendMessage`. We keep
 * this file as a minimal cross-page sentinel so:
 *
 *   1. The manifest's `content_scripts[0]` entry resolves to a real bundle
 *      (esbuild fails the build if the entrypoint is missing).
 *   2. Plan 05-03's LinkedIn DOM scraper inherits the same multi-script
 *      content_scripts shape without re-declaring the manifest.
 *   3. A single console.debug at injection proves the content_script
 *      matches rule (`<all_urls>`) is wired correctly during operator M1.
 *
 * No DOM mutations. No observers. No auto-fire. The user must explicitly
 * right-click → "Send to KOS" before the background service worker does
 * anything (T-05-01-04 mitigation).
 */

// eslint-disable-next-line no-console
console.debug('[KOS] content-highlight.ts loaded on', location.hostname);

export {};
