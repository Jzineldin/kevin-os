import type { Metadata, Viewport } from 'next';
import { Inter_Tight, IBM_Plex_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { KosSerwistProvider } from '@/components/pwa/serwist-provider';
import './globals.css';

// Phase 12 visual rebuild (mockup-v4) — the UI face of KOS.
//   Inter Tight = neutral, calm UI sans, open apertures at 13-15px
//   IBM Plex Mono = data / meta / kbd face, warm and legible at 10-12px
// next/font hosts them locally (no Google fetch at render time), emits
// CSS variables consumed by globals.css (--font-sans / --font-mono).
const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Kevin OS',
  description: 'Personal operating system for Kevin El-zarka',
  // Plan 03-12 Task 1 — wire the PWA manifest into every page's <head>.
  // Next 15 emits the matching <link rel="manifest"> tag automatically.
  manifest: '/manifest.webmanifest',
  applicationName: 'Kevin OS',
  appleWebApp: {
    capable: true,
    title: 'Kevin OS',
    statusBarStyle: 'black-translucent',
  },
};

// Next 15 deprecated `themeColor` on `metadata` — belongs on `viewport` per
// https://nextjs.org/docs/app/api-reference/functions/generate-viewport. The
// value matches 03-UI-SPEC §Design System "Surface bg #0a0c11".
export const viewport: Viewport = {
  themeColor: '#0a0c11',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${interTight.variable} ${plexMono.variable}`}>
      <body>
        <KosSerwistProvider>{children}</KosSerwistProvider>
        {/* Gate 4 source of truth — weekly-active-sessions (D-40). */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
