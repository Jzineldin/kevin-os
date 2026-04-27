/**
 * GET /integrations/health — channel-health + scheduler-health snapshot.
 *
 * Phase 11 Plan 11-06 (D-07 live data wiring + the explicit "Cron/Job
 * status table — mission-control's 'Cron Jobs' page" deliverable).
 *
 * Aggregates per-agent_name `MAX(finished_at)` from `agent_runs` (verified
 * granular in Wave 0 schema verification: triage, voice-capture,
 * granola-poller, gmail-poller, transcript-extractor, calendar-reader,
 * entity-resolver:<name>, weekly-review, day-close, morning-brief). For
 * each known capture-channel and scheduler we surface:
 *   - last_event_at  / last_run_at  (from agent_runs.finished_at)
 *   - status         classified vs an expected interval (capture only)
 *   - last_status    most recent run's status (scheduler only)
 *
 * Channel classification:
 *   healthy   age <= max_age_min
 *   degraded  max_age_min < age <= 2× max_age_min
 *   down      age > 2× max_age_min  OR  last_ok IS NULL
 *
 * Schedulers do not classify — Kevin reads the raw last_run_at + status
 * column to decide. `next_run_at` is currently null because EventBridge
 * Scheduler's NextInvocationTime is not exposed via SDK without a per-job
 * GetSchedule call (flagged for a future polish plan in 11-06-SUMMARY).
 *
 * Cache: `private, max-age=0, stale-while-revalidate=60` — Phase 11 SSE
 * loop re-issues the GET on every inbox_item event so a 60s SWR window is
 * plenty.
 *
 * Threat model (Plan 11-06 STRIDE register):
 *   - T-11-06-01 (I): only agent_name + finished_at + status surfaced.
 *     No input_hash, no output_json — those would leak capture metadata.
 *   - T-11-06-04 (E): every SQL path includes `owner_id = ${OWNER_ID}` —
 *     defense in depth even though the Lambda already checks Bearer.
 */
import { sql } from 'drizzle-orm';
import {
  ChannelHealthItemSchema,
  IntegrationsHealthResponseSchema,
  SchedulerHealthItemSchema,
  type ChannelHealthItem,
  type SchedulerHealthItem,
} from '@kos/contracts/dashboard';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

/**
 * Known capture channels. `agent_name` is the value Wave 0 verified as the
 * canonical name written to `agent_runs.agent_name` for that pipeline.
 * `max_age_min` is the longest expected gap between successful runs before
 * we flip the channel to "degraded" (and 2× → "down").
 */
const CHANNEL_SPEC: ReadonlyArray<{
  name: string;
  agent_name: string;
  max_age_min: number;
}> = [
  // Telegram only fires when Kevin sends — long window keeps it green
  // unless he actively posts and the bot fails to ack.
  { name: 'Telegram', agent_name: 'telegram-bot', max_age_min: 1440 },
  // Gmail polled every 5min; allow 30min slack before degraded.
  { name: 'Gmail', agent_name: 'gmail-poller', max_age_min: 30 },
  // Granola polled every 15min; allow 60min slack.
  { name: 'Granola', agent_name: 'granola-poller', max_age_min: 60 },
  // Calendar polled every 30min; allow 90min slack.
  { name: 'Google Calendar', agent_name: 'calendar-reader', max_age_min: 90 },
  // Webhook channels only fire on user activity — generous window.
  { name: 'Chrome extension', agent_name: 'chrome-webhook', max_age_min: 4320 },
  { name: 'LinkedIn', agent_name: 'linkedin-webhook', max_age_min: 4320 },
];

/**
 * Known schedulers. The "Cron Jobs" surface in mission-control's reference
 * UI — Kevin sees last-run + status here, no classification.
 */
const SCHEDULER_SPEC: ReadonlyArray<{ name: string; agent_name: string }> = [
  { name: 'morning-brief', agent_name: 'morning-brief' },
  { name: 'day-close', agent_name: 'day-close' },
  { name: 'weekly-review', agent_name: 'weekly-review' },
  { name: 'gmail-poller', agent_name: 'gmail-poller' },
  { name: 'granola-poller', agent_name: 'granola-poller' },
  { name: 'calendar-reader', agent_name: 'calendar-reader' },
];

