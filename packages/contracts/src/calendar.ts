/**
 * Phase 8 / Plan 08-00 — Calendar event schemas (MEM-05 read-only).
 *
 * Two exported Zod schemas:
 *   - CalendarEventSchema       — calendar_events_cache row shape
 *   - CalendarEventsReadSchema  — emitted on kos.system after a poll
 *
 * Read-only by design: KOS does NOT write to Google Calendar. The
 * calendar-reader Lambda holds calendar.readonly scope only; reschedule_
 * meeting mutations are annotation-only (see mutation.ts). Kevin does the
 * actual GCal edit on his phone or in the GCal web UI.
 */
import { z } from 'zod';

// --- calendar_events_cache row -----------------------------------------
//
// Mirror of the SQL table in migration 0020. `account` is one of the two
// Google identities Kevin owns (work + personal). `is_all_day` is true when
// the GCal `start.date` field is set (not `start.dateTime`). `attendees_json`
// is normalised at read time — only email + display_name are kept; richer
// fields like `responseStatus` are dropped to minimise PII surface.
//
// `ignored_by_kevin` is the cancel_meeting mutation's flip target. Once
// true, downstream readers (morning brief, etc.) hide the event but the
// underlying row remains for audit + a future un-ignore pathway.
export const CalendarEventSchema = z.object({
  event_id: z.string(),
  account: z.enum(['kevin-elzarka', 'kevin-taleforge']),
  calendar_id: z.string(),
  summary: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  start_utc: z.string().datetime(),
  end_utc: z.string().datetime(),
  timezone: z.string(),
  attendees_json: z
    .array(
      z.object({
        email: z.string(),
        display_name: z.string().nullable().optional(),
      }),
    )
    .default([]),
  updated_at: z.string().datetime(),
  is_all_day: z.boolean(),
  ignored_by_kevin: z.boolean().default(false),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

// --- calendar.events_read (kos.system) ---------------------------------
//
// Lightweight summary emitted after every poll cycle. Does NOT carry the
// per-event payload (the cache table is the source of truth). Used by the
// dashboard's "last calendar sync" badge + verifier scripts.
export const CalendarEventsReadSchema = z.object({
  account: z.enum(['kevin-elzarka', 'kevin-taleforge']),
  window_start_utc: z.string().datetime(),
  window_end_utc: z.string().datetime(),
  fetched_at: z.string().datetime(),
  events_count: z.number().int().min(0),
});
export type CalendarEventsRead = z.infer<typeof CalendarEventsReadSchema>;
