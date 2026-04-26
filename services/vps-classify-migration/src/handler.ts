/**
 * @kos/service-vps-classify-migration — MIG-01 VPS classify_and_save adapter.
 *
 * Wave 0 SCAFFOLD ONLY. Plan 10-00 lays the workspace + types + tests so
 * Plan 10-01 can drop the actual handler body in without re-deriving the
 * shape of:
 *
 *   - the inbound Function URL request (HMAC-signed POST from the VPS
 *     `classify_and_save.py` script during the cutover window),
 *   - the Zod parse against `ClassifyPayloadSchema` (passthrough — VPS-side
 *     `classify_and_save.py` accepts arbitrary fields),
 *   - the EventBridge `kos.capture / capture.received` emit with marker
 *     `[MIGRERAD]` retained on the `title` and `source =
 *     vps-classify-migration-adapter`.
 *
 * Function URL auth = `NONE`; the HMAC pair (Authorization Bearer + X-KOS-
 * Signature) IS the auth boundary, identical to `services/chrome-webhook`.
 *
 * The Wave 1 handler body MUST:
 *   1. constant-time compare Bearer header vs `HMAC_SECRET_ARN` secret,
 *   2. constant-time compare HMAC over `${ts}.${body}` (5-min drift window),
 *   3. ZOD-parse body against `ClassifyPayloadSchema` (passthrough),
 *   4. mint server-side `capture_id = ulid()` and `emitted_at = now()`,
 *   5. emit one `capture.received` to `kos.capture` with
 *      `source = 'vps-classify-migration-adapter'`,
 *   6. return `{ capture_id, emitted_at, source }` on success.
 *
 * Threat mitigations (Wave 1 will re-state in code):
 *   T-10-01-01 (Spoofing): HMAC pair gates the Lambda. Bearer alone is not
 *     sufficient — VPS-side script signs `${ts}.${body}` so a captured
 *     Bearer + replayed older body still fails.
 *   T-10-01-02 (Replay): ts drift > 5 min → 401.
 *   T-10-01-03 (Timing): `timingSafeEqual` on every compare.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ClassifyPayload, ClassifyAdapterResult } from './types.js';

/**
 * Wave-0 scaffold guard. Wave 1 (Plan 10-01) replaces the body; calling the
 * scaffolded handler from a test or stray invocation throws so an
 * accidentally-deployed scaffold cannot silently swallow VPS traffic.
 */
class NotImplementedYet extends Error {
  constructor(what: string) {
    super(`vps-classify-migration: ${what} not implemented (Wave 0 scaffold)`);
    this.name = 'NotImplementedYet';
  }
}

/**
 * Lambda Function URL handler. Wave 0 throws — Wave 1 fills behavior.
 *
 * The signature stays stable across waves so the CDK Function URL wiring in
 * `integrations-migration.ts` does not need to change between Wave 0 and
 * Wave 1.
 */
export async function handler(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  throw new NotImplementedYet('handler');
}

// Re-export the contract types the Wave 1 body will reference.
export type { ClassifyPayload, ClassifyAdapterResult };