type AggRow = {
  last_ok: string | null;
  last_any: string | null;
  last_status: 'ok' | 'fail' | 'pending' | null;
};

function classifyChannel(
  lastOkAt: string | null,
  maxAgeMin: number,
): ChannelHealthItem['status'] {
  if (lastOkAt == null) return 'down';
  const ageMs = Date.now() - new Date(lastOkAt).getTime();
  const ageMin = ageMs / 60_000;
  if (ageMin > maxAgeMin * 2) return 'down';
  if (ageMin > maxAgeMin) return 'degraded';
  return 'healthy';
}

/**
 * One pass over agent_runs. We keep the query owner-scoped (T-11-06-04).
 *
 * `last_ok`     — MAX(finished_at) where status='ok'  (used for capture
 *                 health + scheduler last-success)
 * `last_any`    — MAX(finished_at) regardless of status (used for
 *                 scheduler last-run, which surfaces failures too)
 * `last_status` — status of the most-recent run (correlated subquery,
 *                 indexed because agent_runs has (owner_id, agent_name,
 *                 finished_at) — see Wave 0 schema doc)
 */
async function loadAgentRunsAggregate(): Promise<Map<string, AggRow>> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT
      agent_name,
      MAX(CASE WHEN status = 'ok' THEN finished_at END)::text AS last_ok,
      MAX(finished_at)::text AS last_any,
      (
        SELECT status FROM agent_runs ar2
        WHERE ar2.agent_name = ar.agent_name
          AND ar2.owner_id = ${OWNER_ID}
        ORDER BY ar2.finished_at DESC NULLS LAST
        LIMIT 1
      ) AS last_status
    FROM agent_runs ar
    WHERE owner_id = ${OWNER_ID}
    GROUP BY agent_name
  `)) as unknown as {
    rows: Array<{
      agent_name: string;
      last_ok: string | null;
      last_any: string | null;
      last_status: string | null;
    }>;
  };
  const map = new Map<string, AggRow>();
  for (const row of r.rows) {
    map.set(row.agent_name, {
      last_ok: row.last_ok,
      last_any: row.last_any,
      last_status:
        row.last_status === 'ok' ||
        row.last_status === 'fail' ||
        row.last_status === 'pending'
          ? row.last_status
          : null,
    });
  }
  return map;
}

/**
 * Fallback data-source freshness for each channel.
 *
 * Most pollers (gmail, calendar, notion, etc.) don't write to `agent_runs` on
 * every run, so `loadAgentRunsAggregate` reports `last_event_at=null` and the
 * channel shows "down" even though data is flowing. To make the health panel
 * reflect reality, we supplement agent_runs with a MAX(timestamp) query on
 * the actual source tables — whichever is more recent wins.
 *
 * Per-channel sources (empirical, based on what actually writes to each
 * table on a healthy prod deploy — verified 2026-04-27):
 *   gmail-poller     → email_drafts.received_at
 *   calendar-reader  → calendar_events_cache.cached_at
 *   telegram-bot     → MAX(telegram_inbox_queue.queued_at,
 *                          agent_runs[voice-capture | entity-resolver:*].finished_at,
 *                          mention_events[telegram-voice].occurred_at)
 *   granola-poller   → agent_runs[granola-poller | transcript-indexed].finished_at
 *   notion-indexer   → event_log[actor=notion-indexer].occurred_at
 *   chrome-webhook   → mention_events[chrome-*].occurred_at
 *   linkedin-webhook → mention_events[linkedin-*].occurred_at
 */
async function loadDataSourceFreshness(): Promise<
  Record<string, string | null>
> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT
      (SELECT MAX(received_at)::text FROM email_drafts
         WHERE owner_id = ${OWNER_ID})                                  AS gmail_last,
      (SELECT MAX(cached_at)::text FROM calendar_events_cache
         WHERE owner_id = ${OWNER_ID})                                  AS calendar_last,
      (SELECT MAX(occurred_at)::text FROM event_log
         WHERE owner_id = ${OWNER_ID}
           AND actor = 'notion-indexer')                                AS notion_last,
      (SELECT MAX(ts)::text FROM (
         SELECT queued_at AS ts FROM telegram_inbox_queue
           WHERE owner_id = ${OWNER_ID}
         UNION ALL
         SELECT finished_at FROM agent_runs
           WHERE owner_id = ${OWNER_ID}
             AND (agent_name = 'voice-capture'
               OR agent_name LIKE 'entity-resolver:%'
               OR agent_name = 'telegram-bot')
         UNION ALL
         SELECT occurred_at FROM mention_events
           WHERE owner_id = ${OWNER_ID}
             AND source LIKE 'telegram%'
      ) t)                                                              AS telegram_last,
      (SELECT MAX(finished_at)::text FROM agent_runs
         WHERE owner_id = ${OWNER_ID}
           AND (agent_name = 'granola-poller' OR agent_name = 'transcript-indexed'))
                                                                        AS granola_last,
      (SELECT MAX(occurred_at)::text FROM mention_events
         WHERE owner_id = ${OWNER_ID}
           AND source LIKE 'chrome%')                                   AS chrome_last,
      (SELECT MAX(occurred_at)::text FROM mention_events
         WHERE owner_id = ${OWNER_ID}
           AND source LIKE 'linkedin%')                                 AS linkedin_last
  `)) as unknown as {
    rows: Array<{
      gmail_last: string | null;
      calendar_last: string | null;
      notion_last: string | null;
      telegram_last: string | null;
      granola_last: string | null;
      chrome_last: string | null;
      linkedin_last: string | null;
    }>;
  };
  const row: {
    gmail_last?: string | null;
    calendar_last?: string | null;
    notion_last?: string | null;
    telegram_last?: string | null;
    granola_last?: string | null;
    chrome_last?: string | null;
    linkedin_last?: string | null;
  } = r.rows[0] ?? {};
  return {
    'gmail-poller': row.gmail_last ?? null,
    'calendar-reader': row.calendar_last ?? null,
    'notion-indexer': row.notion_last ?? null,
    'telegram-bot': row.telegram_last ?? null,
    'granola-poller': row.granola_last ?? null,
    'chrome-webhook': row.chrome_last ?? null,
    'linkedin-webhook': row.linkedin_last ?? null,
  };
}

