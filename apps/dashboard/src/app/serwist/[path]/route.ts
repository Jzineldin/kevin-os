/**
 * Paper-cut #2 (quick 260424-r6s) — Serwist service worker Route Handler.
 *
 * @serwist/turbopack serves the SW via a dynamic Route Handler that
 * esbuild-bundles `src/app/sw.ts` at request time in dev and at build
 * time in prod (via `generateStaticParams` + `dynamic: 'force-static'`).
 * Served URL is `/serwist/sw.js` — NOT `/sw.js`. Middleware bypass +
 * client registration both reference the new URL.
 */
import { createSerwistRoute } from '@serwist/turbopack';

const route = createSerwistRoute({
  swSrc: 'src/app/sw.ts',
  // Vercel + EC2 dev both run Linux, so the native esbuild path is fine
  // and avoids the esbuild-wasm cold-start cost. Explicit so we don't
  // rely on the platform default.
  useNativeEsbuild: true,
  // Default `globPatterns` + `globDirectory` are correct for the Next
  // app layout. Leave injectionPoint at its default
  // (`self.__SW_MANIFEST`) — sw.ts already declares it.
});

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = route;
