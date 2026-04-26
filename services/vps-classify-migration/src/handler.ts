/**
 * @kos/service-vps-classify-migration — MIG-01 VPS classify_and_save adapter.
 *
 * Wave-1 handler body. Replaces the Wave-0 NotImplementedYet scaffold.
 *
 * Lambda Function URL (auth=NONE) is the new endpoint that VPS-side
 * `classify_and_save.py` POSTs to during the 14-day Phase-10 decommission
 * overlap (D-23 / G-01). HMAC pair (Authorization Bearer + X-KOS-Signature)
 * IS the auth boundary; the body is passthrough Zod-parsed so we never
 * reject a payload just because the VPS shipped a new field. On success the
 * adapter mints a server-side ULID, emits one `capture.received` event onto
 * the `kos.capture` EventBridge bus with a distinct `Source` (so Phase-2
 * triage's existing rule ignores it during the overlap), and returns
 * `{ capture_id, emitted_at, source }` matching `ClassifyAdapterResultSchema`.
 *
 * Threat mitigations (re-stated in code per RESEARCH.md):
 *   T-10-01-01 (Spoofing):  Bearer + HMAC pair gates the Lambda. Bearer
 *     alone is NOT sufficient — the VPS-side script signs `${ts}.${body}`
 *     so a captured Bearer + replayed older body still fails.
 *   T-10-01-02 (Replay):    drift > 5 min → 401. In-window replay is
 *     accepted at the adapter (no replay cache) — dedup is enforced upstream
 *     by the consumer's `capture_id` ULID idempotency belt (D-21).
 *   T-10-01-03 (Timing):    `crypto.timingSafeEqual` for every compare.
 *
 * Status code policy:
 *   - 405 method not POST
 *   - 400 missing/empty body, missing headers, malformed JSON, Zod failure
 *   - 401 Bearer mismatch, signature mismatch, drift > 300s
 *   - 202 accepted (event on bus) → returns `{ capture_id, emitted_at, source }`
 *   - 500 EventBridge failure (handler throws → Lambda surfaces 5xx)
 *
 * The 202 (vs 200) is intentional — it tells the VPS caller "we accepted
 * the payload but processing is asynchronous on our side", which is true:
 * triage / voice-capture / etc. consume `capture.received` independently.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { initSentry, wrapHandler, Sentry } from '../../_shared/sentry.js';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  ClassifyPayloadSchema,
  ClassifyAdapterResultSchema,
  type ClassifyPayload,
  type ClassifyAdapterResult,
} from '@kos/contracts';
import { verifySignature, constantTimeEquals } from './hmac.js';
import { getHmacSecret } from './secrets.js';
import { emitCaptureReceived } from './emit.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

// Module-scope EventBridge client. Lambda reuses the TLS connection across
// warm invocations — the client deliberately lives outside the handler.
const eb = new EventBridgeClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

// Cap inbound body at 1 MB. The VPS-side `classify_and_save.py` writes
// short JSON titles + payload-bag rich-text — anything bigger is a misuse
// vector. (Lambda Function URL itself caps at 6 MB; this is defence-in-depth.)
const MAX_BODY_BYTES = 1 * 1024 * 1024;

interface FnUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

/** Build a JSON response with the canonical content-type. */
function reply(
  statusCode: number,
  body: Record<string, unknown>,
): FnUrlResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Pull a header in a case-insensitive manner. Function URL events deliver
 * lowercased keys but we accept the canonical CamelCase form too in case
 * the VPS-side caller sends the original mixed-case header.
 */
function readHeader(
  headers: Record<string, string | undefined> | undefined,
  ...names: string[]
): string | undefined {
  if (!headers) return undefined;
  for (const n of names) {
    const direct = headers[n];
    if (direct) return direct;
    const lower = headers[n.toLowerCase()];
    if (lower) return lower;
  }
  return undefined;
}

/** Strip a leading `Bearer ` prefix (case-insensitive). */
function stripBearer(authz: string | undefined): string | undefined {
  if (!authz) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(authz);
  return m ? m[1]!.trim() : authz.trim();
}

