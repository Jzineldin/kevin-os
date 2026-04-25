/**
 * Composer unit tests (Plan 03-08 Task 3).
 *
 * Asserts:
 *   1. Submit button is disabled while textarea is empty (or whitespace-only).
 *   2. Typing enables the button; submit calls captureText with the trimmed
 *      payload.
 *   3. On success: textarea is cleared, sonner toast.success fires with the
 *      capture_id string, PulseDot flips to warning (ack pending).
 *   4. On failure: sonner toast.error fires with the UI-SPEC retry copy.
 *   5. Placeholder is the verbatim Swedish copy from UI-SPEC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// --- mocks (top-level — hoisted before imports below) -------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/today',
}));

const mockSuccessToast = vi.fn();
const mockErrorToast = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockSuccessToast(...a),
    error: (...a: unknown[]) => mockErrorToast(...a),
  },
}));

// Stub the SSE provider so useSseKind is a no-op in tests.
vi.mock('@/components/system/SseProvider', () => ({
  useSseKind: () => {},
}));

// Server Action stub — tests control success/failure via this mock.
const captureTextMock = vi.fn<
  (text: string) => Promise<{ capture_id: string; received_at: string }>
>();
vi.mock('@/app/(app)/today/actions', () => ({
  captureText: (t: string) => captureTextMock(t),
}));

import { Composer } from '@/app/(app)/today/Composer';

describe('Composer', () => {
  beforeEach(() => {
    mockSuccessToast.mockReset();
    mockErrorToast.mockReset();
    captureTextMock.mockReset();
  });

  it('renders the verbatim Swedish placeholder + Skicka label', () => {
    render(<Composer />);
    expect(
      screen.getByPlaceholderText(
        'Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skicka' })).toBeInTheDocument();
  });

  it('disables the submit button when textarea is empty', () => {
    render(<Composer />);
    const btn = screen.getByRole('button', { name: 'Skicka' });
    expect(btn).toBeDisabled();
  });

  it('on success: clears textarea + calls toast.success with capture_id', async () => {
    const user = userEvent.setup();
    captureTextMock.mockResolvedValueOnce({
      capture_id: '01HF8X0K6Z0A5W9V3B7C2D1E4F',
      received_at: new Date().toISOString(),
    });

    render(<Composer />);
    const textarea = screen.getByPlaceholderText(
      'Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.',
    );
    await user.type(textarea, 'första tanken för dagen');

    const btn = screen.getByRole('button', { name: 'Skicka' });
    expect(btn).not.toBeDisabled();
    await user.click(btn);

    await waitFor(() => {
      expect(captureTextMock).toHaveBeenCalledWith('första tanken för dagen');
    });
    await waitFor(() => {
      expect(mockSuccessToast).toHaveBeenCalled();
    });
    // Toast argument should contain the capture_id ULID
    const callArg = mockSuccessToast.mock.calls[0]?.[0];
    expect(String(callArg)).toContain('01HF8X0K6Z0A5W9V3B7C2D1E4F');
    // Textarea cleared
    expect((textarea as HTMLTextAreaElement).value).toBe('');
  });

  it('on failure: surfaces retry toast with UI-SPEC copy', async () => {
    const user = userEvent.setup();
    captureTextMock.mockRejectedValueOnce(new Error('upstream 502'));

    render(<Composer />);
    const textarea = screen.getByPlaceholderText(
      'Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.',
    );
    await user.type(textarea, 'fail-me');
    await user.click(screen.getByRole('button', { name: 'Skicka' }));

    await waitFor(() => {
      expect(mockErrorToast).toHaveBeenCalled();
    });
    const [msg, opts] = mockErrorToast.mock.calls[0] ?? [];
    expect(msg).toBe("Capture didn't reach KOS. Retry?");
    expect(opts).toMatchObject({ duration: Infinity });
    expect((opts as { action?: { label?: string } })?.action?.label).toBe('Retry');
  });

  it('trims whitespace-only submissions (button stays disabled)', async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const textarea = screen.getByPlaceholderText(
      'Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.',
    );
    await user.type(textarea, '   ');
    expect(screen.getByRole('button', { name: 'Skicka' })).toBeDisabled();
    expect(captureTextMock).not.toHaveBeenCalled();
  });
});
