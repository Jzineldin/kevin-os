/**
 * Phase 8 Plan 08-00 Task 5 — canned Google Calendar v3 + OAuth responses.
 *
 * calendar-reader (Plan 08-01) calls
 *   - https://www.googleapis.com/calendar/v3/calendars/primary/events
 *   - https://oauth2.googleapis.com/token (refresh-token exchange)
 * via native fetch (no googleapis SDK — keeps Lambda bundle small).
 *
 * GCAL_EVENTS_LIST_PRIMARY covers two distinct event shapes:
 *   - Event with start.dateTime + attendees     (timed meeting)
 *   - Event with start.date (no dateTime)        (all-day calendar block)
 *
 * GCAL_OAUTH_REFRESH_SUCCESS is the standard refresh-token response.
 * GCAL_OAUTH_REFRESH_INVALID is the refresh-token-revoked path — the
 * calendar-reader Lambda must surface this as a system_alert with
 * severity='auth_fail' (alerted, not crashed).
 */
export const GCAL_EVENTS_LIST_PRIMARY = {
  items: [
    {
      id: 'gcal-evt-001',
      summary: 'Damien sync',
      description: 'Outbehaving weekly',
      start: {
        dateTime: '2026-04-25T11:00:00+02:00',
        timeZone: 'Europe/Stockholm',
      },
      end: {
        dateTime: '2026-04-25T12:00:00+02:00',
        timeZone: 'Europe/Stockholm',
      },
      attendees: [
        { email: 'damien@outbehaving.com', displayName: 'Damien Hateley' },
      ],
      updated: '2026-04-20T09:00:00Z',
      status: 'confirmed',
    },
    {
      id: 'gcal-evt-002',
      summary: 'Almi bolagsstämma',
      start: { date: '2026-04-28' },
      end: { date: '2026-04-28' },
      updated: '2026-04-15T14:00:00Z',
      status: 'confirmed',
    },
  ],
};

export const GCAL_OAUTH_REFRESH_SUCCESS = {
  access_token: 'ya29.fake_access_token',
  expires_in: 3599,
  token_type: 'Bearer',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
};

export const GCAL_OAUTH_REFRESH_INVALID = {
  error: 'invalid_grant',
  error_description: 'Token has been expired or revoked.',
};
