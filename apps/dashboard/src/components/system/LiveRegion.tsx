'use client';

/**
 * LiveRegionProvider — a single visually-hidden `<div aria-live="polite">`
 * for SSE-driven announcements (03-UI-SPEC §Accessibility rule 12). Plan
 * 03-07 wires the SSE consumer; this provider only exposes the announce()
 * surface so any component can push a message without caring about how
 * it's surfaced.
 *
 * The `msg` state is cleared before being re-set on every announce() call
 * so assistive tech treats consecutive identical messages as new events
 * (screen readers don't re-announce unchanged aria-live content).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

type LiveRegionCtx = { announce: (msg: string) => void };

const Ctx = createContext<LiveRegionCtx>({ announce: () => {} });

export function LiveRegionProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState('');

  const announce = useCallback((m: string) => {
    // Clear, then set on next tick so repeated identical messages fire.
    setMsg('');
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setMsg(m), 10);
    } else {
      setMsg(m);
    }
  }, []);

  const value = useMemo<LiveRegionCtx>(() => ({ announce }), [announce]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-slot="live-region"
      >
        {msg}
      </div>
    </Ctx.Provider>
  );
}

export const useLiveRegion = () => useContext(Ctx);
