/**
 * @kos/service-calendar-reader — CAP-09 (Phase 8 Plan 08-01).
 *
 * Read-only Google Calendar reader. Invoked every 30 min by EventBridge
 * Scheduler `cron(0/30 * * * ? *)` Europe/Stockholm. For each of Kevin's
 * two accounts (kevin-elzarka, kevin-taleforge):
 *
 *   1. Resolve a fresh access_token via getAccessToken() (cached at module
 *      scope, refreshed proactively 10 min before Google's expiry).
 *   2. Fetch events.list within [now - 1h, now + 48h] (RESEARCH P-3 / P-4 —
 *      the prior-hour overlap covers midnight-boundary edge cases).
 *   3. UPSERT into calendar_events_cache on (event_id, account) — D-32
 *      idempotency key.
 *   4. Emit a `calendar.events.cached` event on `kos.capture` for the
 *      dashboard's "last calendar sync" badge + Langfuse trace grouping.
 *
 * Auth-stale handling:
 *   On 401 from events.list, invalidate the cached token and retry exactly
 *   once. A second 401 surfaces as a per-account failure (logged + counted)
 *   while the OTHER account continues independently — partial success is
 *   far preferable to total failure when one OAuth refresh_token has been
 *   revoked.
 *
 * IAM scoping (T-08-CAL-06 mitigation, asserted in CDK tests):
 *   - secrets:GetSecretValue on kos/gcal-oauth-* ONLY
 *   - rds-db:connect as kos_agent_writer
 *   - events:PutEvents on kos.capture ONLY
 *   - explicitly NO bedrock:*, ses:*, postiz:*, notion:*
 *
 * Read-only OAuth scope: `calendar.readonly`. Mutation-executor / publisher
 * / content-writer have NO Google auth scope at all (T-08-CAL-01).
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { GcalCalendarEventSchema as _gcalSchema } from '@kos/contracts';
import { CalendarEventsReadSchema } from '@kos/contracts/calendar';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { getAccessToken, invalidateToken, type GcalAccount } from './oauth.js';
import { fetchEventsWindow, GcalAuthStaleError } from './gcal.js';
import { getPool, upsertCalendarEvents, type UpsertCounts } from './persist.js';

// AWS_REGION default for tests + local invocation. Lambda always sets this.
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

// Acknowledge import so tree-shaking / lint don't complain about the
// barrel-export sanity hook (the schema validates the cache row shape in
// dev/tests; runtime only emits the lighter CalendarEventsReadSchema).
void _gcalSchema;

const ACCOUNTS: readonly GcalAccount[] = [
  'kevin-elzarka',
  'kevin-taleforge',
] as const;

// 2026-04-27 widened from 48h → 30 days. The /calendar/week dashboard
// view wants the current rolling week, and Kevin routinely has events
// scheduled 1-3 weeks out he wants visible in KOS. The 1h past-window
// covers midnight-boundary overlap and lets "starts in N minutes" show
// for events currently in-progress.
const FETCH_WINDOW_PAST_HOURS = 1;
const FETCH_WINDOW_FUTURE_HOURS = 24 * 30;

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
  account: GcalAccount;
  events: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface AccountFailure {
  account: GcalAccount;
  reason: string;
}

export interface CalendarReaderResult {
  ok: AccountResult[];
  failed: AccountFailure[];
  window_start_utc: string;
  window_end_utc: string;
}

/**
 * Per-account fetch + upsert with one-shot 401-retry.
 *
 * The retry is bounded to ONE attempt — a second 401 on the same invocation
 * almost certainly means the refresh_token itself is revoked, in which case
 * we want the failure to surface to operator monitoring rather than burn
 * Lambda budget on an infinite loop.
 */
async function processAccount(
  account: GcalAccount,
  pgPool: Awaited<ReturnType<typeof getPool>>,
  ownerId: string,
  timeMin: string,
  timeMax: string,
): Promise<AccountResult> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const token = await getAccessToken(account);
      const events = await fetchEventsWindow({
        accessToken: token,
        timeMinIso: timeMin,
        timeMaxIso: timeMax,
      });
      const counts: UpsertCounts = await upsertCalendarEvents(pgPool, {
        ownerId,
        account,
        events,
        calendarId: 'primary',
      });
      return {
        account,
        events: events.length,
        inserted: counts.inserted,
        updated: counts.updated,
        unchanged: counts.unchanged,
      };
    } catch (err) {
      const isAuthStale =
        err instanceof GcalAuthStaleError ||
        (err as { code?: string }).code === 'auth_stale';
      if (isAuthStale && attempt === 0) {
        // First 401: drop the cached access_token so the next loop iteration
        // re-runs the refresh-token exchange. Almost certainly the cached
        // access_token expired between minted-time and use; the new token
        // succeeds.
        invalidateToken(account);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

async function emitCachedEvent(
  account: GcalAccount,
  windowStartIso: string,
  windowEndIso: string,
  fetchedAtIso: string,
  eventsCount: number,
): Promise<void> {
  const busName = process.env.KOS_CAPTURE_BUS_NAME ?? 'kos.capture';
  const detail = CalendarEventsReadSchema.parse({
    account,
    window_start_utc: windowStartIso,
    window_end_utc: windowEndIso,
    fetched_at: fetchedAtIso,
    events_count: eventsCount,
  });
  await getEventBridge().send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: 'kos.capture',
          DetailType: 'calendar.events.cached',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
}

export const handler = wrapHandler(
  async (_event: unknown): Promise<CalendarReaderResult> => {
    await initSentry();
    await setupOtelTracingAsync();

    const ownerId = process.env.KEVIN_OWNER_ID;
    if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

    const now = new Date();
    const fetchedAtIso = now.toISOString();
    const timeMin = new Date(
      now.getTime() - FETCH_WINDOW_PAST_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const timeMax = new Date(
      now.getTime() + FETCH_WINDOW_FUTURE_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // Group every Bedrock / outbound call inside this invocation under a
    // single Langfuse session keyed by the fetched_at timestamp — avoids
    // collision with capture_id semantics in other agent flows.
    tagTraceWithCaptureId(`calendar-reader-${fetchedAtIso}`);

    try {
      const pool = await getPool();
      // Fan out across both accounts in parallel; one stale refresh_token must
      // not block the healthy account from refreshing its window.
      const settled = await Promise.allSettled(
        ACCOUNTS.map((account) =>
          processAccount(account, pool, ownerId, timeMin, timeMax),
        ),
      );

      const ok: AccountResult[] = [];
      const failed: AccountFailure[] = [];
      for (let i = 0; i < settled.length; i++) {
        const account = ACCOUNTS[i]!;
        const r = settled[i]!;
        if (r.status === 'fulfilled') {
          ok.push(r.value);
          // Emit observability event per successful account.
          try {
            await emitCachedEvent(
              account,
              timeMin,
              timeMax,
              fetchedAtIso,
              r.value.events,
            );
          } catch (emitErr) {
            const msg =
              emitErr instanceof Error ? emitErr.message : String(emitErr);
            // eslint-disable-next-line no-console
            console.warn(
              `[calendar-reader] PutEvents failed for ${account}: ${msg}`,
            );
          }
        } else {
          const reason =
            r.reason instanceof Error
              ? r.reason.message
              : String(r.reason ?? 'unknown');
          // eslint-disable-next-line no-console
          console.warn(
            `[calendar-reader] account ${account} failed: ${reason}`,
          );
          failed.push({ account, reason });
        }
      }

      return {
        ok,
        failed,
        window_start_utc: timeMin,
        window_end_utc: timeMax,
      };
    } finally {
      await langfuseFlush();
    }
  },
);
