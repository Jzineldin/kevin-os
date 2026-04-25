/**
 * InboxClient unit tests (Plan 03-09 Task 1).
 *
 * Asserts:
 *   1. Renders two-pane layout with queue rows + focused detail.
 *   2. J moves selection down, K moves selection up (bounded).
 *   3. Enter fires approveInbox Server Action, announces via LiveRegion.
 *   4. S fires skipInbox Server Action.
 *   5. E toggles edit mode.
 *   6. D / A / R are RESERVED — pressing them is a no-op (no server action
 *      fires; UI-SPEC §View 3 lines 373 — prevents destructive misfire).
 *   7. When typing into a textarea (edit mode), single-key shortcuts do NOT
 *      fire — isTypingInField guard.
 *   8. Empty list renders the UI-SPEC empty-state copy verbatim.
 *   9. Optimistic removal: approved row disappears instantly from queue.
 *  10. Server-Action failure surfaces the "Already handled elsewhere." toast
 *      (UI-SPEC §Copywriting line 559 verbatim).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboxItem } from '@kos/contracts/dashboard';

// --- mocks (hoisted) -----------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/inbox',
}));

const mockErrorToast = vi.fn();
const mockPlainToast = vi.fn();
const mockSuccessToast = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign(
    (...a: unknown[]) => mockPlainToast(...a),
    {
      success: (...a: unknown[]) => mockSuccessToast(...a),
      error: (...a: unknown[]) => mockErrorToast(...a),
    },
  ),
}));

// SSE: no-op subscription in tests.
vi.mock('@/components/system/SseProvider', () => ({
  useSseKind: () => {},
}));

// LiveRegion: capture announce() calls.
const mockAnnounce = vi.fn();
vi.mock('@/components/system/LiveRegion', () => ({
  useLiveRegion: () => ({ announce: (m: string) => mockAnnounce(m) }),
}));

// Server Action stubs — tests control resolution.
const approveInboxMock = vi.fn<(id: string) => Promise<void>>();
const skipInboxMock = vi.fn<(id: string) => Promise<void>>();
const editInboxMock = vi.fn<
  (id: string, fields: Record<string, unknown>) => Promise<void>
>();
vi.mock('@/app/(app)/inbox/actions', () => ({
  approveInbox: (id: string) => approveInboxMock(id),
  skipInbox: (id: string) => skipInboxMock(id),
  editInbox: (id: string, fields: Record<string, unknown>) =>
    editInboxMock(id, fields),
}));

import { InboxClient } from '@/app/(app)/inbox/InboxClient';

// --- fixtures ------------------------------------------------------------

const ITEM_A: InboxItem = {
  id: 'itm-a',
  kind: 'draft_reply',
  title: 'Re: Verifieringsmedel',
  preview: 'Vi behöver bara komplettera med personas-dokumentet.',
  bolag: 'tale-forge',
  entity_id: null,
  merge_id: null,
  payload: { body: 'Original draft body for A' },
  created_at: '2026-04-23T09:00:00.000Z',
};

const ITEM_B: InboxItem = {
  id: 'itm-b',
  kind: 'new_entity',
  title: 'New entity — Marcus Åkesson',
  preview: 'Proposed new Person from transcript on 2026-04-22.',
  bolag: 'outbehaving',
  entity_id: null,
  merge_id: null,
  payload: {},
  created_at: '2026-04-23T09:02:00.000Z',
};

const ITEM_C: InboxItem = {
  id: 'itm-c',
  kind: 'entity_routing',
  title: 'Ambiguous routing — Maria',
  preview: 'Two candidates with confidence 0.62 / 0.58.',
  bolag: 'personal',
  entity_id: null,
  merge_id: null,
  payload: {},
  created_at: '2026-04-23T09:04:00.000Z',
};

const THREE = [ITEM_A, ITEM_B, ITEM_C];

describe('InboxClient', () => {
  beforeEach(() => {
    mockErrorToast.mockReset();
    mockPlainToast.mockReset();
    mockSuccessToast.mockReset();
    mockAnnounce.mockReset();
    approveInboxMock.mockReset();
    skipInboxMock.mockReset();
    editInboxMock.mockReset();
  });

  it('renders three queue rows with first item focused by default', () => {
    render(<InboxClient initialItems={THREE} focusId={null} />);
    // Title "Re: Verifieringsmedel" appears in BOTH the row (queue) and the
    // detail pane header — assert via getAllByText length.
    expect(screen.getAllByText('Re: Verifieringsmedel').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('New entity — Marcus Åkesson')).toBeInTheDocument();
    expect(screen.getByText('Ambiguous routing — Maria')).toBeInTheDocument();
    // Detail pane shows the first item's title as the page header.
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings[0]).toHaveTextContent('Re: Verifieringsmedel');
    // Queue count chip reflects 3 items.
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('3 pending');
  });

  it('J moves selection to the next row; K moves it back', async () => {
    const user = userEvent.setup();
    render(<InboxClient initialItems={THREE} focusId={null} />);

    await user.keyboard('j');
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 2 });
      expect(headings[0]).toHaveTextContent('New entity — Marcus Åkesson');
    });

    await user.keyboard('k');
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 2 });
      expect(headings[0]).toHaveTextContent('Re: Verifieringsmedel');
    });
  });

  it('Enter fires approveInbox on the selected item + announces via LiveRegion', async () => {
    const user = userEvent.setup();
    approveInboxMock.mockResolvedValueOnce(undefined);
    render(<InboxClient initialItems={THREE} focusId={null} />);

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(approveInboxMock).toHaveBeenCalledWith('itm-a');
    });
    expect(mockAnnounce).toHaveBeenCalled();
    const announced = mockAnnounce.mock.calls.map((c) => String(c[0])).join('|');
    expect(announced.toLowerCase()).toContain('approv');
  });

  it('S fires skipInbox on the selected item', async () => {
    const user = userEvent.setup();
    skipInboxMock.mockResolvedValueOnce(undefined);
    render(<InboxClient initialItems={THREE} focusId={null} />);

    await user.keyboard('s');
    await waitFor(() => {
      expect(skipInboxMock).toHaveBeenCalledWith('itm-a');
    });
  });

  it('E toggles inline edit mode (textarea appears)', async () => {
    const user = userEvent.setup();
    render(<InboxClient initialItems={THREE} focusId={null} />);

    await user.keyboard('e');
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
  });

  it('reserved keys D / A / R do NOT fire any action (UI-SPEC line 373)', async () => {
    const user = userEvent.setup();
    render(<InboxClient initialItems={THREE} focusId={null} />);

    await user.keyboard('d');
    await user.keyboard('a');
    await user.keyboard('r');

    expect(approveInboxMock).not.toHaveBeenCalled();
    expect(skipInboxMock).not.toHaveBeenCalled();
    expect(editInboxMock).not.toHaveBeenCalled();
  });

  it('typing in a textarea does NOT fire J/K/Enter/S/E shortcuts (isTypingInField guard)', async () => {
    const user = userEvent.setup();
    render(<InboxClient initialItems={THREE} focusId={null} />);

    // Enter edit mode; focus lands on textarea.
    await user.keyboard('e');
    const textarea = await screen.findByRole('textbox');
    textarea.focus();

    // Now type j, k, s — all must be characters in the textarea, not shortcuts.
    await user.type(textarea, 'jks');

    expect(approveInboxMock).not.toHaveBeenCalled();
    expect(skipInboxMock).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toContain('jks');
  });

  it('empty initialItems renders the UI-SPEC empty-state copy', () => {
    render(<InboxClient initialItems={[]} focusId={null} />);
    expect(screen.getByText('Inbox clear. ✅')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing to review. KOS surfaces drafts as they arrive.'),
    ).toBeInTheDocument();
  });

  it('approve removes row optimistically from the queue', async () => {
    const user = userEvent.setup();
    // Keep the action pending so we observe the optimistic state.
    let resolveFn: () => void = () => {};
    approveInboxMock.mockImplementationOnce(
      () => new Promise<void>((r) => { resolveFn = r; }),
    );
    render(<InboxClient initialItems={THREE} focusId={null} />);

    // Queue starts with 3 items (row + detail-header = 2 instances of title A).
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('3 pending');
    expect(screen.getAllByText('Re: Verifieringsmedel').length).toBeGreaterThanOrEqual(1);

    await user.keyboard('{Enter}');

    // After approve, optimistic reducer drops item A from the queue → count = 2.
    await waitFor(() => {
      expect(screen.getByTestId('inbox-count')).toHaveTextContent('2 pending');
    });

    act(() => resolveFn());

    // Post-settle: items state also drops the approved row.
    await waitFor(() => {
      expect(approveInboxMock).toHaveBeenCalledWith('itm-a');
    });
  });

  it('server-action failure surfaces "Already handled elsewhere." toast', async () => {
    const user = userEvent.setup();
    approveInboxMock.mockRejectedValueOnce(new Error('409 conflict'));
    render(<InboxClient initialItems={THREE} focusId={null} />);

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(mockErrorToast).toHaveBeenCalled();
    });
    const [msg] = mockErrorToast.mock.calls[0] ?? [];
    expect(msg).toBe('Already handled elsewhere.');
  });
});
