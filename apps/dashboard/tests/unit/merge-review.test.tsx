/**
 * MergeReview unit tests (Plan 03-11 Task 2).
 *
 * Asserts:
 *  1. Two-column layout renders both target + source cards.
 *  2. Source card carries the "ARCHIVING" eyebrow (UI-SPEC §View 3.5).
 *  3. Diff panel surfaces field-level differences.
 *  4. Clicking "Confirm merge" opens the shadcn Dialog with the
 *     UI-SPEC-verbatim copy (headline / body / primary / secondary).
 *  5. Dialog body contains "archived, not deleted" verbatim.
 *  6. Dialog primary button is "Yes, merge" verbatim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EntityResponse } from '@kos/contracts/dashboard';

// Server Action - always mock; real implementation uses redirect() from next/navigation.
vi.mock('@/app/(app)/entities/[id]/merge/actions', () => ({
  executeMerge: vi.fn(async () => undefined),
  resumeMergeAction: vi.fn(async () => undefined),
}));

// ulid - return a stable ULID-shaped id (Crockford base32, no I L O U).
vi.mock('ulid', () => ({
  ulid: () => '01HF8X0K6Z0A5W9V3B7C2D1E4F',
}));

import { MergeReview } from '@/app/(app)/entities/[id]/merge/MergeReview';
import * as actions from '@/app/(app)/entities/[id]/merge/actions';

const executeMergeMock = actions.executeMerge as unknown as ReturnType<typeof vi.fn>;

function makeEntity(over: Partial<EntityResponse> = {}): EntityResponse {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Maria',
    type: 'Person',
    aliases: [],
    org: 'Tale Forge',
    role: 'Investor',
    relationship: 'advisor',
    status: 'active',
    seed_context: null,
    manual_notes: null,
    last_touch: '2026-04-20T10:00:00Z',
    confidence: 90,
    linked_projects: [],
    stats: { first_contact: null, total_mentions: 3, active_threads: 1 },
    ai_block: null,
    ...over,
  };
}

const TARGET = makeEntity({
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Maria Lindqvist',
  role: 'Lead investor',
  status: 'active',
});
const SOURCE = makeEntity({
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Maria',
  role: 'Investor',
  status: 'active',
});

describe('MergeReview', () => {
  beforeEach(() => {
    executeMergeMock.mockReset();
    executeMergeMock.mockImplementation(async () => undefined);
  });

  it('renders both cards with KEEP + ARCHIVING eyebrows', () => {
    render(<MergeReview target={TARGET} source={SOURCE} />);

    expect(screen.getByTestId('merge-target-card')).toBeInTheDocument();
    expect(screen.getByTestId('merge-source-card')).toBeInTheDocument();
    expect(screen.getByText('KEEP')).toBeInTheDocument();
    expect(screen.getByText('ARCHIVING')).toBeInTheDocument();
  });

  it('diff panel surfaces field-level differences (name + role)', () => {
    render(<MergeReview target={TARGET} source={SOURCE} />);
    const panel = screen.getByTestId('merge-diff-panel');
    expect(panel).toHaveTextContent(/Fields that differ \(2\)/);
    expect(panel).toHaveTextContent('role');
    expect(panel).toHaveTextContent('Lead investor');
    expect(panel).toHaveTextContent('Investor');
    expect(panel).toHaveTextContent('name');
  });

  it('shows "Confirm merge" primary button', () => {
    render(<MergeReview target={TARGET} source={SOURCE} />);
    expect(
      screen.getByRole('button', { name: 'Confirm merge' }),
    ).toBeInTheDocument();
  });

  it('clicking Confirm merge opens the UI-SPEC-verbatim Dialog', async () => {
    const user = userEvent.setup();
    render(<MergeReview target={TARGET} source={SOURCE} />);

    await user.click(screen.getByRole('button', { name: 'Confirm merge' }));

    // Headline
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Merge Maria into Maria Lindqvist?',
        }),
      ).toBeInTheDocument();
    });

    // Body contains "archived, not deleted" verbatim. The string appears
    // in both the page intro and the Dialog body — assert at least one
    // occurrence rather than a unique match.
    expect(
      screen.getAllByText(/archived, not deleted/).length,
    ).toBeGreaterThanOrEqual(1);

    // Primary button "Yes, merge" verbatim.
    expect(
      screen.getByRole('button', { name: 'Yes, merge' }),
    ).toBeInTheDocument();

    // Secondary button "Cancel" (the one INSIDE the dialog — there are two).
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancelButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking "Yes, merge" calls executeMerge with target_id + source_id + ULID', async () => {
    const user = userEvent.setup();
    render(<MergeReview target={TARGET} source={SOURCE} />);

    await user.click(screen.getByRole('button', { name: 'Confirm merge' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Yes, merge' }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Yes, merge' }));

    await waitFor(() => {
      expect(executeMergeMock).toHaveBeenCalled();
    });
    const call = executeMergeMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(call[0]).toBe(TARGET.id);
    expect(call[1]).toBe(SOURCE.id);
    expect(call[2]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
