import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        {/* Gate 4 source of truth — weekly-active-sessions (D-40). */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
