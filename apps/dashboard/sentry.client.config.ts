/**
 * Sentry client init — runs in the browser. Plan 03-06 Task 2.
 *
 * Per 03-RESEARCH R-07:
 *   - tracesSampleRate 1.0 dev / 0.2 prod.
 *   - Session Replay OFF (replaysSessionSampleRate: 0). We keep error
 *     replays at 1.0 because they are post-hoc and covered by the Sentry
 *     GDPR DPA (T-3-06-02 disposition).
 *
 * Per 03-RESEARCH §16:
 *   - beforeSend scrubs `cookie` + `authorization` headers from every
 *     captured request to avoid leaking the kos_session bearer.
 *
 * DSN is exposed via NEXT_PUBLIC_SENTRY_DSN — safe per Sentry docs (DSN
 * is meant to be public).
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

  // Session Replay OFF per R-07 + T-3-06-02.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,

  integrations: [],

  beforeSend(event) {
    const headers = event.request?.headers as
      | Record<string, string>
      | undefined;
    if (headers) {
      delete headers.authorization;
      delete headers.Authorization;
      delete headers.cookie;
      delete headers.Cookie;
    }
    return event;
  },
});