export const handler = wrapHandler(
  async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    await initSentry();

    try {
      const method = event.requestContext?.http?.method;
      if (method !== 'POST') {
        return reply(405, { error: 'method_not_allowed' });
      }

      if (!event.body || event.body.length === 0) {
        return reply(400, { error: 'empty_body' });
      }

      const bodyRaw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;

      if (Buffer.byteLength(bodyRaw, 'utf8') > MAX_BODY_BYTES) {
        return reply(413, { error: 'body_too_large' });
      }

      // ----- Auth: Bearer + X-KOS-Signature ---------------------------------
      const sigHeader = readHeader(
        event.headers,
        'X-KOS-Signature',
        'x-kos-signature',
      );
      const authHeader = readHeader(event.headers, 'Authorization', 'authorization');

      const bearer = stripBearer(authHeader);
      if (!bearer) {
        return reply(401, { error: 'unauthorized' });
      }

      let secret: string;
      try {
        secret = await getHmacSecret();
      } catch (err) {
        // Fail-closed on secret-load failure. Surface to Sentry — this is
        // an operator misconfiguration, not a per-request error.
        Sentry.captureException?.(err, {
          tags: { 'mig01.fatal': 'secret_load_failed' },
        });
        return reply(500, { error: 'server_misconfigured' });
      }

      // Bearer compare (constant-time). The Bearer is a pre-shared secret
      // identical to the HMAC secret — keeps the auth surface uniform with
      // `services/chrome-webhook` (D-10-01 reference). A divergent value
      // here would be a defence-in-depth split if Plan 10-01 cutover step
      // chooses to rotate Bearer + HMAC independently; the contract is
      // intentionally "single shared secret" today.
      if (!constantTimeEquals(bearer, secret)) {
        return reply(401, { error: 'unauthorized' });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const v = verifySignature(secret, sigHeader, bodyRaw, nowSec);
      if (!v.ok) {
        // 'missing' / 'malformed' = client error (400);
        // 'drift' / 'signature' = auth failure (401).
        if (v.reason === 'missing' || v.reason === 'malformed') {
          return reply(400, { error: v.reason });
        }
        return reply(401, { error: 'unauthorized' });
      }

      // ----- Body parse: passthrough Zod ------------------------------------
      let parsed: ClassifyPayload;
      try {
        const json = JSON.parse(bodyRaw) as unknown;
        parsed = ClassifyPayloadSchema.parse(json);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply(400, {
            error: 'invalid_payload',
            issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
          });
        }
        return reply(400, { error: 'invalid_json' });
      }

      // ----- Mint capture_id + emit -----------------------------------------
      const captureId = ulid();
      const emittedAt = new Date().toISOString();

      try {
        await emitCaptureReceived(
          { eb, busName: process.env.KOS_CAPTURE_BUS_NAME ?? 'kos.capture' },
          { capture_id: captureId, raw: parsed, emitted_at: emittedAt },
        );
      } catch (err) {
        Sentry.captureException?.(err, {
          tags: { 'mig01.fatal': 'eventbridge_emit_failed' },
          extra: { capture_id: captureId },
        });
        // Re-throw so Lambda surfaces 5xx — the VPS-side caller's existing
        // retry loop redelivers. We MUST NOT swallow this because a 202
        // response without a bus event would be a lie (silent data loss).
        throw err;
      }

      // ----- Success: 202 with the canonical adapter-result shape -----------
      const result: ClassifyAdapterResult = ClassifyAdapterResultSchema.parse({
        capture_id: captureId,
        emitted_at: emittedAt,
        source: 'vps-classify-migration-adapter',
      });

      return reply(202, {
        capture_id: result.capture_id,
        emitted_at: result.emitted_at,
        source: result.source,
        adapter_version: '10-01-v1',
      });
    } catch (err) {
      // Any uncaught error gets a Sentry breadcrumb + a 500. wrapHandler
      // also surfaces it via @sentry/aws-serverless but we keep an explicit
      // catch so the response shape stays JSON (Lambda's default 500 is HTML).
      Sentry.captureException?.(err);
      return reply(500, { error: 'internal_error' });
    }
  },
);

// Re-export the contract types the CDK + tests reference.
export type { ClassifyPayload, ClassifyAdapterResult };
