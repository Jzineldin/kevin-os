/**
 * calendar-reader persist layer (Plan 08-01).
 *
 * Mirrors services/granola-poller/src/persist.ts for the RDS Proxy IAM
 * connection pattern. Adds `upsertCalendarEvents` which UPSERTs each event
 * into the calendar_events_cache table on the (event_id, account) composite
 * primary key (migration 0020).
 *
 * Idempotency contract (D-32): the (account, event_id, updated_at) tuple is
 * the natural change key; rows with an unchanged `updated_at` are detected
 * via the `xmax = 0`/changed-from check below so the handler can return an
 * accurate inserted/updated/unchanged breakdown for observability.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { GcalEvent } from './gcal.js';
import type { GcalAccount } from './oauth.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT ?? process.env.DATABASE_HOST;
  const user =
    process.env.RDS_IAM_USER ?? process.env.DATABASE_USER ?? 'kos_agent_writer';
  if (!host) throw new Error('RDS_PROXY_ENDPOINT (or DATABASE_HOST) not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const signer = new Signer({ hostname: host, port, region, username: user });
  pool = new Pool({
    host,
    port,
    user,
    database: process.env.DATABASE_NAME ?? 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

export interface UpsertCalendarEventsArgs {
  ownerId: string;
  account: GcalAccount;
  events: GcalEvent[];
  calendarId: string;
}

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * UPSERT a batch of events into calendar_events_cache.
 *
 * Returns counts:
 *   - inserted:  primary-key conflict did NOT fire → brand-new row
 *   - updated:   conflict fired AND the incoming `updated_at` is newer
 *   - unchanged: conflict fired AND `updated_at` matches existing row
 *
 * `ignored_by_kevin` is preserved across UPSERTs (we never overwrite the
 * mutation-flip flag on a refresh — D-08 / D-15 / RESEARCH §2).
 */
export async function upsertCalendarEvents(
  pgPool: PgPool,
  args: UpsertCalendarEventsArgs,
): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
  if (args.events.length === 0) return counts;

  for (const ev of args.events) {
    const r = await pgPool.query<{
      action: 'inserted' | 'updated' | 'unchanged';
    }>(
      `WITH input AS (
         SELECT
           $1::text AS event_id,
           $2::text AS account,
           $3::uuid AS owner_id,
           $4::text AS calendar_id,
           $5::text AS summary,
           $6::text AS description,
           $7::text AS location,
           $8::timestamptz AS start_utc,
           $9::timestamptz AS end_utc,
           $10::text AS timezone,
           $11::jsonb AS attendees_json,
           $12::boolean AS is_all_day,
           $13::timestamptz AS updated_at
       ),
       upsert AS (
         INSERT INTO calendar_events_cache (
           event_id, account, owner_id, calendar_id, summary, description,
           location, start_utc, end_utc, timezone, attendees_json,
           is_all_day, updated_at, cached_at
         )
         SELECT
           event_id, account, owner_id, calendar_id, summary, description,
           location, start_utc, end_utc, timezone, attendees_json,
           is_all_day, updated_at, now()
         FROM input
         ON CONFLICT (event_id, account) DO UPDATE
           SET owner_id       = EXCLUDED.owner_id,
               calendar_id    = EXCLUDED.calendar_id,
               summary        = EXCLUDED.summary,
               description    = EXCLUDED.description,
               location       = EXCLUDED.location,
               start_utc      = EXCLUDED.start_utc,
               end_utc        = EXCLUDED.end_utc,
               timezone       = EXCLUDED.timezone,
               attendees_json = EXCLUDED.attendees_json,
               is_all_day     = EXCLUDED.is_all_day,
               updated_at     = EXCLUDED.updated_at,
               cached_at      = now()
           WHERE calendar_events_cache.updated_at < EXCLUDED.updated_at
         RETURNING (xmax = 0) AS was_insert
       )
       SELECT
         CASE
           WHEN (SELECT was_insert FROM upsert) IS NULL THEN 'unchanged'
           WHEN (SELECT was_insert FROM upsert) = true  THEN 'inserted'
           ELSE 'updated'
         END AS action`,
      [
        ev.event_id,
        args.account,
        args.ownerId,
        args.calendarId,
        ev.summary,
        ev.description,
        ev.location,
        ev.start_utc,
        ev.end_utc,
        ev.timezone,
        JSON.stringify(ev.attendees),
        ev.is_all_day,
        ev.updated_at,
      ],
    );
    const action = r.rows[0]?.action ?? 'unchanged';
    counts[action] += 1;
  }
  return counts;
}

/** Test-only helper: reset module-scope pool. */
export function __resetForTests(): void {
  pool = null;
}
