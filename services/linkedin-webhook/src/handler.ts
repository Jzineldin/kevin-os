/**
 * @kos/service-linkedin-webhook — CAP-05 LinkedIn DM webhook (Plan 05-02).
 *
 * Function URL → Bearer + HMAC verify → Zod validate → EventBridge
 * `kos.capture / capture.received { kind: linkedin_dm }`.
 *
 * The Chrome extension's content-linkedin.ts script POSTs one signed
 * envelope per new LinkedIn DM observed in the user's session. Each request
 * carries:
 *
 *   POST /linkedin
 *   Authorization: Bearer <bearer-from-secrets-manager>
 *   X-KOS-Signature: t=<unix-seconds>,v1=<hex sha256(secret, t.body)>
 *   Content-Type: application/json
 *   <body matching CaptureReceivedLinkedInDmSchema>
 *
 * Authentication is **double-gated**: a leaked Bearer alone (e.g. via
 * extension exfil) is insufficient because the HMAC signature also needs
 * the shared secret; a leaked HMAC alone fails because the Bearer check
 * runs first.
 *
 * Idempotency: the extension's `capture_id` is sha256(message_urn) → 26
 * Crockford chars. Re-observation of the same Voyager event during the
 * 30-min poll cycle therefore produces an identical `capture_id`, and
 * downstream triage dedupes naturally on capture_id (Phase 2 pattern).
 *
 * Threat mitigations encoded structurally:
 *   - T-05-02-01 (spoofing): Bearer + HMAC — both must be valid.
 *   - T-05-02-02 (replay): ±300s drift window. No DDB cache: low traffic
 *     volume + deterministic capture_id make a Lambda-side cache redundant.
 *   - T-05-02-03 (info disclosure): error responses never echo body bytes.
 *   - T-05-02-06 (timing attack): `crypto.timingSafeEqual` (hmac.ts).
 *
 * Plan 05-03 will add a `/linkedin/alert` route for system_alerts; this
 * file implements the capture path only.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { CaptureReceivedLinkedInDmSchema } from '@kos/contracts';
import { timingSafeEqual } from 'node:crypto';
import { verifySignature } from './hmac.js';
import { getSecrets } from './secrets.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';
const eb = new EventBridgeClient({ region: 'eu-north-1' });

interface FnUrlEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string; sourceIp?: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface FnUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function reply(statusCode: number, body: Record<string, unknown>): FnUrlResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function readBody(event: FnUrlEvent): string | null {
  if (!event.body) return null;
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
}

function checkBearer(headerValue: string | undefined, expected: string): boolean {
  if (!headerValue) return false;
  const m = /^Bearer (.+)$/.exec(headerValue);
  if (!m) return false;
  const provided = Buffer.from(m[1]!);
  const exp = Buffer.from(expected);
  if (provided.length !== exp.length) return false;
  return timingSafeEqual(provided, exp);
}

export const handler = wrapHandler(
  async (event: FnUrlEvent): Promise<FnUrlResponse> => {
    await initSentry();
    await setupOtelTracingAsync();
    try {
      const method = event.requestContext?.http?.method;
      const path =
        event.requestContext?.http?.path ?? event.rawPath ?? '/';
      if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      if (path !== '/linkedin') return reply(404, { error: 'not_found' });

      const body = readBody(event);
      if (!body) return reply(400, { error: 'empty_body' });

      const { bearer, hmacSecret } = await getSecrets();

      // 1. Bearer (constant-time)
      const auth =
        event.headers?.['authorization'] ?? event.headers?.['Authorization'];
      if (!checkBearer(auth, bearer)) {
        return reply(401, { error: 'unauthorized' });
      }

      // 2. HMAC + replay window
      const sigHeader =
        event.headers?.['x-kos-signature'] ??
        event.headers?.['X-KOS-Signature'];
      const nowSec = Math.floor(Date.now() / 1000);
      const v = verifySignature(hmacSecret, sigHeader, body, nowSec);
      if (!v.ok) {
        if (v.reason === 'missing' || v.reason === 'malformed') {
          return reply(400, { error: v.reason });
        }
        return reply(401, { error: 'unauthorized' });
      }

      // 3. Zod parse — the extension supplies `received_at`, but we overwrite
      //    with the Lambda's clock so the audit trail uses server time.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      const withServerClock = {
        ...(parsed as object),
        received_at: new Date().toISOString(),
      };
      const z = CaptureReceivedLinkedInDmSchema.safeParse(withServerClock);
      if (!z.success) {
        return reply(400, { error: 'schema', issues: z.error.issues });
      }
      const detail = z.data;
      tagTraceWithCaptureId(detail.capture_id);

      // 4. PutEvents
      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.capture',
              Source: 'kos.capture',
              DetailType: 'capture.received',
              Detail: JSON.stringify(detail),
            },
          ],
        }),
      );
      return reply(200, {
        capture_id: detail.capture_id,
        status: 'accepted',
      });
    } finally {
      await langfuseFlush();
    }
  },
);
