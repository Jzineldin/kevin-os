import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import { withSerwist } from '@serwist/turbopack';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kos/db', '@kos/contracts'],
  typedRoutes: true,
};

// Paper-cut #2 migration (quick 260424-r6s) — @serwist/next 9.5.7 is
// Webpack-only and a silent no-op under Next 16's default Turbopack
// builder. @serwist/turbopack's `withSerwist` is a bare wrapper: it only
// adds ['esbuild', 'esbuild-wasm'] to `serverExternalPackages`. All SW
// options (swSrc, cacheOnNavigation, reloadOnOnline, disable) move to
// the Route Handler (`src/app/serwist/[path]/route.ts`) and the client
// provider (`src/components/pwa/serwist-provider.tsx`).

// Sentry wraps the Serwist-wrapped config so the two plugins compose in
// the same order as before (Sentry OUTER, Serwist INNER).
export default withSentryConfig(withSerwist(config), {
  org: 'tale-forge',
  project: 'kos-dashboard',
  silent: true,
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
