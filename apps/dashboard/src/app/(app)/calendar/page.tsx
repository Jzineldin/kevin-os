/**
 * Calendar Week view (`/calendar`) — Plan 03-10 Task 3.
 *
 * Server Component. Computes the current-week window [Mon 00:00,
 * next-Mon 00:00) in Stockholm time (Phase 3 single-user constant),
 * fetches from dashboard-api `/calendar/week`, and hands off to the
 * client `CalendarWeekView` which owns the grid + SSE subscription.
 *
 * Data source: Command Center Deadline + Idag rows ONLY (D-04). Google
 * Calendar merge lands in Phase 8 (CAP-09).
 */
import {
  CalendarWeekResponseSchema,
  type CalendarWeekResponse,
} from '@kos/contracts/dashboard';
import { callApi } from '@/lib/dashboard-api';
import { CalendarWeekView } from './CalendarWeekView';

export const dynamic = 'force-dynamic';

function currentWeekWindow(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dow = (start.getDay() + 6) % 7; // Mon=0
  start.setDate(start.getDate() - dow);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

export default async function CalendarPage() {
  const { start, end } = currentWeekWindow();
  let initial: CalendarWeekResponse;
  try {
    initial = await callApi(
      `/calendar/week?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { method: 'GET' },
      CalendarWeekResponseSchema,
    );
  } catch {
    // Preview without dashboard-api wired: render an empty week.
    initial = { start, end, events: [] };
  }
  return <CalendarWeekView initial={initial} />;
}
