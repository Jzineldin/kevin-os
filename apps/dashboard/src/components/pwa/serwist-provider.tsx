'use client';

/**
 * Paper-cut #2 (quick 260424-r6s) — client-side SW registration.
 *
 * Wraps @serwist/turbopack/react's <SerwistProvider> with KOS-specific
 * defaults that mirror the previous `withSerwistInit` options from
 * `@serwist/next`:
 *   - cacheOnNavigation: true  (was in next.config.ts — now here)
 *   - reloadOnOnline: true     (was in next.config.ts — now here)
 *   - disable: NODE_ENV === 'development'  (same — enforced client-side)
 *   - register: true           (same behaviour as @serwist/next default)
 *
 * swUrl matches the Route Handler in src/app/serwist/[path]/route.ts.
 */
import { SerwistProvider } from '@serwist/turbopack/react';
import type { ReactNode } from 'react';

const SW_URL = '/serwist/sw.js';

export function KosSerwistProvider({ children }: { children: ReactNode }) {
  const disableInDev = process.env.NODE_ENV === 'development';
  return (
    <SerwistProvider
      swUrl={SW_URL}
      disable={disableInDev}
      register
      cacheOnNavigation
      reloadOnOnline
    >
      {children}
    </SerwistProvider>
  );
}
