/**
 * ResumeMergeCard unit tests (Plan 03-09 Task 2).
 *
 * Asserts:
 *   1. Card renders "Resume merge?" headline + three buttons.
 *   2. merge_id is displayed in mono for audit reference.
 *   3. Resume POSTs /api/merge-resume?merge_id=… on click; success toasts.
 *   4. Revert / Cancel are stubs that toast per Plan 11 handoff.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InboxItem } from '@kos/contracts/dashboard';

// --- mocks (hoisted) -----------------------------------------------------

const mockPlainToast = vi.fn();
const mockSuccessToast = vi.fn();
const mockErrorToast = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign(
    (...a: unknown[]) => mockPlainToast(...a),
    {
      success: (...a: unknown[]) => mockSuccessToast(...a),
      error: (...a: unknown[]) => mockErrorToast(...a),
    },
  ),
}));

// Stub fetch globally for this test file.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

import { ResumeMergeCard } from '@/app/(app)/inbox/ResumeMergeCard';

const MERGE_ITEM: InboxItem = {
  id: 'inbox-resume-01',
  kind: 'merge_resume',
  title: 'Resume merge — Maria → Maria Lindqvist',
  preview: 'Merge failed at step 3 of 5. Relations already re-pointed on 2 of 4 sources.',
  bolag: 'tale-forge',
  entity_id: null,
  merge_id: '01HF8X0K6Z0A5W9V3B7C2D1E4F',
  payload: {},
  created_at: '2026-04-23T09:15:00.000Z',
};

describe('ResumeMergeCard', () => {
  beforeEach(() => {
    mockPlainToast.mockReset();
    mockSuccessToast.mockReset();
    mockErrorToast.mockReset();
    fetchMock.mockReset();
  });

  it('renders the "Resume merge?" headline + the three action buttons', () => {
    render(<ResumeMergeCard item={MERGE_ITEM} />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Resume merge?' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows the merge_id in mono for audit reference', () => {
    render(<ResumeMergeCard item={MERGE_ITEM} />);
    expect(screen.getByText('merge_id')).toBeInTheDocument();
    expect(screen.getByText('01HF8X0K6Z0A5W9V3B7C2D1E4F')).toBeInTheDocument();
  });

  it('Resume posts to /api/merge-resume with merge_id query param', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, merge_id: MERGE_ITEM.merge_id }), {
        status: 200,
      }),
    );
    render(<ResumeMergeCard item={MERGE_ITEM} />);

    await user.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/merge-resume');
    expect(String(url)).toContain(
      `merge_id=${encodeURIComponent(MERGE_ITEM.merge_id as string)}`,
    );
    expect((init as RequestInit | undefined)?.method).toBe('POST');
    await waitFor(() => {
      expect(mockSuccessToast).toHaveBeenCalledWith('Merge resumed');
    });
  });

  it('Resume surfaces error toast on upstream failure', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response('upstream 502', { status: 502 }),
    );
    render(<ResumeMergeCard item={MERGE_ITEM} />);

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(mockErrorToast).toHaveBeenCalled();
    });
    const [msg] = mockErrorToast.mock.calls[0] ?? [];
    expect(String(msg)).toMatch(/Resume failed/);
  });

  it('Revert posts action=revert and toasts "Merge reverted" on success (Plan 11 real endpoint)', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, merge_id: MERGE_ITEM.merge_id }), {
        status: 200,
      }),
    );
    render(<ResumeMergeCard item={MERGE_ITEM} />);

    await user.click(screen.getByRole('button', { name: 'Revert' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/merge-resume');
    expect(String(url)).toContain('action=revert');
    await waitFor(() => {
      expect(mockSuccessToast).toHaveBeenCalledWith('Merge reverted');
    });
  });

  it('Cancel posts action=cancel and toasts "Cancelled" on success (Plan 11 real endpoint)', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, merge_id: MERGE_ITEM.merge_id }), {
        status: 200,
      }),
    );
    render(<ResumeMergeCard item={MERGE_ITEM} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/merge-resume');
    expect(String(url)).toContain('action=cancel');
    await waitFor(() => {
      expect(mockSuccessToast).toHaveBeenCalledWith('Cancelled');
    });
  });
});
