/**
 * Sentry server init — runs in the Next.js Node runtime (route handlers,
 * RSC render, middleware chain outside Edge). Plan 03-06 Task 2.
 *
 * DSN lives under SENTRY_DSN (non-public) so server-only failures don't
 * leak through client bundles. Sampling + scrubber mirror sentry.client.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

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
