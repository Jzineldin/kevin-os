/**
 * @kos/service-linkedin-webhook — CAP-05 LinkedIn DM webhook (SCAFFOLD).
 *
 * Receives HTTPS POSTs from the Chrome extension's LinkedIn content script
 * (apps/chrome-extension/src/content-linkedin.ts) — one POST per Voyager
 * conversation event observed in the DOM. Authenticates via Bearer +
 * X-KOS-Signature HMAC, validates against `CaptureReceivedLinkedInDmSchema`,
 * mints a ULID capture_id, and emits `kos.capture / capture.received
 * { kind: linkedin_dm }`.
 *
 * Body arrives in Plan 05-03. Until then this scaffold throws so downstream
 * misroutes fail loud.
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 5 service linkedin-webhook: handler body not yet implemented — see Plan 05-03',
  );
};
