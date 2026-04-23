/**
 * CommandPalette unit tests — covers the Plan 03-06 Task 2 behaviours
 * enumerated in the acceptance criteria:
 *
 *   1. ⌘K / Ctrl+K opens + toggles the dialog (UI-SPEC §View 5).
 *   2. Empty state copy is "No match. Type to search entities and
 *      commands." verbatim.
 *   3. Default View + Action items are rendered on open (Today / Inbox /
 *      Calendar / Settings / Logout).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  usePathname: () => '/today',
}));

// Mock the /api/palette-entities fetch — return an empty entity list so
// only Views + Actions render. This also exercises the T-3-06-04 no-
// re-fetch guard (we only respond once; if the code called fetch twice,
// the assertion below would flag it).
const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
  async () =>
    new Response(JSON.stringify({ entities: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
vi.stubGlobal('fetch', fetchSpy);

import { CommandPaletteProvider } from '@/components/palette/CommandPalette';

function renderProvider() {
  return render(
    <CommandPaletteProvider>
      <button type="button">outside content</button>
    </CommandPaletteProvider>,
  );
}

function pressMetaK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
    );
  });
}

function pressCtrlK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
    );
  });
}

describe('CommandPalette', () => {
  beforeEach(() => {
    mockPush.mockReset();
    fetchSpy.mockClear();
  });

  it('opens on ⌘K and closes on a second ⌘K (toggle)', () => {
    renderProvider();

    // Dialog not present before first keypress.
    expect(screen.queryByPlaceholderText(/Search or type a command/i)).toBeNull();

    pressMetaK();
    expect(
      screen.getByPlaceholderText('Search or type a command…'),
    ).toBeInTheDocument();

    pressMetaK();
    expect(screen.queryByPlaceholderText(/Search or type a command/i)).toBeNull();
  });

  it('also opens on Ctrl+K (Windows/Linux)', () => {
    renderProvider();
    pressCtrlK();
    expect(
      screen.getByPlaceholderText('Search or type a command…'),
    ).toBeInTheDocument();
  });

  it('renders Views + Actions groups with UI-SPEC copy on open', async () => {
    renderProvider();
    pressMetaK();

    // Let React flush the post-mount fetch + state update.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  it('empty state copy matches UI-SPEC verbatim', () => {
    renderProvider();
    pressMetaK();

    // cmdk shows <CommandEmpty> when no items match the query. Type
    // gibberish so no group item matches.
    const input = screen.getByPlaceholderText(
      'Search or type a command…',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'zzzzzz-no-match-zzzzzz' },
    });

    expect(
      screen.getByText('No match. Type to search entities and commands.'),
    ).toBeInTheDocument();
  });

  it('selecting Today routes to /today and closes the palette', () => {
    renderProvider();
    pressMetaK();

    fireEvent.click(screen.getByText('Today'));

    expect(mockPush).toHaveBeenCalledWith('/today');
    // After selection the dialog unmounts its content.
    expect(screen.queryByPlaceholderText(/Search or type a command/i)).toBeNull();
  });

  it('fetches entities at most once across open/close/open cycles', async () => {
    renderProvider();
    pressMetaK();
    await act(async () => {
      await Promise.resolve();
    });
    pressMetaK(); // close
    pressMetaK(); // reopen
    await act(async () => {
      await Promise.resolve();
    });

    const paletteFetches = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/api/palette-entities'),
    );
    expect(paletteFetches.length).toBe(1);
  });
});
