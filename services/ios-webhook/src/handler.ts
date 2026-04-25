/**
 * @kos/service-ios-webhook — CAP-02 (iOS Action Button voice capture ingress).
 *
 * Lambda Function URL → HMAC verify → DDB replay-cache → S3 PutObject →
 * EventBridge `kos.capture / capture.received { kind: voice, channel: ios-shortcut }`.
 *
 * Function URL auth is `NONE` per D-02 — the HMAC + replay-cache pair IS the
 * auth boundary. Everything else (S3 key, capture_id, EventBridge detail) is
 * derived server-side; the client controls only the audio bytes + signature.
 *
 * Threat mitigations:
 *  - T-04-IOS-01 (replay): timestamp drift check (hmac.ts) + DDB conditional
 *    PutItem (replay.ts). Replay window 600s = 2× HMAC tolerance.
 *  - T-04-IOS-02 (tampering): HMAC covers timestamp + raw body; mutation
 *    breaks the signature.
 *  - T-04-IOS-03 (info disclosure): error responses never echo body content
 *    or capture_id on rejection paths.
 *  - T-04-IOS-05 (repudiation): capture_id returned in the 200 response and
 *    emitted to EventBridge; CloudWatch logs + EB carry the audit trail.
 *  - T-04-IOS-06 (timing attack): `crypto.timingSafeEqual` (hmac.ts).
 *
 * Plan 02-02's transcribe-starter trigger fires on any `audio/*` PutObject in
 * the blobs bucket — the Lambda needs zero changes to pick up our uploads.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ulid } from 'ulid';
import { CaptureReceivedIosSchema } from '@kos/contracts';
import { verifySignature } from './hmac.js';
import { recordSignature } from './replay.js';
import { getWebhookSecret } from './secrets.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';
const eb = new EventBridgeClient({ region: 'eu-north-1' });
const s3 = new S3Client({ region: 'eu-north-1' });

// Cap the audio payload at ~10 MB (≈ 10 minutes of 128 kbps m4a). The iOS
// Action Button shortcut targets short voice memos; anything bigger is a
// misuse / abuse vector. Lambda Function URL itself caps at 6 MB request,
// so this is a defence-in-depth check.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

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

/** Build a JSON response with the canonical `application/json` content type. */
function reply(statusCode: number, body: Record<string, unknown>): FnUrlResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
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

      if (!event.body || event.body.length === 0) {
        return reply(400, { error: 'empty_body' });
      }

      const bodyRaw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;

      const sigHeader =
        event.headers?.['x-kos-signature'] ??
        event.headers?.['X-KOS-Signature'];

      const secret = await getWebhookSecret();
      const nowSec = Math.floor(Date.now() / 1000);
      const v = verifySignature(secret, sigHeader, bodyRaw, nowSec);
      if (!v.ok) {
        // 'missing' / 'malformed' = client error (400); 'drift' / 'signature' =
        // auth failure (401). Reason field intentionally vague — we don't tell
        // the attacker which check failed except via the status code split.
        if (v.reason === 'missing' || v.reason === 'malformed') {
          return reply(400, { error: v.reason });
        }
        return reply(401, { error: 'unauthorized' });
      }

      // After HMAC passes we know `sigHeader` is set + matches HEADER_RE; the
      // type narrowing requires a non-null assertion plus a defensive regex
      // re-extract.
      const v1Match = /v1=([0-9a-f]+)/.exec(sigHeader!);
      const v1Hex = v1Match?.[1];
      if (!v1Hex) {
        // Should be unreachable after a successful verifySignature; fail closed.
        return reply(400, { error: 'malformed' });
      }

      const r = await recordSignature(v1Hex, nowSec);
      if (r.duplicate) {
        return reply(409, { error: 'replay' });
      }

      let parsed: { timestamp?: unknown; audio_base64?: unknown; mime_type?: unknown };
      try {
        parsed = JSON.parse(bodyRaw) as typeof parsed;
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      if (
        typeof parsed.audio_base64 !== 'string' ||
        parsed.audio_base64.length === 0 ||
        typeof parsed.mime_type !== 'string' ||
        parsed.mime_type.length === 0
      ) {
        return reply(400, { error: 'missing_fields' });
      }

      const captureId = ulid();
      tagTraceWithCaptureId(captureId);

      const bucket = process.env.BLOBS_BUCKET;
      if (!bucket) throw new Error('BLOBS_BUCKET env var not set');

      const audioBuf = Buffer.from(parsed.audio_base64, 'base64');
      if (audioBuf.length === 0) {
        return reply(400, { error: 'empty_audio' });
      }
      if (audioBuf.length > MAX_AUDIO_BYTES) {
        return reply(413, { error: 'audio_too_large' });
      }

      const key = `audio/${captureId}.m4a`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: audioBuf,
          ContentType: parsed.mime_type,
          Metadata: {
            capture_id: captureId,
            channel: 'ios-shortcut',
            signature_ts: String(v.timestamp),
          },
        }),
      );

      const detail = CaptureReceivedIosSchema.parse({
        capture_id: captureId,
        channel: 'ios-shortcut' as const,
        kind: 'voice' as const,
        raw_ref: {
          s3_bucket: bucket,
          s3_key: key,
          mime_type: parsed.mime_type,
        },
        received_at: new Date().toISOString(),
        ios: { signature_timestamp: String(v.timestamp) },
      });

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

      return reply(200, { capture_id: captureId, status: 'accepted' });
    } finally {
      // Best-effort flush; never blocks > 2s (tracing.ts internal timeout).
      await langfuseFlush();
    }
  },
);
