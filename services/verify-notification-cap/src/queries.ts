/**
 * Phase 7 Plan 07-04 — pure SQL + DynamoDB query helpers for the
 * verify-notification-cap Lambda.
 *
 * Two surfaces:
 *
 *   loadCapSnapshots14Days(pool, ddb, capTableName, ownerId)
 *     Returns 14 entries (oldest → newest is the ORDER BY DESC return order;
 *     we always pad to 14 entries even if SQL returned fewer rows). Each
 *     entry carries:
 *       - stockholmDate: 'YYYY-MM-DD' (Stockholm-local calendar day)
 *       - pushOkCount:   count(agent_runs WHERE agent_name='push-telegram'
 *                                          AND status='ok') for that day
 *       - capTableCount: DynamoDB GetItem on `telegram-cap#YYYY-MM-DD` —
 *                        null if DynamoDB GetItem fails (logged warning).
 *       - violation:     pushOkCount > 3 (Phase 1 D-12 cap)
 *
 *   loadQuietHoursViolations14Days(pool, ownerId)
 *     Returns rows from agent_runs where the start time's Stockholm-local
 *     hour falls inside [20, 8) — the quiet-hours window. Each row:
 *       - at:            ISO timestamp
 *       - stockholmHour: integer 0-23 (always either ≥20 or <8 by filter)
 *       - capture_id:    string (may be undefined for legacy rows)
 *
 * Design choices:
 *   - Stockholm date arithmetic via PostgreSQL `AT TIME ZONE` and `EXTRACT
 *     (HOUR FROM ... AT TIME ZONE 'Europe/Stockholm')` — same shape used
 *     elsewhere in the codebase (day-close persist.ts, dropped_threads_v
 *     migration 0014).
 *   - DynamoDB GetItem is best-effort: failures swallowed → null. The SQL
 *     count is the source of truth for compliance; DynamoDB count is a
 *     cross-check that catches drift between the cap-enforcer (push-telegram)
 *     and the executed sends (agent_runs).
 *   - 14-day window aligns with D-07 (weekly Sunday 03:00 verifier sees
 *     last 2 weeks of activity).
 */
import type { Pool as PgPool } from 'pg';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

export interface CapDaySnapshot {
  stockholmDate: string;
  pushOkCount: number;
  capTableCount: number | null;
  violation: boolean;
}

export interface QuietHoursViolation {
  at: string;
  stockholmHour: number;
  capture_id?: string;
}

const CAP_PER_DAY = 3; // Phase 1 D-12 hard cap.

/**
 * D-07 — load 14 daily cap snapshots.
 *
 * SQL groups agent_runs by Stockholm-local calendar day; we pad to exactly
 * 14 entries (ordered today → 13 days ago) so a day with no pushes still
 * shows up as `pushOkCount=0` in the operator output.
 */
export async function loadCapSnapshots14Days(
  pool: PgPool,
  ddb: DynamoDBDocumentClient,
  capTableName: string,
  ownerId: string,
): Promise<CapDaySnapshot[]> {
  const sql = `
    SELECT to_char(date_trunc('day', (started_at AT TIME ZONE 'Europe/Stockholm')), 'YYYY-MM-DD') AS stockholm_date,
           count(*) FILTER (WHERE agent_name = 'push-telegram' AND status = 'ok') AS push_ok_count
      FROM agent_runs
     WHERE owner_id = $1
       AND started_at >= now() - interval '14 days'
     GROUP BY 1
     ORDER BY 1 DESC
  `;
  const r = await pool.query(sql, [ownerId]);
  const sqlByDate = new Map<string, number>();
  for (const row of r.rows as Array<{ stockholm_date: string; push_ok_count: string | number }>) {
    sqlByDate.set(String(row.stockholm_date), Number(row.push_ok_count));
  }

  // Build the 14-day Stockholm-local calendar window (today → 13 days ago).
  // We use sv-SE locale + Europe/Stockholm timezone, same recipe as
  // services/push-telegram/src/quiet-hours.ts::stockholmDateKey.
  const days: string[] = [];
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const sv = d.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
    const datePart = sv.split(' ')[0];
    if (datePart) days.push(datePart);
  }

  // Resolve each day's DynamoDB cap row in parallel — failures swallowed.
  const snapshots: CapDaySnapshot[] = await Promise.all(
    days.map(async (stockholmDate) => {
      const pushOkCount = sqlByDate.get(stockholmDate) ?? 0;
      const capTableCount = await getCapTableCount(ddb, capTableName, stockholmDate);
      return {
        stockholmDate,
        pushOkCount,
        capTableCount,
        violation: pushOkCount > CAP_PER_DAY,
      };
    }),
  );
  return snapshots;
}

async function getCapTableCount(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  stockholmDate: string,
): Promise<number | null> {
  try {
    const r = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `telegram-cap#${stockholmDate}` },
      }),
    );
    const count = r.Item?.count;
    return typeof count === 'number' ? count : null;
  } catch (err) {
    console.warn(
      '[verify-cap] DynamoDB GetItem failed; capTableCount=null',
      JSON.stringify({ stockholmDate, err: String(err) }),
    );
    return null;
  }
}

/**
 * D-07 + D-18 — load quiet-hours violations from the last 14 days.
 *
 * Quiet-hours invariant (per push-telegram/quiet-hours.ts): no push-telegram
 * agent_run with stockholm_hour ∈ [20, 8). The morning-brief schedule was
 * shifted to 08:00 (D-18) precisely to honour this invariant; any violation
 * here is a regression worth alerting on.
 */
export async function loadQuietHoursViolations14Days(
  pool: PgPool,
  ownerId: string,
): Promise<QuietHoursViolation[]> {
  const sql = `
    SELECT started_at,
           capture_id,
           EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Europe/Stockholm'))::int AS stockholm_hour
      FROM agent_runs
     WHERE owner_id = $1
       AND agent_name = 'push-telegram'
       AND status = 'ok'
       AND started_at >= now() - interval '14 days'
       AND (
            EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Europe/Stockholm'))::int >= 20
         OR EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Europe/Stockholm'))::int < 8
       )
     ORDER BY started_at DESC
  `;
  const r = await pool.query(sql, [ownerId]);
  return (r.rows as Array<{ started_at: Date | string; capture_id?: string | null; stockholm_hour: number }>).map(
    (row) => ({
      at:
        row.started_at instanceof Date
          ? row.started_at.toISOString()
          : new Date(row.started_at).toISOString(),
      stockholmHour: Number(row.stockholm_hour),
      capture_id: row.capture_id ?? undefined,
    }),
  );
}
