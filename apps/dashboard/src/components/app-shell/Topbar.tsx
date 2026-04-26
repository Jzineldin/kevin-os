'use client';

/**
 * Topbar — v4 persistent 56px top chrome across every (app)/* route.
 *
 * v4 structure (mockup-v4.html § Topbar):
 *   - Left: breadcrumb. Non-current segments in text-4, current segment
 *     in a 14% sect-priority filled pill with 28% border for strong
 *     visual anchoring.
 *   - Center: flex-1 spacer.
 *   - 320px search trigger (opens command palette, ⌘K Kbd badge).
 *   - "New capture" primary button — sect-priority filled with a
 *     soft drop-shadow for the single primary action on the page.
 *   - UserMenu (unchanged).
 *
 * Sticky top:0 with backdrop-blur so content scrolls underneath rather
 * than jumping. Border-bottom is a hard 1px against surface-0 content.
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
  chat: 'Chat',
  'integrations-health': 'Integrations Health',
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
      className="sticky top-0 z-10 flex h-[56px] min-h-[56px] shrink-0 items-center gap-[18px] border-b border-[color:var(--color-border)] px-8 backdrop-blur"
      style={{
        background:
          'color-mix(in srgb, var(--color-surface-1) 85%, transparent)',
      }}
    >
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-[10px] text-[13px]"
      >
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={i} className="flex items-center gap-[10px]">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className="text-[color:var(--color-text-4)]"
                >
                  /
                </span>
              )}
              {isLast ? (
                <span
                  data-slot="crumb-current"
                  className="rounded-[4px] border px-[10px] py-[3px] font-semibold text-[color:var(--color-text)]"
                  style={{
                    background:
                      'color-mix(in srgb, var(--color-sect-priority) 14%, transparent)',
                    borderColor:
                      'color-mix(in srgb, var(--color-sect-priority) 28%, transparent)',
                  }}
                >
                  {c}
                </span>
              ) : (
                <span className="text-[color:var(--color-text-4)]">{c}</span>
              )}
            </span>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Search trigger → opens command palette */}
      <button
        type="button"
        onClick={openPalette}
        data-slot="palette-trigger-topbar"
        data-testid="topbar-cmdk"
        aria-label="Search entities and views"
        className="flex h-[34px] min-w-[320px] items-center gap-[10px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-3 text-[13px] text-[color:var(--color-text-3)] hover:border-[color:var(--color-border-hover)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
      >
        <Search size={14} strokeWidth={1.7} />
        <span className="flex-1 text-left">Search entities, views…</span>
        <Kbd>⌘K</Kbd>
      </button>

      {/* New capture — primary. Sect-priority fill + drop shadow. */}
      <button
        type="button"
        onClick={emitNewCapture}
        data-slot="new-capture"
        data-testid="topbar-new-capture"
        className="inline-flex h-[34px] items-center gap-[7px] rounded-md px-[14px] text-[13px] font-semibold text-white transition-all duration-[var(--transition-fast)] ease-[var(--ease)]"
        style={{
          background: 'var(--color-sect-priority)',
          borderColor: 'color-mix(in srgb, var(--color-sect-priority) 60%, #000)',
          boxShadow:
            '0 4px 14px -6px color-mix(in srgb, var(--color-sect-priority) 70%, transparent), inset 0 1px 0 rgba(255,255,255,0.14)',
        }}
      >
        <Plus size={14} strokeWidth={2.4} />
        <span>New capture</span>
      </button>

      <UserMenu />
    </header>
  );
}
