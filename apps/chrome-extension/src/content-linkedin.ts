/**
 * @kos/chrome-extension — LinkedIn DM content script (SCAFFOLD).
 *
 * Plan 05-03 wires:
 *   - polling fetch() against the LinkedIn Voyager `conversations` + thread
 *     events endpoints (cookie-auth piggybacks on Kevin's logged-in session)
 *   - parse Voyager URN envelopes → CaptureReceivedLinkedInDmSchema shape
 *   - chrome.runtime.sendMessage → background → linkedin-webhook Lambda
 *   - 24h backoff if any request 401s (auth_fail surfaces as system_alerts)
 *
 * No DOM scraping — Voyager JSON is the contract surface.
 */
export {};
