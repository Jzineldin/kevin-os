/**
 * push-telegram Lambda handler — Plan 02-06 (OUT-01).
 *
 * Phase 1 shipped this as a scaffolding Lambda with a console.log sender
 * stub so `scripts/verify-cap.mjs` could drive the cap + quiet-hours rails
 * end-to-end without a real bot token. Plan 02-06 promotes it to the real
 * CAP-01 ack path:
 *
 *  1. Real Telegram Bot API sender (telegram.ts) replaces the stub.
 *
 *  2. New `is_reply` flag on the event detail — when voice-capture (or any
 *     future Kevin-initiated-reply agent) emits `output.push` with
 *     `is_reply=true`, the handler forwards `isReply: true` to
 *     `enforceAndIncrement` which short-circuits allowed=true WITHOUT
 *     touching the DynamoDB cap and WITHOUT the quiet-hours check. This
 *     realizes the §13 / Pitfall 6 contract: Kevin's synchronous
 *     Telegram↔Telegram ack flow stays responsive at 22:30 Stockholm
 *     even though every other push channel is suppressed.
 *
 *  3. EventBridge unwrap — the Lambda is now an EB target on `kos.output`
 *     via the rule added in SafetyStack. The handler accepts BOTH the
 *     direct-invoke shape (from Phase 1 tests / future ops tools) and the
 *     EB-wrapped shape `{source, detail-type, detail}`.
 *
 *  4. Send-failed queue — on any Bot API 4xx/5xx the body is enqueued to
 *     `telegram_inbox_queue` with `reason='send-failed'` and the error is
 *     re-thrown so the EventBridge rule's retry+DLQ budget handles it.
 *
 * Wire contract (env):
 *   - CAP_TABLE_NAME                    (DynamoDB cap table)
 *   - RDS_SECRET_ARN, RDS_ENDPOINT      (RDS Proxy — queue writes)
 *   - TELEGRAM_BOT_TOKEN_SECRET_ARN     (the bot token — now consumed)
 *
 * D-05: Lambda lives OUTSIDE the VPC (Telegram API is public; the RDS
 * Proxy endpoint accepts IAM-auth connections from the public internet).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { telegramInboxQueue } from '@kos/db';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { enforceAndIncrement, type CapDenialReason } from './cap.js';
import { sendTelegramMessage } from './telegram.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface PushTelegramEvent {
  body: string;
  capture_id?: string;
  /**
   * §13 / Pitfall 6. ONLY set to true by direct-response agents
   * (voice-capture in Phase 2, triage in future). Scheduled pushes (morning
   * brief, daily close, urgent email drafts) MUST NOT set this.
   */
  is_reply?: boolean;
  telegram?: {
    chat_id: number;
    reply_to_message_id?: number;
  };
}

export interface PushTelegramResult {
  sent: boolean;
  queued: boolean;
  /** `send-failed` extends the Phase 1 cap reasons to cover Bot API failures. */
  reason?: CapDenialReason | 'send-failed';
}

// --- Module-scope RDS pool cache (survives warm starts) ---------------------
let pool: PgPool | null = null;

// 2026-04-22 (Wave 5 Gap B): switched from RDS_SECRET password auth to RDS
// Proxy IAM-token auth. The proxy is configured `iamAuth: true,
// requireTLS: true` and rejects password auth even with valid creds.
// Pattern matches services/triage/src/persist.ts.
async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_ENDPOINT;
  const user = process.env.RDS_IAM_USER ?? 'kos_admin';
  if (!host) throw new Error('RDS_ENDPOINT not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const signer = new Signer({ hostname: host, port: 5432, region, username: user });
  pool = new Pool({
    host,
    port: 5432,
    user,
    database: 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

/**
 * Accept BOTH direct invocation (Phase 1 contract + Phase 2 operator tools)
 * AND the EventBridge-wrapped shape produced by the kos.output rule:
 *   { source: 'kos.output', 'detail-type': 'output.push', detail: {...} }
 *
 * We sniff `detail` rather than `source`/`detail-type` so a direct-invoke
 * caller can pass the inner shape without knowing about EB wrapping.
 */
function unwrapEvent(raw: unknown): PushTelegramEvent {
  const ev = raw as { detail?: unknown } | null;
  if (ev && typeof ev === 'object' && 'detail' in ev && ev.detail) {
    return ev.detail as PushTelegramEvent;
  }
  return raw as PushTelegramEvent;
}

export const handler = wrapHandler(
  async (rawEvent: unknown): Promise<PushTelegramResult> => {
    await initSentry();
    const event = unwrapEvent(rawEvent);

    // Carry the upstream capture_id through to Langfuse if the event has one
    // (voice-capture sets it on output.push). Tag is no-op when no active span.
    if (event.capture_id) tagTraceWithCaptureId(event.capture_id);

    const capTableName = process.env.CAP_TABLE_NAME;
    if (!capTableName) {
      throw new Error('CAP_TABLE_NAME must be set');
    }

    // Forward is_reply to the cap so it short-circuits allowed=true without
    // touching DynamoDB or the quiet-hours gate (§13).
    const check = await enforceAndIncrement({
      tableName: capTableName,
      isReply: event.is_reply,
    });

    if (!check.allowed) {
      // Quiet-hours / cap-exceeded: queue for the Phase 2 morning-brief drain.
      // `reason` column on telegram_inbox_queue takes 'cap-exceeded' |
      // 'quiet-hours' | 'send-failed'.
      const p = await getPool();
      const db = drizzle(p);
      await db.insert(telegramInboxQueue).values({
        body: event.body,
        reason: check.reason ?? 'cap-exceeded',
      });
      return { sent: false, queued: true, reason: check.reason };
    }

    // allowed=true. The only legitimate path here is a real Telegram send;
    // without chat_id we can't call the Bot API, so a missing chat_id is a
    // programming error (upstream agent forgot to forward sender.chat_id).
    if (!event.telegram?.chat_id) {
      throw new Error('push-telegram invoked without telegram.chat_id');
    }

    try {
      await sendTelegramMessage({
        chat_id: event.telegram.chat_id,
        text: event.body,
        reply_to_message_id: event.telegram.reply_to_message_id,
      });
      return { sent: true, queued: false };
    } catch (err) {
      // Queue on send failure so the morning-brief drain can retry the body
      // (user-visible content); surface the error to the Lambda runtime so
      // EventBridge counts an invocation failure and either retries within
      // the rule's budget or routes to the SafetyStack DLQ.
      const p = await getPool();
      const db = drizzle(p);
      await db.insert(telegramInboxQueue).values({
        body: event.body,
        reason: 'send-failed',
      });
      throw err;
    }
  },
);
