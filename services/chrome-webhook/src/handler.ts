/**
 * @kos/service-chrome-webhook — CAP-04 Chrome highlight webhook (SCAFFOLD).
 *
 * Receives HTTPS POSTs from the Chrome extension (apps/chrome-extension)
 * carrying a user-selected highlight from any web page (right-click ->
 * "Send to KOS"). Authenticates via Bearer + X-KOS-Signature HMAC, validates
 * the body against `CaptureReceivedChromeHighlightSchema`, mints a ULID
 * capture_id, and emits `kos.capture / capture.received { kind:
 * chrome_highlight }` to EventBridge.
 *
 * Body arrives in Plan 05-02. Until then this scaffold throws so downstream
 * misroutes fail loud.
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 5 service chrome-webhook: handler body not yet implemented — see Plan 05-02',
  );
};
