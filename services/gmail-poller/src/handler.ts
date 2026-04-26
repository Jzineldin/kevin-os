/**
 * @kos/service-gmail-poller — replaces EmailEngine for inbound email.
 *
 * Scheduled Lambda that polls Gmail every 5 min for both of Kevin's
 * accounts (kevin-elzarka, kevin-taleforge). For each new message it
 * emits the same `capture.received` event with `kind: 'email_inbox'`
 * that EmailEngine's webhook would have emitted — so the email-triage
 * Lambda + Approve gate + email-sender chain works UNCHANGED.
 *
 * Why polling instead of EmailEngine:
 *   - EmailEngine self-host license is $995/yr. Polling Gmail API is free
 *     (Kevin's two accounts are well under the free quota).
 *   - One less Fargate task + ElastiCache + 5 secrets to operate.
 *   - Reuses the OAuth secret already provisioned for calendar-reader
 *     (`kos/gcal-oauth-<account>`); the bootstrap script just adds
 *     `gmail.readonly` to the consent screen.
 *
 * Latency tradeoff: 5 min vs EmailEngine's seconds. Personal-aggregator
 * use case tolerates this; nothing in KOS triggers on sub-minute email
 * arrival.
 *
 * Idempotency:
 *   - Each poll uses `newer_than:5m` overlapping the prior cycle by ~1
 *     minute (typical Lambda invocation drift). The (account_id, message_id)
 *     UNIQUE on email_drafts collapses dupes downstream, and persist.ts
 *     pre-filters known message_ids so we don't burn Bedrock on retry.
 *
 * IAM scoping (asserted in CDK tests):
 *   - secrets:GetSecretValue on kos/gcal-oauth-* ONLY
 *   - rds-db:connect as kos_agent_writer
 *   - events:PutEvents on kos.capture ONLY
 *   - explicitly NO bedrock:*, ses:*, postiz:*, notion:*, gmail-write
 */
import { ulid } from 'ulid';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CaptureReceivedEmailInboxSchema,
  type CaptureReceivedEmailInbox,
} from '@kos/contracts';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import {
  getAccessToken,
  invalidateToken,
  type GmailAccount,
} from './oauth.js';
import {
  GmailAuthStaleError,
  fetchMessage,
  listNewMessageIds,
  type GmailParsedMessage,
} from './gmail.js';
import { findKnownMessages, getPool } from './persist.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const ACCOUNTS: readonly GmailAccount[] = [
  'kevin-elzarka',
  'kevin-taleforge',
] as const;

/**
 * Overlap window. 5 min cron + 6 min query = 1 min overlap to absorb
 * Lambda cold-start drift + Gmail's per-message indexing lag. Gmail's
 * `newer_than` operator only supports day/month/year units (NOT minutes),
 * so the handler computes a Unix epoch lower bound and passes it via
 * `after:<sec>` instead.
 */
const POLL_LOOKBACK_SECONDS = 6 * 60;

let ebClient: EventBridgeClient | null = null;
function getEventBridge(): EventBridgeClient {
  if (!ebClient) {
    ebClient = new EventBridgeClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
    });
  }
  return ebClient;
}

export interface AccountResult {
  account: GmailAccount;
  fetched: number;
  emitted: number;
  skipped_duplicates: number;
}

export interface AccountFailure {
  account: GmailAccount;
  reason: string;
}

export interface GmailPollerResult {
  ok: AccountResult[];
  failed: AccountFailure[];
  fetched_at: string;
}

async function processAccount(
  account: GmailAccount,
  pgPool: Awaited<ReturnType<typeof getPool>>,
  ownerId: string,
  busName: string,
  fetchedAtIso: string,
): Promise<AccountResult> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const token = await getAccessToken(account);
      const metas = await listNewMessageIds({
        accessToken: token,
        afterEpochSec: Math.floor(Date.now() / 1000) - POLL_LOOKBACK_SECONDS,
      });
      if (metas.length === 0) {
        return { account, fetched: 0, emitted: 0, skipped_duplicates: 0 };
      }
      const known = await findKnownMessages(pgPool, {
        ownerId,
        account,
        messageIds: metas.map((m) => m.id),
      });
      const novel = metas.filter((m) => !known.has(m.id));
      let emitted = 0;
      for (const m of novel) {
        const parsed = await fetchMessage({
          accessToken: token,
          messageId: m.id,
        });
        await emitInboxEvent(busName, account, parsed, fetchedAtIso);
        emitted += 1;
      }
      return {
        account,
        fetched: metas.length,
        emitted,
        skipped_duplicates: metas.length - novel.length,
      };
    } catch (err) {
      const isAuthStale =
        err instanceof GmailAuthStaleError ||
        (err as { code?: string }).code === 'auth_stale';
      if (isAuthStale && attempt === 0) {
        invalidateToken(account);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

async function emitInboxEvent(
  busName: string,
  account: GmailAccount,
  parsed: GmailParsedMessage,
  fetchedAtIso: string,
): Promise<void> {
  const captureId = ulid();
  const detail: CaptureReceivedEmailInbox = CaptureReceivedEmailInboxSchema.parse({
    capture_id: captureId,
    channel: 'email-inbox',
    kind: 'email_inbox',
    email: {
      account_id: account,
      message_id: parsed.id,
      from: parsed.from,
      to: parsed.to,
      ...(parsed.cc.length > 0 ? { cc: parsed.cc } : {}),
      subject: parsed.subject,
      body_text: parsed.bodyText,
      ...(parsed.bodyHtml ? { body_html: parsed.bodyHtml } : {}),
      received_at: parsed.receivedAt,
    },
    received_at: fetchedAtIso,
  });
  await getEventBridge().send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: 'kos.capture',
          DetailType: 'capture.received',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
}

export const handler = wrapHandler(
  async (_event: unknown): Promise<GmailPollerResult> => {
    await initSentry();
    await setupOtelTracingAsync();

    const ownerId = process.env.KEVIN_OWNER_ID;
    if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');
    const busName = process.env.KOS_CAPTURE_BUS_NAME ?? 'kos.capture';

    const fetchedAtIso = new Date().toISOString();
    tagTraceWithCaptureId(`gmail-poller-${fetchedAtIso}`);

    try {
      const pool = await getPool();
      const settled = await Promise.allSettled(
        ACCOUNTS.map((account) =>
          processAccount(account, pool, ownerId, busName, fetchedAtIso),
        ),
      );

      const ok: AccountResult[] = [];
      const failed: AccountFailure[] = [];
      for (let i = 0; i < settled.length; i += 1) {
        const account = ACCOUNTS[i]!;
        const r = settled[i]!;
        if (r.status === 'fulfilled') {
          ok.push(r.value);
        } else {
          const reason =
            r.reason instanceof Error
              ? r.reason.message
              : String(r.reason ?? 'unknown');
          // eslint-disable-next-line no-console
          console.warn(`[gmail-poller] account ${account} failed: ${reason}`);
          failed.push({ account, reason });
        }
      }
      return { ok, failed, fetched_at: fetchedAtIso };
    } finally {
      await langfuseFlush();
    }
  },
);