function pickMostRecent(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() > new Date(b).getTime() ? a : b;
}

function loadChannels(
  agg: Map<string, AggRow>,
  freshness: Record<string, string | null>,
): ChannelHealthItem[] {
  return CHANNEL_SPEC.map((spec) => {
    const a = agg.get(spec.agent_name);
    // Channel is "up" if EITHER agent_runs logged a success OR the underlying
    // data source has a fresh write. Most pollers don't log to agent_runs on
    // every cycle so the data-source signal is what usually carries.
    const last_event_at = pickMostRecent(
      a?.last_ok ?? null,
      freshness[spec.agent_name] ?? null,
    );
    return ChannelHealthItemSchema.parse({
      name: spec.name,
      type: 'capture',
      status: classifyChannel(last_event_at, spec.max_age_min),
      last_event_at,
    });
  });
}

function loadSchedulers(
  agg: Map<string, AggRow>,
  freshness: Record<string, string | null>,
): SchedulerHealthItem[] {
  return SCHEDULER_SPEC.map((spec) => {
    const a = agg.get(spec.agent_name);
    const last_any = pickMostRecent(
      a?.last_any ?? null,
      freshness[spec.agent_name] ?? null,
    );
    return SchedulerHealthItemSchema.parse({
      name: spec.name,
      last_run_at: last_any,
      next_run_at: null,
      last_status: a?.last_status ?? (last_any ? 'ok' : null),
    });
  });
}

async function integrationsHealthHandler(_ctx: Ctx): Promise<RouteResponse> {
  const [agg, freshness] = await Promise.all([
    loadAgentRunsAggregate(),
    loadDataSourceFreshness(),
  ]);
  const channels = loadChannels(agg, freshness);
  const schedulers = loadSchedulers(agg, freshness);
  const payload = IntegrationsHealthResponseSchema.parse({
    channels,
    schedulers,
  });
  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=60',
    },
  };
}

register('GET', '/integrations/health', integrationsHealthHandler);

export { integrationsHealthHandler };
