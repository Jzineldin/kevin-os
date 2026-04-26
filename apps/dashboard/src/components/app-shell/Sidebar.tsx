'use client';

/**
 * Sidebar — v4 persistent left-dock chrome across every (app)/* route.
 *
 * v4 structure (mockup-v4.html § Sidebar):
 *   1. Brand row — BrandMark + wordmark + pulsing success status dot,
 *      divided from nav by a hairline rail.
 *   2. "Views" group — Today [T] · Inbox [I] + count · Calendar [C] ·
 *      Chat · Health. Each item carries a section tone so the active
 *      rail inherits the route's color.
 *   3. "Entities" group — People / Projects with entity-tone counts.
 *   4. "Quick" group — Search (opens command palette, ⌘K).
 *   5. Bottom-pinned Logout — quiet text-3 default.
 *
 * Fixed width 232px, surface-1 bg, border-right. Overflow: visible so
 * the active NavItem's 3px rail can peek out past the sidebar's own
 * right edge without clipping.
 *
 * Single-key T / I / C shortcuts remain gated via isTypingInField.
 */
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Home,
  Inbox as InboxIcon,
  Calendar,
  MessageSquare,
  Activity,
  Users,
  Folder,
  Search,
  LogOut,
} from 'lucide-react';

import { BrandMark } from './BrandMark';
import { NavItem } from './NavItem';
import { PulseDot } from '@/components/system/PulseDot';
import { Kbd } from '@/components/ui/kbd';
import { useCommandPalette } from '@/components/palette/palette-context';
import { useKeys, isTypingInField } from '@/lib/tinykeys';

export interface SidebarCounts {
  people: number;
  projects: number;
  inbox: number;
}

const ICON_SIZE = 16;

export function Sidebar({
  entityCounts,
}: {
  entityCounts: SidebarCounts;
}) {
  const router = useRouter();
  const { open: openPalette } = useCommandPalette();

  // Memoised so useKeys doesn't re-subscribe on every render.
  const bindings = useMemo(
    () => ({
      t: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        router.push('/today' as never);
      },
      i: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        router.push('/inbox' as never);
      },
      c: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        router.push('/calendar' as never);
      },
    }),
    [router],
  );
  useKeys(bindings);

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* noop — middleware re-check will still redirect */
    }
    router.push('/login');
  }

  return (
    <aside
      data-slot="sidebar"
      // overflow: visible so NavItem's active -left-[14px] rail can
      // render past the aside's padding without being clipped.
      className="w-[232px] shrink-0 border-r border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] flex flex-col py-[22px] px-[14px] gap-[2px] overflow-visible"
    >
      {/* Brand row — hairline rail separates it from the nav groups,
          matching mockup-v4's visual separation. */}
      <div className="flex items-center gap-[11px] pb-[22px] mb-[16px] px-[10px] pt-[4px] border-b border-[color:var(--rail)]">
        <BrandMark size={28} />
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-text)]">
          Kevin OS
        </span>
        <PulseDot tone="success" />
      </div>

      {/* Views group */}
      <NavGroupLabel>Views</NavGroupLabel>
      <nav aria-label="Views" className="flex flex-col gap-[2px]">
        <NavItem
          href="/today"
          icon={<Home size={ICON_SIZE} strokeWidth={1.7} />}
          label="Today"
          kbd="T"
          tone="priority"
          testId="nav-today"
        />
        <NavItem
          href="/inbox"
          icon={<InboxIcon size={ICON_SIZE} strokeWidth={1.7} />}
          label="Inbox"
          kbd="I"
          count={entityCounts.inbox}
          tone="inbox"
          testId="nav-inbox"
        />
        <NavItem
          href="/calendar"
          icon={<Calendar size={ICON_SIZE} strokeWidth={1.7} />}
          label="Calendar"
          kbd="C"
          tone="schedule"
          testId="nav-calendar"
        />
        <NavItem
          href="/integrations-health"
          icon={<Activity size={ICON_SIZE} strokeWidth={1.7} />}
          label="Health"
          tone="channels"
          testId="nav-integrations-health"
        />
        <NavItem
          href="/chat"
          icon={<MessageSquare size={ICON_SIZE} strokeWidth={1.7} />}
          label="Chat"
          tone="drafts"
          testId="nav-chat"
        />
      </nav>

      {/* Entities group */}
      <NavGroupLabel>Entities</NavGroupLabel>
      <nav aria-label="Entities" className="flex flex-col gap-[2px]">
        <NavItem
          href="/entities?type=person"
          icon={<Users size={ICON_SIZE} strokeWidth={1.7} />}
          label="People"
          count={entityCounts.people}
          tone="entities"
          testId="nav-people"
        />
        <NavItem
          href="/entities?type=project"
          icon={<Folder size={ICON_SIZE} strokeWidth={1.7} />}
          label="Projects"
          count={entityCounts.projects}
          tone="entities"
          testId="nav-projects"
        />
      </nav>

      {/* Quick group */}
      <NavGroupLabel>Quick</NavGroupLabel>
      <nav aria-label="Quick actions" className="flex flex-col gap-[2px]">
        <button
          type="button"
          onClick={openPalette}
          data-slot="palette-trigger-sidebar"
          data-testid="sidebar-cmdk"
          className="relative flex items-center gap-[11px] rounded-md px-3 py-2 text-[14px] font-medium text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
        >
          <span
            className="shrink-0 flex items-center justify-center"
            style={{ color: 'var(--color-text-3)', width: 16, height: 16 }}
          >
            <Search size={ICON_SIZE} strokeWidth={1.7} />
          </span>
          <span className="flex-1 text-left">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
      </nav>

      {/* Bottom pinned — logout. Settings entry remains removed per D-06
          (Phase 11 Plan 11-07). Phase 12 may reintroduce. */}
      <div className="mt-auto flex flex-col gap-[2px] pt-4 border-t border-[color:var(--rail)]">
        <button
          type="button"
          onClick={handleLogout}
          data-slot="logout"
          data-testid="sidebar-logout"
          className="flex items-center gap-[11px] rounded-md px-3 py-2 text-[14px] font-medium text-[color:var(--color-text-3)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
        >
          <span
            className="shrink-0 flex items-center justify-center"
            style={{ color: 'var(--color-text-3)', width: 16, height: 16 }}
          >
            <LogOut size={ICON_SIZE} strokeWidth={1.7} />
          </span>
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * Uppercase mono group label — visually subdivides the nav without
 * drawing a line. Matches mockup-v4 § .nav-group.
 */
function NavGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-4 pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-4)]">
      {children}
    </div>
  );
}
