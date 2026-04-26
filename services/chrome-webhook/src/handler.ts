/**
 * @kos/service-chrome-webhook — CAP-04 Chrome highlight webhook (Plan 05-01).
 *
 * Lambda Function URL → Bearer + HMAC verify → Zod-parse body → mint ULID →
 * EventBridge `kos.capture / capture.received { kind: chrome_highlight,
 * channel: chrome }`.
 *
 * Function URL auth is `NONE` per D-02 — the Bearer + HMAC pair IS the auth
 * boundary. Both are verified in constant time (`timingSafeEqual`); the
 * handler fails closed on any of:
 *   - missing / mismatched Bearer
 *   - missing / malformed / drifted / mismatched HMAC
 *   - empty body
 *   - body that fails CaptureReceivedChromeHighlightSchema
 *
 * The server-side capture_id is minted server-side via the `ulid` package;
 * the client may include its own `capture_id` in the body but we IGNORE it
 * — preventing a misbehaving client from choosing collision-prone ids.
 *
 * Threat mitigations:
 *  - T-05-01-01 (Spoofing): Bearer + HMAC. Bearer alone insufficient (cheap
 *    to grab from chrome.storage.local on a compromised laptop); HMAC binds
 *    timestamp + body so signed-replay-with-different-content is rejected.
 *  - T-05-01-05 (DoS): no per-IP throttle in this handler — Lambda
 *    concurrency caps + AWS account-level reserved concurrency are the
 *    relevant brakes; Plan 05-01 accepts this risk for v1.
 *  - T-05-01-06 (timing): timingSafeEqual on every compare.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ulid } from 'ulid';
import { CaptureReceivedChromeHighlightSchema } from '@kos/contracts';
import { verifyBearer, verifySignature } from './hmac.js';
import { getBearer, getHmacSecret } from './secrets.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';
const eb = new EventBridgeClient({ region: 'eu-north-1' });

/** Cap inbound text at 50 KB — same as the schema's `text.max(50_000)`. */
const MAX_TEXT_BYTES = 50_000;

/** Lambda Function URL event shape (subset we use). */
interface FnUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; sourceIp?: string } };
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

/** Read a header case-insensitively from the Function URL event. */
function header(event: FnUrlEvent, name: string): string | undefined {
  if (!event.headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export const handler = wrapHandler(
  async (event: FnUrlEvent): Promise<FnUrlResponse> => {
    await initSentry();
    await setupOtelTracingAsync();

    try {
      const method = event.requestContext?.http?.method;
      if (method !== 'POST') {
        return reply(405, { error: 'method_not_allowed' });
      }

      // Extension is allowed to POST to ANY path under the Function URL —
      // the plan's call site appends `/highlight`. We accept any path as a
      // valid highlight ingress; future LinkedIn/WhatsApp paths land on
      // separate Lambdas (Plans 05-02 / 05-03).

      if (!event.body || event.body.length === 0) {
        return reply(400, { error: 'empty_body' });
      }

      const bodyRaw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;

      // --- Bearer check -----------------------------------------------------
      const bearer = await getBearer();
      const auth = header(event, 'authorization');
      if (!verifyBearer(bearer, auth)) {
        // Vague "unauthorized" so attackers can't distinguish "no Bearer"
        // from "bad Bearer" via the response.
        return reply(401, { error: 'unauthorized' });
      }

      // --- HMAC check -------------------------------------------------------
      const sigHeader = header(event, 'x-kos-signature');
      const hmacSecret = await getHmacSecret();
      const nowSec = Math.floor(Date.now() / 1000);
      const v = verifySignature(hmacSecret, sigHeader, bodyRaw, nowSec);
      if (!v.ok) {
        if (v.reason === 'missing' || v.reason === 'malformed') {
          return reply(400, { error: v.reason });
        }
        return reply(401, { error: 'unauthorized' });
      }

      // --- Body parse -------------------------------------------------------
      // Mint server-side capture_id BEFORE schema parse so the Zod check
      // doesn't fail on a missing/invalid client capture_id. The schema
      // requires a capture_id field, so we inject ours.
      let parsedJson: Record<string, unknown>;
      try {
        parsedJson = JSON.parse(bodyRaw) as Record<string, unknown>;
      } catch {
        return reply(400, { error: 'invalid_json' });
      }

      // Defence-in-depth: bound text BEFORE schema parse so a 5 MB body
      // doesn't churn through Zod's UTF-8 validation just to be rejected
      // by `text.max(50_000)`.
      const presentedText = parsedJson['text'];
      if (typeof presentedText === 'string' && presentedText.length > MAX_TEXT_BYTES) {
        return reply(413, { error: 'text_too_large' });
      }

      const captureId = ulid();
      const receivedAt = new Date().toISOString();

      const detailCandidate = {
        ...parsedJson,
        // Server-controlled fields override anything the client sent —
        // capture_id, channel, kind, received_at are NOT client-trusted.
        capture_id: captureId,
        channel: 'chrome' as const,
        kind: 'chrome_highlight' as const,
        received_at: receivedAt,
      };

      const parsed = CaptureReceivedChromeHighlightSchema.safeParse(detailCandidate);
      if (!parsed.success) {
        // Don't echo the full Zod error tree — could leak which fields the
        // attacker accidentally included. Surface a stable error code +
        // log the full error for the operator (CloudWatch).
        // eslint-disable-next-line no-console
        console.warn('[chrome-webhook] body schema parse failed', parsed.error.issues);
        return reply(400, { error: 'invalid_body' });
      }

      tagTraceWithCaptureId(captureId);

      // --- EventBridge emit -------------------------------------------------
      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.capture',
              Source: 'kos.capture',
              DetailType: 'capture.received',
              Detail: JSON.stringify(parsed.data),
            },
          ],
        }),
      );

      return reply(200, { capture_id: captureId, status: 'accepted' });
    } finally {
      // Best-effort flush; never blocks > 2s (tracing.ts internal timeout).
      await langfuseFlush();
    }
  },
);
