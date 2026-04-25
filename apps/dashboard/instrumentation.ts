/**
 * Next 15 instrumentation hook — called once per runtime boot. We branch
 * on NEXT_RUNTIME so Node gets Node-specific Sentry init and Edge gets
 * Edge-specific init; the client init lives in sentry.client.config.ts
 * and is wired by @sentry/nextjs automatically via the withSentryConfig
 * next.config.ts wrapper.
 *
 * Per @sentry/nextjs ≥ 10 the recommended pattern is:
 *   - dynamic-import the runtime-appropriate config here
 *   - re-export `onRequestError` from `@sentry/nextjs` so Next's
 *     instrumentation pipeline can forward request errors to Sentry.
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
