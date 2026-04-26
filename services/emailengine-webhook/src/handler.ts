/**
 * @kos/service-emailengine-webhook — CAP-07 (EmailEngine push → KOS capture).
 *
 * EmailEngine (running as a single Fargate task on kos-cluster, Plan 04-03)
 * holds an IMAP IDLE connection per Gmail account and POSTs JSON envelopes
 * here on every `messageNew` event. This Lambda:
 *   1. Verifies the X-EE-Secret header via constant-time compare
 *      (timingSafeEqual) against the shared secret in Secrets Manager.
 *   2. Zod-parses the inbound payload into a CaptureReceivedEmailInbox event.
 *   3. Emits `capture.received { kind: email_inbox, channel: email-inbox }` to
 *      the `kos.capture` EventBridge bus, wrapped in withTimeoutAndRetry so
 *      transient EventBridge / network errors retry once (1s backoff).
 *
 * The handler is intentionally envelope-only — it does NOT call Bedrock,
 * does NOT touch RDS, does NOT classify content. Triage runs downstream in
 * the email-triage Lambda (Plan 04-04). Keeping this surface tiny means the
 * Function URL (authType=NONE — X-EE-Secret IS the auth boundary) can stay
 * cheap, fast, and trivially auditable.
 *
 * Idempotency: capture_id is derived deterministically from
 * `(account_id, message_id)` via SHA-256 → 26-char Crockford base32 (ULID
 * shape). Re-delivery of the same `messageNew` webhook (EmailEngine retries
 * on 5xx) yields the same capture_id, so downstream consumers (triage,
 * archive) dedupe naturally on capture_id.
 *
 * Threat mitigations (per Plan 04-03 STRIDE register):
 *  - T-04-EE-01 (spoofing): X-EE-Secret + timingSafeEqual.
 *  - T-04-EE-03 (info disclosure): only EmailEngine task SG can hit Function URL?
 *    No — Function URL is internet-reachable; X-EE-Secret IS the auth boundary.
 *
 * Function URL auth is `NONE` per Plan 04-03 — EmailEngine cannot speak SigV4,
 * so we cannot use AWS_IAM. The shared secret is the gate.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { withTimeoutAndRetry } from '../../_shared/with-timeout-retry.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CaptureReceivedEmailInboxSchema } from '@kos/contracts';
import { getWebhookSecret } from './secrets.js';
import { timingSafeEqual, createHash } from 'node:crypto';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';
const eb = new EventBridgeClient({ region: 'eu-north-1' });

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

/**
 * Derive a deterministic, ULID-shaped (26-char Crockford base32) capture_id
 * from the EmailEngine account name + RFC-5322 Message-ID. SHA-256 → first
 * 26 bytes mod-32 mapped onto Crockford alphabet. Same input → same output;
 * downstream `capture_id` consumers dedupe on equality.
 *
 * NOTE: This is NOT a real ULID — it carries no timestamp prefix and is not
 * sortable by time. The shape (26 chars, Crockford alphabet) matches the
 * regex on every CaptureReceived* schema so Zod validation passes.
 */
function deterministicCaptureId(accountId: string, messageId: string): string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const hash = createHash('sha256')
    .update(`${accountId}|${messageId}`)
    .digest();
  let out = '';
  for (let i = 0; i < 26; i++) {
    out += CROCKFORD[hash[i]! % 32];
  }
  return out;
}

/** Best-effort header lookup (Function URL headers are lowercase but be safe). */
function hdr(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  return headers[name.toLowerCase()] ?? headers[name];
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

      // --- Auth: X-EE-Secret constant-time compare -------------------------
      // T-04-EE-01: never use `===` on the secret; the timing channel leaks
      // the secret one byte per online comparison. timingSafeEqual returns
      // in O(secret-length) time regardless of the input.
      const provided = hdr(event.headers, 'x-ee-secret');
      if (!provided) {
        return reply(401, { error: 'missing_secret' });
      }
      const secret = await getWebhookSecret();
      const a = Buffer.from(secret, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      // timingSafeEqual throws on length mismatch — guard length first so we
      // don't leak whether the lengths matched via a thrown error vs a
      // returned false.
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply(401, { error: 'bad_secret' });
      }

      // --- Body parse ------------------------------------------------------
      if (!event.body) {
        return reply(400, { error: 'empty_body' });
      }
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      let payload: {
        event?: string;
        account?: string;
        path?: string;
        date?: string;
        data?: {
          id?: string;
          uid?: number;
          messageId?: string;
          from?: { name?: string; address?: string };
          to?: Array<{ name?: string; address?: string }>;
          cc?: Array<{ name?: string; address?: string }>;
          subject?: string;
          text?: { plain?: string; html?: string };
          date?: string;
        };
      };
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply(400, { error: 'invalid_json' });
      }

      // --- Filter on event type --------------------------------------------
      // EmailEngine emits messageNew, messageDeleted, messageUpdated,
      // accountLogError, etc. Only `messageNew` triggers a capture; everything
      // else is ack'd with 200 so EmailEngine doesn't retry.
      if (payload.event !== 'messageNew') {
        return reply(200, { skipped: payload.event ?? 'unknown' });
      }

      const messageId = payload.data?.messageId;
      const accountId = payload.account;
      if (!messageId || !accountId) {
        // Cannot construct a stable capture_id without both; reject so the
        // operator notices via EmailEngine's failure dashboard.
        return reply(400, { error: 'missing_message_id_or_account' });
      }

      const captureId = deterministicCaptureId(accountId, messageId);
      tagTraceWithCaptureId(captureId);

      // --- Build + emit capture.received ----------------------------------
      const detail = CaptureReceivedEmailInboxSchema.parse({
        capture_id: captureId,
        channel: 'email-inbox' as const,
        kind: 'email_inbox' as const,
        email: {
          account_id: accountId,
          message_id: messageId,
          from: payload.data?.from?.address ?? '',
          to: (payload.data?.to ?? [])
            .map((x) => x.address)
            .filter((a): a is string => typeof a === 'string'),
          ...(payload.data?.cc
            ? {
                cc: payload.data.cc
                  .map((x) => x.address)
                  .filter((a): a is string => typeof a === 'string'),
              }
            : {}),
          subject: payload.data?.subject ?? '',
          body_text: payload.data?.text?.plain ?? '',
          ...(payload.data?.text?.html ? { body_html: payload.data.text.html } : {}),
          received_at: payload.data?.date ?? new Date().toISOString(),
          ...(typeof payload.data?.uid === 'number' ? { imap_uid: payload.data.uid } : {}),
        },
        received_at: new Date().toISOString(),
      });

      await withTimeoutAndRetry(
        () =>
          eb.send(
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
          ),
        {
          toolName: 'eventbridge:put-events',
          captureId,
          ownerId: process.env.KEVIN_OWNER_ID ?? '00000000-0000-0000-0000-000000000000',
          timeoutMs: 5_000,
          maxRetries: 1,
        },
      );

      return reply(200, { capture_id: captureId, status: 'accepted' });
    } finally {
      await langfuseFlush();
    }
  },
);
