/**
 * @kos/service-email-sender — AGT-05 send leg (post-Approve gate).
 *
 * Lambda subscribes to `kos.output / email.approved` (CDK rule wired in
 * Plan 04-05 Task 3). The Approve gate is the security boundary between
 * LLM-generated drafts and outbound SES email — every send MUST be backed
 * by an `email_send_authorizations` row with `consumed_at IS NULL`.
 *
 * Flow:
 *   1. Parse + validate event detail with EmailApprovedSchema (Zod).
 *   2. Open a Postgres txn. SELECT FOR UPDATE the authorization row
 *      joined with the draft. Authorization NULL / already consumed →
 *      skip (idempotent on EventBridge replay).
 *   3. Build RFC 5322 raw message (buildRawMessage). In-Reply-To set
 *      from the original email's Message-ID for threading.
 *   4. SES SendRawEmail wrapped in withTimeoutAndRetry (10s timeout, 2
 *      retries on throttle / 5xx; final failure → agent_dead_letter +
 *      inbox.dead_letter event + draft.status='failed'). The
 *      authorization row is NOT marked consumed on retryable failures —
 *      so a subsequent re-Approve cycle can re-attempt.
 *   5. On success: markDraftSent + markAuthorizationConsumed inside the
 *      same txn, then COMMIT. Then PutEvents `email.sent` on kos.output
 *      (best-effort; SSE fan-out only).
 *
 * Structural separation per Phase 4 D-04 — this Lambda has NO
 * `@anthropic-ai/*` dep, NO `bedrock:*` IAM. It's a pure SES dispatcher
 * gated on a matching Approve token.
 *
 * Idempotency: same authorization_id + same draft_id can only ever
 * succeed once (FOR UPDATE lock + consumed_at check). Concurrent
 * EventBridge replays serialise on the lock; the second attempt sees
 * consumed_at NOT NULL and returns `{ skipped: 'already_consumed' }`.
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { withTimeoutAndRetry } from '../../_shared/with-timeout-retry.js';
import { EmailApprovedSchema } from '@kos/contracts';
import {
  getPool,
  loadDraftForSend,
  markDraftSent,
  markAuthorizationConsumed,
  markDraftFailed,
  type QueryablePool,
} from './persist.js';
import { buildRawMessage, sendRawEmail } from './ses.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

let eb: EventBridgeClient | null = null;

function getEventBridge(): EventBridgeClient {
  if (eb) return eb;
  eb = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  return eb;
}

/** Test seam — vitest can swap in a mocked EventBridge client. */
export function __setEventBridgeClientForTest(fake: EventBridgeClient | null): void {
  eb = fake;
}

// EventBridge envelope shape — matches the AWS Lambda destination contract.
// We avoid `aws-lambda` types so the package needs no extra @types/* install
// (mirrors services/transcript-extractor/src/handler.ts).
interface EBEvent {
  source: string;
  'detail-type': string;
  detail: unknown;
  time?: string;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();

  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    if (event['detail-type'] !== 'email.approved') {
      return { skipped: event['detail-type'] };
    }
    const detail = EmailApprovedSchema.parse(event.detail);
    tagTraceWithCaptureId(detail.capture_id);

    const pool = (await getPool()) as unknown as QueryablePool & {
      query: QueryablePool['query'];
    };

    // Begin transaction — FOR UPDATE on the authorization row inside.
    // The pool's `query` is what the loadDraftForSend helper expects;
    // we issue raw BEGIN/COMMIT/ROLLBACK on the same connection via
    // dedicated client for proper lock scoping.
    const realPool = pool as unknown as {
      connect: () => Promise<{
        query: QueryablePool['query'];
        release: () => void;
      }>;
    };
    const client = await realPool.connect();
    let sesMessageId: string | undefined;
    try {
      await client.query('BEGIN', []);
      const draft = await loadDraftForSend(
        client,
        detail.draft_id,
        detail.authorization_id,
      );
      if (!draft) {
        await client.query('ROLLBACK', []);
        // eslint-disable-next-line no-console
        console.warn('[email-sender] draft not found, mismatched, or already consumed', {
          draft_id: detail.draft_id,
          authorization_id: detail.authorization_id,
        });
        return { skipped: 'not_found_or_consumed' };
      }

      const rendered = buildRawMessage({
        from: draft.from_email,
        to: [draft.reply_to],
        subject: draft.draft_subject ?? draft.subject ?? '',
        bodyText: draft.draft_body,
        ...(draft.in_reply_to ? { inReplyTo: draft.in_reply_to } : {}),
        ...(draft.references && draft.references.length > 0
          ? { references: draft.references }
          : {}),
      });

      try {
        const sent = await withTimeoutAndRetry(
          () => sendRawEmail(rendered),
          {
            timeoutMs: 10_000,
            maxRetries: 2,
            toolName: 'ses.send_raw',
            captureId: detail.capture_id,
            ownerId,
            pool,
            eventBridge: getEventBridge(),
            requestPreview: `to=${draft.reply_to} subject=${(
              draft.draft_subject ?? draft.subject ?? ''
            ).slice(0, 80)}`,
          },
        );
        sesMessageId = sent.messageId;
        await markDraftSent(client, detail.draft_id, sent.messageId);
        await markAuthorizationConsumed(client, detail.authorization_id, {
          messageId: sent.messageId,
          sent_at: new Date().toISOString(),
        });
        await client.query('COMMIT', []);
      } catch (err) {
        // withTimeoutAndRetry has already written the dead-letter row +
        // emitted inbox.dead_letter. Roll back the FOR UPDATE lock so the
        // authorization stays unconsumed, then mark the draft failed via
        // a separate write (outside the rolled-back txn) so the dashboard
        // can surface the failure.
        try {
          await client.query('ROLLBACK', []);
        } catch {
          // Rollback failure shouldn't mask the original error.
        }
        try {
          await markDraftFailed(pool, detail.draft_id, String(err));
        } catch (markErr) {
          // eslint-disable-next-line no-console
          console.error('[email-sender] markDraftFailed failed', markErr);
        }
        throw err;
      }
    } finally {
      client.release();
    }

    // Best-effort fan-out for SSE so the dashboard re-fetches the inbox
    // list and shows the draft as sent. Failures here do NOT roll back
    // the SES send (the email already left the building).
    if (sesMessageId !== undefined) {
      try {
        await getEventBridge().send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: 'kos.output',
                Source: 'kos.output',
                DetailType: 'email.sent',
                Detail: JSON.stringify({
                  capture_id: detail.capture_id,
                  draft_id: detail.draft_id,
                  ses_message_id: sesMessageId,
                  sent_at: new Date().toISOString(),
                }),
              },
            ],
          }),
        );
      } catch (emitErr) {
        // eslint-disable-next-line no-console
        console.warn('[email-sender] email.sent emit failed', emitErr);
      }
    }

    return { sent: sesMessageId ?? '' };
  } finally {
    await langfuseFlush();
  }
});
