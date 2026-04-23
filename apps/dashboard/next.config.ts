import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import withSerwistInit from '@serwist/next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kos/db', '@kos/contracts'],
  // Next 15.5 promoted `typedRoutes` to a top-level stable key.
  typedRoutes: true,
};

// Plan 03-12 Task 1 — @serwist/next 9.5.7 PWA wrapper.
// Reads `src/app/sw.ts`, emits `public/sw.js` at build time. Disabled in
// dev so hot-reload doesn't fight the service worker; install + offline
// behaviour is only meaningful against `next start` / Vercel preview.
// RESEARCH §4 is the canonical setup reference; RESEARCH §17 P-14 explains
// why this plan stays pinned to Next 15 (Turbopack-default breaks Serwist 9).
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development',
});

// Plan 03-06 Task 2 — Sentry wrapper. Source-map upload only runs on CI
// where `SENTRY_AUTH_TOKEN` is set. Locally `silent: true` suppresses the
// "no auth token" warning so `pnpm build` stays clean. Sentry wraps the
// Serwist-wrapped config so the two plugins compose cleanly.
export default withSentryConfig(withSerwist(config), {
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
