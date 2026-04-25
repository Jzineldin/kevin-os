/**
 * @kos/service-emailengine-webhook — CAP-07 (EmailEngine push → KOS).
 *
 * Phase 4 Wave 0 SCAFFOLD: this is a stub. Production handler body
 * (X-EE-Secret constant-time compare, payload parse, EventBridge emit of
 * `capture.received` with `channel='email-inbox'`) lands in Plan 04-03.
 *
 * EmailEngine (running on Fargate) POSTs `messageNew` events to this Lambda's
 * Function URL. The shared secret prevents unauthenticated invocations even
 * though the URL is technically public.
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 4 service emailengine-webhook: handler body not yet implemented — see Plan 04-03',
  );
};
