/**
 * @kos/service-baileys-sidecar — CAP-06 WhatsApp ingress sidecar (Plan 05-05).
 *
 * Lambda Function URL invoked by the Baileys Fargate container
 * (`services/baileys-fargate`, Plan 05-04) for every observed WhatsApp event
 * on the WebSocket. Authenticates via constant-time `X-BAILEYS-Secret`
 * compare against a Secrets-Manager-stored shared secret (the SAME value the
 * Lambda passes back when fetching audio bytes from the container's
 * `/media/{id}` endpoint — bidirectional trust).
 *
 * Branching on `event` + `data.messages[].message.{conversation,extendedTextMessage,audioMessage}`:
 *   - text  → emit `capture.received { kind: whatsapp_text }`
 *   - voice → fetch audio bytes from `${BAILEYS_MEDIA_BASE_URL}/{id}`
 *           → S3 PutObject `audio/{YYYY}/{MM}/{captureId}.ogg`
 *           → emit `capture.received { kind: whatsapp_voice, raw_ref: {...} }`
 *           (transcribe-starter, Plan 02-02, picks up the audio/* upload via
 *           its existing S3 PutObject trigger — zero further wiring needed)
 *   - everything else → 200 OK + skip
 *
 * Idempotency: `capture_id` is a 26-char Crockford ULID-shape derived
 * deterministically from sha256(`${chat_jid}|${message_key_id}`). Re-delivery
 * of the same Baileys envelope produces the same capture_id, so the Phase-2
 * triage's capture-id dedupe handles replays naturally (T-05-05-03 mitigation).
 *
 * Threat mitigations:
 *  - T-05-05-01 (spoofing): X-BAILEYS-Secret + timingSafeEqual.
 *  - T-05-05-02 (info disclosure): no error path echoes message bytes; S3
 *    PutObject is scoped to `audio/*` only (CDK).
 *  - T-05-05-03 (replay): deterministic capture_id → downstream dedup.
 *  - T-05-05-04 (DoS): Function URL has no throttle; cost negligible at
 *    1-user volume; CloudWatch alarm catches a misbehaving container.
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
import {
  CaptureReceivedWhatsappTextSchema,
  CaptureReceivedWhatsappVoiceSchema,
} from '@kos/contracts';
import { timingSafeEqual, createHash } from 'node:crypto';
import { getWebhookSecret } from './secrets.js';
import { putAudio } from './s3.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';
const eb = new EventBridgeClient({ region: 'eu-north-1' });

/** Crockford-base32 alphabet (no I/L/O/U) — same as ulid spec. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Deterministic 26-char ULID-shape id from `(chat_jid, message_key_id)`.
 * The same input always produces the same id; downstream dedup is
 * idempotent on duplicate webhooks (T-05-05-03 mitigation). We use only
 * 26 of sha256's 32 bytes — the first 26 — and modulo 32 each to land
 * in the Crockford alphabet so the id passes the contracts UlidRegex
 * (`/^[0-9A-HJKMNP-TV-Z]{26}$/`).
 */
function deterministicCaptureId(
  chatJid: string,
  messageKeyId: string,
): string {
  const hash = createHash('sha256')
    .update(`${chatJid}|${messageKeyId}`)
    .digest();
  let out = '';
  for (let i = 0; i < 26; i++) {
    out += CROCKFORD[hash[i]! % 32];
  }
  return out;
}

