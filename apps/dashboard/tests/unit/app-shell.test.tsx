/**
 * App-shell unit tests — covers the Sidebar invariants enumerated in the
 * Plan 03-06 Task 1 acceptance criteria, updated for Phase 11 Plan 11-07
 * (button audit; Settings entry removed; Chat link enabled):
 *
 *   1. Sidebar renders under a CommandPaletteProvider.
 *   2. NavItem active state applies inline `transition: none` (motion rule
 *      8 — instant toggle).
 *   3. (Phase 11) Chat item is enabled — no longer disabled.
 *   4. (Phase 11) Settings nav entry has been removed.
 *   5. The sidebar width class w-[220px] is present (UI-SPEC §Sidebar).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub next/navigation before importing the component tree.
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/today',
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
}));

// Stub tinykeys so we don't have to simulate real keyboard events.
vi.mock('tinykeys', () => ({
  tinykeys: () => () => {},
}));

import { Sidebar } from '@/components/app-shell/Sidebar';
import { CommandPaletteProvider } from '@/components/palette/CommandPalette';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderSidebar() {
  return render(
    <TooltipProvider>
      <CommandPaletteProvider>
        <Sidebar entityCounts={{ people: 12, projects: 5, inbox: 3 }} />
      </CommandPaletteProvider>
    </TooltipProvider>,
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it('renders brand + all top-level nav items', () => {
    renderSidebar();
    expect(screen.getByText('Kevin OS')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('People')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    // Phase 11 Plan 11-07: Settings nav entry removed (D-06).
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  it('applies 220px width on the aside element', () => {
    renderSidebar();
    const el = document.querySelector('[data-slot="sidebar"]');
    expect(el).not.toBeNull();
    expect(el!.className).toContain('w-[220px]');
  });

  it('marks the active Today route with instant transition (motion rule 8)', () => {
    renderSidebar();
    // Today is the active route (usePathname mock returns "/today").
    // Locate the active nav row via data-slot + data-active.
    const active = document.querySelector(
      '[data-slot="nav-item"][data-active="true"]',
    ) as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active!.textContent).toContain('Today');
    // Inline style sets transition: none for the active class swap.
    expect(active!.getAttribute('style') ?? '').toMatch(/transition:\s*none/);
  });

  it('renders the Chat item enabled (Phase 11 Plan 11-07 flipped from disabled)', () => {
    renderSidebar();
    // No nav-item should remain in the disabled state after Phase 11
    // Plan 11-07: Chat link is wired to /chat shell; Settings is removed.
    const disabledNode = document.querySelector(
      '[data-slot="nav-item"][data-disabled="true"]',
    );
    expect(disabledNode).toBeNull();

    // The Chat link itself renders with data-testid="nav-chat" and a real
    // href, not a span placeholder.
    const chatLink = document.querySelector(
      '[data-testid="nav-chat"]',
    ) as HTMLAnchorElement | null;
    expect(chatLink).not.toBeNull();
    expect(chatLink!.textContent).toContain('Chat');
    expect(chatLink!.getAttribute('href')).toBe('/chat');
  });

  it('renders keyboard badges (Kbd) for T / I / C', () => {
    renderSidebar();
    // Kbd is rendered as a <kbd> element with font-mono text.
    const tBadge = Array.from(document.querySelectorAll('kbd')).find(
      (k) => k.textContent?.trim() === 'T',
    );
    const iBadge = Array.from(document.querySelectorAll('kbd')).find(
      (k) => k.textContent?.trim() === 'I',
    );
    const cBadge = Array.from(document.querySelectorAll('kbd')).find(
      (k) => k.textContent?.trim() === 'C',
    );
    expect(tBadge).toBeDefined();
    expect(iBadge).toBeDefined();
    expect(cBadge).toBeDefined();
  });

  it('renders the inbox count when > 0', () => {
    renderSidebar();
    // count={3} should render the numeric badge inside the Inbox NavItem.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument(); // People count
    expect(screen.getByText('5')).toBeInTheDocument(); // Projects count
  });
});
