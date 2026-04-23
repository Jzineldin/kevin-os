import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kos/db', '@kos/contracts'],
  // Next 15.5 promoted `typedRoutes` to a top-level stable key.
  typedRoutes: true,
};

// Plan 03-06 Task 2 — Sentry wrapper. Source-map upload only runs on CI
// where `SENTRY_AUTH_TOKEN` is set. Locally `silent: true` suppresses the
// "no auth token" warning so `pnpm build` stays clean.
export default withSentryConfig(config, {
  org: 'tale-forge',
  project: 'kos-dashboard',
  silent: true,
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // `tunnelRoute: '/monitoring'` would proxy Sentry traffic through the
  // Vercel edge to dodge ad-blockers — we deliberately skip it until
  // Gate 4 observability baseline is in place so any 4xx from Sentry
  // surfaces immediately during development.
});
