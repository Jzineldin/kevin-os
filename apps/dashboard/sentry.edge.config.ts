/**
 * Sentry edge init — runs inside Next.js Edge runtime (middleware.ts +
 * any route handler opting in). Plan 03-06 Task 2.
 *
 * The Edge runtime has no Node APIs (no `process.cwd`, no Node crypto).
 * @sentry/nextjs ships an edge-compatible build selected automatically
 * when this file is imported from instrumentation.ts under NEXT_RUNTIME
 * === 'edge'.
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