/** Lambda Function URL event shape (subset we use). */
interface FnUrlEvent {
  rawPath?: string;
  requestContext?: {
    http?: { method?: string; path?: string; sourceIp?: string };
  };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface FnUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

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

/** Read a header case-insensitively. */
function header(event: FnUrlEvent, name: string): string | undefined {
  if (!event.headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Constant-time secret compare. Returns false on length mismatch (no throw). */
function checkSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Subset of the fazer-ai/baileys-api `messages.upsert` envelope we read.
 * Anything else (presence.update, connection.update, …) is skipped at the
 * top of the handler.
 */
interface BaileysMessage {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string };
  messageTimestamp?: number | string;
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    audioMessage?: {
      url?: string;
      mimetype?: string;
      seconds?: number;
      ptt?: boolean;
    };
  };
}

interface BaileysUpsertEnvelope {
  event?: string;
  data?: { messages?: BaileysMessage[]; type?: string };
}

export const handler = wrapHandler(
  async (event: FnUrlEvent): Promise<FnUrlResponse> => {
    await initSentry();
    await setupOtelTracingAsync();

    try {
      if (event.requestContext?.http?.method !== 'POST') {
        return reply(405, { error: 'method_not_allowed' });
      }

      // --- Auth -------------------------------------------------------------
      // Read the secret BEFORE the body so a missing/wrong header bounces
      // before we allocate a JSON parse. `getWebhookSecret` itself fails
      // closed if the env var is unset or the secret is PLACEHOLDER.
      const expected = await getWebhookSecret();
      const presented = header(event, 'x-baileys-secret');
      if (!presented) {
        return reply(401, { error: 'missing_secret' });
      }
      if (!checkSecret(presented, expected)) {
        return reply(401, { error: 'unauthorized' });
      }

      // --- Body -------------------------------------------------------------
      if (!event.body || event.body.length === 0) {
        return reply(400, { error: 'empty_body' });
      }
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      let payload: BaileysUpsertEnvelope;
      try {
        payload = JSON.parse(raw) as BaileysUpsertEnvelope;
      } catch {
        return reply(400, { error: 'invalid_json' });
      }

      // Anything that isn't a `messages.upsert` event is acknowledged but
      // not routed (presence.update / connection.update / chats.set / …).
      if (payload.event !== 'messages.upsert') {
        return reply(200, {
          status: 'skipped',
          reason: 'not_messages_upsert',
        });
      }

      const messages = payload.data?.messages ?? [];
      if (messages.length === 0) {
        return reply(400, { error: 'empty_messages' });
      }

      const captureIds: string[] = [];
      let routedAtLeastOne = false;

      for (const m of messages) {
        // Skip Kevin's own outbound. The Fargate container is operated
        // read-only (no send) — so seeing `fromMe:true` would be unexpected,
        // but we defend in depth.
        if (m.key?.fromMe === true) continue;

        const chatJid = m.key?.remoteJid;
        const keyId = m.key?.id;
        if (!chatJid || !keyId) continue;

        const captureId = deterministicCaptureId(chatJid, keyId);
        const isGroup = chatJid.endsWith('@g.us');
        const sentAt = m.messageTimestamp
          ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString();
        const fromName = m.pushName;
        const receivedAt = new Date().toISOString();

        const text =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          undefined;
        const audio = m.message?.audioMessage;

        if (text && text.length > 0) {
          tagTraceWithCaptureId(captureId);
          const detail = CaptureReceivedWhatsappTextSchema.parse({
            capture_id: captureId,
            channel: 'whatsapp' as const,
            kind: 'whatsapp_text' as const,
            jid: chatJid,
            chat_jid: chatJid,
            ...(fromName ? { from_name: fromName } : {}),
            body: text,
            is_group: isGroup,
            sent_at: sentAt,
            received_at: receivedAt,
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
          captureIds.push(captureId);
          routedAtLeastOne = true;
          continue;
        }

        if (audio) {
          const mediaBase = process.env.BAILEYS_MEDIA_BASE_URL;
          if (!mediaBase) {
            // Audio observed but no upstream fetch endpoint configured —
            // we can't reach the bytes, so drop the message silently. This
            // path only fires if Plan 05-04 didn't pass BAILEYS_MEDIA_BASE_URL
            // through to this Lambda's env (operator config error).
            // eslint-disable-next-line no-console
            console.warn(
              '[baileys-sidecar] BAILEYS_MEDIA_BASE_URL unset; voice message dropped',
              { capture_id: captureId },
            );
            continue;
          }
          // The container exposes /media/{id} with the same shared secret.
          let bytes: Uint8Array;
          try {
            const r = await fetch(
              `${mediaBase.replace(/\/$/, '')}/${encodeURIComponent(keyId)}`,
              {
                headers: { 'X-BAILEYS-Secret': expected },
              },
            );
            if (!r.ok) {
              // eslint-disable-next-line no-console
              console.warn('[baileys-sidecar] media fetch failed', {
                status: r.status,
                capture_id: captureId,
              });
              continue;
            }
            bytes = new Uint8Array(await r.arrayBuffer());
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[baileys-sidecar] media fetch error', {
              err: (err as Error).message,
              capture_id: captureId,
            });
            continue;
          }
          if (bytes.byteLength === 0) {
            // eslint-disable-next-line no-console
            console.warn('[baileys-sidecar] media bytes empty', {
              capture_id: captureId,
            });
            continue;
          }
          const mime = audio.mimetype ?? 'audio/ogg; codecs=opus';
          tagTraceWithCaptureId(captureId);
          const { bucket, key } = await putAudio(captureId, bytes, mime);
          const duration = Math.max(0, Math.floor(Number(audio.seconds ?? 0)));
          const detail = CaptureReceivedWhatsappVoiceSchema.parse({
            capture_id: captureId,
            channel: 'whatsapp' as const,
            kind: 'whatsapp_voice' as const,
            jid: chatJid,
            chat_jid: chatJid,
            ...(fromName ? { from_name: fromName } : {}),
            raw_ref: {
              s3_bucket: bucket,
              s3_key: key,
              duration_sec: duration,
              mime_type: mime,
            },
            is_group: isGroup,
            sent_at: sentAt,
            received_at: receivedAt,
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
          captureIds.push(captureId);
          routedAtLeastOne = true;
          continue;
        }

        // Neither text nor audio — skip silently. The fan-out includes
        // reactions, deletes, system stub messages, etc. that we don't
        // route in v1.
      }

      // If the envelope shape was a messages.upsert but every message in
      // it was unroutable (no text, no audio, all fromMe), surface a 400 so
      // the Fargate container's logs catch the misuse. A mixed batch where
      // at least one message routed returns 200.
      if (!routedAtLeastOne) {
        return reply(400, {
          error: 'no_routable_messages',
        });
      }

      return reply(200, { capture_ids: captureIds, status: 'accepted' });
    } finally {
      await langfuseFlush();
    }
  },
);
