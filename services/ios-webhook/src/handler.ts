/**
 * @kos/service-ios-webhook — CAP-02 (iOS Shortcut voice capture ingress).
 *
 * Phase 4 Wave 0 SCAFFOLD: this is a stub. Production handler body
 * (HMAC verification, replay-cache lookup, S3 upload, EventBridge emit
 * of `capture.received` with `channel='ios-shortcut'`) lands in Plan 04-01.
 *
 * The stub deliberately throws on invocation so a misconfigured Function URL
 * cannot accidentally accept traffic before Plan 04-01 ships (T-04-SCAFFOLD-05).
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 4 service ios-webhook: handler body not yet implemented — see Plan 04-01',
  );
};
