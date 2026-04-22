/**
 * Stockholm quiet-hours + date-key utilities.
 *
 * Design decisions (Phase 1 D-13 + RESEARCH Pitfall 6):
 *  - Lambda environment runs with `TZ=UTC` (KosLambda default). Stockholm
 *    math is done exclusively via `Intl.DateTimeFormat` /
 *    `Date#toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })` so
 *    DST transitions (CET ↔ CEST) are handled correctly by the ICU library.
 *  - The `sv-SE` locale formats timestamps as `YYYY-MM-DD HH:mm:ss` which
 *    is cheap to split on the single space without regex parsing.
 *  - Quiet hours: 20:00 ≤ hour < 08:00 Stockholm local time (D-13).
 *  - The DynamoDB cap key uses `stockholmDateKey` so a send at Stockholm
 *    23:59 and another at Stockholm 00:01 land in different keys (different
 *    Stockholm days) — which is the correct behaviour: each calendar day
 *    has its own 3-send budget.
 */

/** Returns true if `now` is within Stockholm quiet hours (20:00 ≤ h < 08:00 local). */
export function isQuietHour(now: Date = new Date()): boolean {
  // toLocaleString('sv-SE', { ... hour: '2-digit' }) returns a two-char string
  // like "20" (24-hour, zero-padded) when hour12 is false.
  const hourStr = now.toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour12: false,
    hour: '2-digit',
  });
  const h = parseInt(hourStr, 10);
  if (Number.isNaN(h)) {
    // Defensive: unexpected locale output — treat as NOT quiet so messages
    // still flow; in practice Node 22 ICU always returns two digits.
    return false;
  }
  return h >= 20 || h < 8;
}

/**
 * Returns the Stockholm-local calendar date as `YYYY-MM-DD` for the given
 * instant. Used as the DynamoDB partition key suffix: `telegram-cap#YYYY-MM-DD`.
 *
 * We format via `sv-SE` which yields `YYYY-MM-DD HH:mm:ss` and split on the
 * space. This is locale-stable because `sv-SE` is the Swedish standard format
 * and is not affected by Intl behaviour changes the way Swedish numeric
 * formats have been historically.
 */
export function stockholmDateKey(now: Date = new Date()): string {
  const sv = now.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const datePart = sv.split(' ')[0];
  if (!datePart) {
    throw new Error(`Unexpected sv-SE locale output: "${sv}"`);
  }
  return datePart;
}
