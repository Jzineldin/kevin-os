/**
 * Authenticated layout for every /today /inbox /calendar /entities
 * /settings route. Middleware (Plan 03-05) has already enforced the
 * `kos_session` cookie; this layout assumes the request is authenticated.
 *
 * Responsibilities:
 *   1. Compose Sidebar + Topbar + scrolling main content area.
 *   2. Mount global providers scoped to the authenticated tree:
 *      - LiveRegionProvider  (aria-live surface for SSE announcements)
 *      - CommandPaletteProvider (open/close + cmdk Dialog host)
 *      - Toaster (sonner; positioned top-right)
 *   3. Fetch sidebar counts on the server (RSC) via callApi so the shell
 *      renders with correct numbers on first paint. Counts default to
 *      zeroes if the dashboard-api call fails — the shell stays usable.
 *   4. Skip-to-content link (a11y rule 6) — visible on focus only.
 *   5. Max-width 1280px container (Design System table) inside <main>.
 */
import { z } from 'zod';

import { Sidebar, type SidebarCounts } from '@/components/app-shell/Sidebar';
import { Topbar } from '@/components/app-shell/Topbar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LiveRegionProvider } from '@/components/system/LiveRegion';
import { CommandPaletteProvider } from '@/components/palette/CommandPalette';
import { callApi } from '@/lib/dashboard-api';

const SidebarCountsSchema = z.object({
  people: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  inbox: z.number().int().nonnegative(),
});

async function fetchSidebarCounts(): Promise<SidebarCounts> {
  try {
    return await callApi(
      '/entities/list?counts=1',
      { method: 'GET' },
      SidebarCountsSchema,
    );
  } catch {
    // Dashboard-api may not implement /entities/list?counts=1 until Wave 3
    // — returning zeroes keeps the shell rendering cleanly.
    return { people: 0, projects: 0, inbox: 0 };
  }
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const counts = await fetchSidebarCounts();

  return (
    <LiveRegionProvider>
      <TooltipProvider delayDuration={120}>
       <CommandPaletteProvider>
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-[color:var(--color-surface-2)] focus:px-3 focus:py-2 focus:text-[13px] focus:text-[color:var(--color-text)]"
        >
          Skip to content
        </a>

        <div className="flex min-h-screen bg-[color:var(--color-bg)]">
          <Sidebar entityCounts={counts} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar />
            <main
              id="content"
              className="mx-auto w-full max-w-[1280px] flex-1 px-8 py-8"
            >
              {children}
            </main>
          </div>
        </div>

        <Toaster position="top-right" />
       </CommandPaletteProvider>
      </TooltipProvider>
    </LiveRegionProvider>
  );
}
