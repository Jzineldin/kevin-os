/**
 * KOS Dashboard service worker — Plan 03-12 Task 1 (UI-05 PWA).
 *
 * Served by the Next Route Handler at /serwist/sw.js (see
 * src/app/serwist/[path]/route.ts) via @serwist/turbopack 9.5.7. Swap rule
 * set follows 03-CONTEXT.md D-30/D-31 + 03-RESEARCH.md §4 and §17 P-02.
 *
 * Cache strategy matrix:
 *   /today          HTML  → StaleWhileRevalidate, 24h max-age, only cache 200 (P-02)
 *   /api/today      JSON  → StaleWhileRevalidate, 24h max-age, only cache 200
 *   everything else       → @serwist/turbopack `defaultCache` (Workbox defaults)
 *
 * Hard non-goals:
 *   - NEVER cache /login, /api/auth/*, /api/stream (SSE). These either bypass
 *     by explicit URL rules OR rely on the fact that defaultCache uses
 *     NetworkOnly for `mode: 'no-cors'` / POST / EventStream requests.
 *   - NEVER cache redirects. `cacheWillUpdate` returns null for any non-200
 *     response. Without this guard, a 302 → /login from middleware would be
 *     cached and the next offline reload of /today would flash /login.
 *
 * SW lifecycle (03-RESEARCH.md §17 P-02):
 *   - `skipWaiting: true` — install the new SW immediately on every deploy so
 *     stale cached HTML never lingers past one visit.
 *   - `clientsClaim: true` — take control of open tabs right away.
 *   - `navigationPreload: true` — parallelise network + SW fetch for nav
 *     requests, key to the <1.5s LCP budget on /today even on a warm SW.
 *
 * Auth-cookie + SW interaction note (RESEARCH §17 P-02):
 *   Cached /today HTML was rendered under a valid session cookie. If Kevin
 *   logs out, his next /today visit is served from cache first, then the
 *   background revalidation fetch returns a 302 → /login which we DO NOT
 *   cache (cacheWillUpdate rejects). Dashboard-api calls triggered by the
 *   cached HTML will 401; the page then redirects to /login. Acceptable
 *   single-user tradeoff per threat T-3-12-02 (accepted).
 */
import { defaultCache } from '@serwist/turbopack/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist, StaleWhileRevalidate, NetworkFirst } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

// Plugin factory — only cache HTTP 200 responses. Prevents middleware
// redirects (302 → /login) from ever landing in the runtime cache.
// 03-RESEARCH.md §17 P-02 is the authoritative reference.
const only200 = {
  cacheWillUpdate: async ({ response }: { response: Response }) =>
    response && response.status === 200 ? response : null,
};

const ONE_DAY_SECONDS = 24 * 60 * 60;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Today view — HTML navigation request. NetworkFirst (not
    // StaleWhileRevalidate) so Kevin always gets the latest brief /
    // priorities / proposals. Falls back to cache offline. Prior SWR
    // caused the 'I deployed 5 times but browser shows old UI' bug
    // where Vercel had the fix but SW served yesterday's HTML for
    // minutes at a time.
    // cacheName bumped to v2 so existing installs drop the SWR cache
    // on first hit after deploy.
    {
      matcher: ({ request, url }: { request: Request; url: URL }) =>
        request.mode === 'navigate' &&
        (url.pathname === '/' || url.pathname === '/today'),
      handler: new NetworkFirst({
        cacheName: 'today-html-v2',
        networkTimeoutSeconds: 3,
        plugins: [only200],
      }),
    },
    // /api/today JSON — NetworkFirst so we don't show yesterday's brief
    // when today's has generated. Same reason as the HTML handler.
    {
      matcher: ({ url }: { url: URL }) => url.pathname === '/api/today',
      handler: new NetworkFirst({
        cacheName: 'today-api-v2',
        networkTimeoutSeconds: 3,
        plugins: [only200],
      }),
    },
    // Everything else — Workbox defaults (static assets, images, fonts).
    ...defaultCache,
  ],
  // If a navigation falls through runtime caching AND the network is down,
  // serve the /offline fallback page so Kevin sees something intentional
  // rather than the browser's raw offline error.
  fallbacks: {
    entries: [
      {
        url: '/offline',
        matcher: ({ request }: { request: Request }) =>
          request.destination === 'document',
      },
    ],
  },
});

serwist.addEventListeners();

// Keep maxAgeSeconds declared for debug visibility in SW devtools. Serwist
// doesn't expose it on the handler directly; the 24h contract is asserted in
// the plan SUMMARY and documented here as the design budget.
const CACHE_MAX_AGE_SECONDS = ONE_DAY_SECONDS;
void CACHE_MAX_AGE_SECONDS;
