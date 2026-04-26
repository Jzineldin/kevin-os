'use client';

/**
 * Sidebar — persistent left-dock chrome across every (app)/* route.
 * Structure mirrors 03-UI-SPEC.md §Sidebar verbatim:
 *
 *   1. Brand row (BrandMark + wordmark + pulsing success status dot)
 *   2. Views group: Today [T] · Inbox [I] + count · Calendar [C] · Health · Chat
 *      (Phase 11 Plan 11-07: Chat enabled, Settings entry removed per D-06)
 *   3. Entities label + People / Projects (with counts)
 *   4. Quick label + Search trigger (opens command palette, ⌘K badge)
 *   5. Bottom-pinned: Logout
 *
 * Fixed width 220px, --color-surface-1 background, border-right.
 *
 * T / I / C single-key shortcuts fire only when the user is not typing into
 * an input/textarea (isTypingInField guard).
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
      className="w-[220px] shrink-0 border-r border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] flex flex-col py-[18px] px-3 gap-1"
    >
      {/* Brand row */}
      <div className="flex items-center gap-2 pl-[10px] pb-[18px]">
        <BrandMark />
        <span className="text-[14px] font-semibold text-[color:var(--color-text)]">
          Kevin OS
        </span>
        <PulseDot tone="success" />
      </div>

      {/* Views group */}
      <nav aria-label="Views" className="flex flex-col gap-1">
        <NavItem
          href="/today"
          icon={<Home size={14} />}
          label="Today"
          kbd="T"
          testId="nav-today"
        />
        <NavItem
          href="/inbox"
          icon={<InboxIcon size={14} />}
          label="Inbox"
          kbd="I"
          count={entityCounts.inbox}
          testId="nav-inbox"
        />
        <NavItem
          href="/calendar"
          icon={<Calendar size={14} />}
          label="Calendar"
          kbd="C"
          testId="nav-calendar"
        />
        {/* Phase 11 Plan 11-06 — D-07 channel-health surface entry.
            data-testid="nav-integrations-health" passes through NavItem
            for the Phase 11 button-audit Playwright spec. */}
        <NavItem
          href="/integrations-health"
          icon={<Activity size={14} />}
          label="Health"
          testId="nav-integrations-health"
        />
        {/* Phase 11 Plan 11-07 — Chat link enabled. Backend ships with
            Phase 11-ter; this link points at the visual-only /chat shell
            so the global ChatBubble has a deep-link counterpart. */}
        <NavItem
          href="/chat"
          icon={<MessageSquare size={14} />}
          label="Chat"
          testId="nav-chat"
        />
      </nav>

      {/* Entities section */}
      <div className="mt-4 px-[10px] text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]">
        Entities
      </div>
      <nav aria-label="Entities" className="flex flex-col gap-1">
        <NavItem
          href="/entities?type=person"
          icon={<Users size={14} />}
          label="People"
          count={entityCounts.people}
          testId="nav-people"
        />
        <NavItem
          href="/entities?type=project"
          icon={<Folder size={14} />}
          label="Projects"
          count={entityCounts.projects}
          testId="nav-projects"
        />
      </nav>

      {/* Quick section */}
      <div className="mt-4 px-[10px] text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]">
        Quick
      </div>
      <nav aria-label="Quick actions" className="flex flex-col gap-1">
        <button
          type="button"
          onClick={openPalette}
          data-slot="palette-trigger-sidebar"
          data-testid="sidebar-cmdk"
          className="flex items-center gap-[10px] rounded-md px-[10px] py-[6px] text-[13px] text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-hover)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </nav>

      {/* Bottom pinned — Settings entry removed in Phase 11 Plan 11-07
          (D-06: no half-implemented buttons). Phase 12 reintroduces. */}
      <div className="mt-auto flex flex-col gap-1">
        <button
          type="button"
          onClick={handleLogout}
          data-slot="logout"
          data-testid="sidebar-logout"
          className="flex items-center gap-[10px] rounded-md px-[10px] py-[6px] text-[13px] text-[color:var(--color-text-3)] hover:bg-[color:var(--color-surface-hover)] hover:text-[color:var(--color-text-2)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]"
        >
          <LogOut size={14} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
