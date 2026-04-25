'use client';

/**
 * Topbar — persistent 52px top chrome across every (app)/* route.
 *
 * Per 03-UI-SPEC §Topbar:
 *   - Left: breadcrumb derived from pathname segments, `/` separator in
 *     --color-text-4.
 *   - Center: flex-1 spacer.
 *   - 280px search trigger (opens command palette), with ⌘K Kbd badge.
 *   - Right: "New capture" button (dispatches a custom event so any view
 *     can focus its composer — Plan 3-Wave3 wires listeners), UserMenu.
 */
import { usePathname } from 'next/navigation';
import { Search, Plus } from 'lucide-react';

import { UserMenu } from './UserMenu';
import { Kbd } from '@/components/ui/kbd';
import { useCommandPalette } from '@/components/palette/palette-context';

// Mapping of first-segment → human label. Extra segments stay verbatim.
const SEGMENT_LABEL: Record<string, string> = {
  today: 'Today',
  inbox: 'Inbox',
  calendar: 'Calendar',
  entities: 'Entities',
  settings: 'Settings',
};

function buildCrumbs(pathname: string | null): string[] {
  if (!pathname || pathname === '/') return ['Today'];
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return ['Today'];
  return segments.map((s, i) =>
    i === 0 ? (SEGMENT_LABEL[s] ?? s) : decodeURIComponent(s),
  );
}

function emitNewCapture() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kos:new-capture'));
}

export function Topbar() {
  const pathname = usePathname();
  const { open: openPalette } = useCommandPalette();
  const crumbs = buildCrumbs(pathname);

  return (
    <header
      data-slot="topbar"
      className="flex h-[52px] min-h-[52px] shrink-0 items-center gap-4 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] px-6"
    >
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-2 text-[14px] font-medium text-[color:var(--color-text)]"
      >
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && (
              <span
                aria-hidden="true"
                className="text-[color:var(--color-text-4)]"
              >
                /
              </span>
            )}
            <span
              className={
                i === crumbs.length - 1
                  ? 'text-[color:var(--color-text)]'
                  : 'text-[color:var(--color-text-3)]'
              }
            >
              {c}
            </span>
          </span>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Search trigger → opens command palette */}
      <button
        type="button"
        onClick={openPalette}
        data-slot="palette-trigger-topbar"
        aria-label="Search entities and views"
        className="flex h-8 w-[280px] items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-3 text-[13px] text-[color:var(--color-text-3)] hover:border-[color:var(--color-border-hover)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
      >
        <Search size={14} />
        <span className="flex-1 text-left">Search entities, views…</span>
        <Kbd>⌘K</Kbd>
      </button>

      {/* New capture */}
      <button
        type="button"
        onClick={emitNewCapture}
        data-slot="new-capture"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-3 text-[13px] text-[color:var(--color-text-2)] hover:border-[color:var(--color-border-hover)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
      >
        <Plus size={14} />
        <span>New capture</span>
      </button>

      <UserMenu />
    </header>
  );
}
