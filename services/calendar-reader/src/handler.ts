// services/calendar-reader/src/handler.ts (stub — body arrives in Plan 08-01)
//
// Phase 8 MEM-05 read-only Google Calendar reader: scheduled poller invoked
// by EventBridge Scheduler every ~15 min. Uses calendar.readonly OAuth scope
// only — there is structurally NO write path in this Lambda's IAM. Refreshes
// access token from Secrets Manager (kos/gcal-oauth-<account>), pages through
// events.list for both kevin-elzarka + kevin-taleforge calendars, upserts
// rows into calendar_events_cache, emits calendar.events_read on kos.system.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service calendar-reader: handler body not yet implemented — see Plan 08-01',
  );
};
