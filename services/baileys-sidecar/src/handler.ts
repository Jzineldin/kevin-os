/**
 * @kos/service-baileys-sidecar — CAP-06 WhatsApp ingress sidecar (SCAFFOLD).
 *
 * Lambda Function URL invoked by the Baileys Fargate container
 * (`services/baileys-fargate`) for every incoming WhatsApp message it
 * observes via WebSocket. Authenticates with X-BAILEYS-Secret (constant-time
 * compare against a Secrets-Manager-stored shared secret), validates against
 * `CaptureReceivedWhatsappTextSchema` / `CaptureReceivedWhatsappVoiceSchema`,
 * uploads voice notes to S3 (eu-north-1), mints a ULID capture_id, and
 * emits `kos.capture / capture.received { kind: whatsapp_text|whatsapp_voice }`.
 *
 * Body arrives in Plan 05-05. Plan 05-04 covers the Fargate container that
 * calls this Lambda. Until then this scaffold throws so downstream
 * misroutes fail loud.
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 5 service baileys-sidecar: handler body not yet implemented — see Plan 05-05',
  );
};
