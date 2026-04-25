'use client';

/**
 * OfflineBanner — Plan 03-12 Task 1 (UI-05 PWA offline state).
 *
 * Renders a fixed-top banner when the browser reports offline. Copy is
 * verbatim from 03-UI-SPEC §Copywriting "Offline banner (PWA)":
 *
 *   "Offline · last synced {relative time} · some actions disabled"
 *
 * Behaviour notes:
 *  - Mount decides initial state from navigator.onLine (SSR-safe default = true).
 *  - Subscribes to window 'online' / 'offline' events for live updates.
 *  - Stamps `lastSync` whenever connectivity flips to online OR the component
 *    first mounts while online. When offline on mount, `lastSync` is null and
 *    the relative time reads "never" — honest, not aspirational.
 *  - No retry button, no toast — reconnection is automatic per the UI copy
 *    table ("silent auto-reconnect"). See 03-UI-SPEC §Copywriting "Error —
 *    SSE stream dropped".
 *  - Token-driven colors via CSS variables so the gsd-ui-auditor passes the
 *    "no hardcoded hex" lint (see 03-UI-SPEC §"Mockup-to-Code Fidelity Rules").
 */
import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

export function OfflineBanner() {
  // SSR-safe default: assume online. The effect reconciles to the real
  // navigator.onLine on first client render.
  const [online, setOnline] = useState(true);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    const isOnline =
      typeof navigator !== 'undefined' ? navigator.onLine : true;
    setOnline(isOnline);
    if (isOnline) {
      // First connectivity-confirmed render stamps last-sync now.
      setLastSync(new Date());
    }

    const onOnline = () => {
      setOnline(true);
      setLastSync(new Date());
    };
    const onOffline = () => setOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (online) return null;

  const relative = lastSync
    ? formatDistanceToNow(lastSync, { addSuffix: true })
    : 'never';

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-4 py-2 text-center text-[12px] text-[color:var(--color-warning)]"
    >
      Offline · last synced {relative} · some actions disabled
    </div>
  );
}
