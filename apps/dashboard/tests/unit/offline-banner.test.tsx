/**
 * Plan 03-12 Task 1 — OfflineBanner unit test.
 *
 * Contract (03-UI-SPEC §Copywriting "Offline banner (PWA)" verbatim):
 *   "Offline · last synced {relative time} · some actions disabled"
 *
 * Behavior (03-12-PLAN.md Task 1 behavior):
 *   - Mounts hidden when navigator.onLine === true.
 *   - Renders banner when navigator.onLine === false OR an 'offline' event fires.
 *   - Auto-hides on 'online' event.
 *   - No retry button (per §Copywriting — "reconnects automatically").
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { OfflineBanner } from '@/components/system/OfflineBanner';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OfflineBanner', () => {
  test('renders nothing when navigator is online', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Offline/)).toBeNull();
  });

  test('renders offline copy when navigator is offline on mount', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<OfflineBanner />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(/^Offline · last synced .+ · some actions disabled$/);
    // No retry button — reconnection is automatic.
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('appears on offline event and disappears on online event', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status').textContent).toContain('Offline');
    expect(screen.getByRole('status').textContent).toContain('some actions disabled');

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
