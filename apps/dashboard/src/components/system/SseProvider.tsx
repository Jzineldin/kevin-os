'use client';

/**
 * SseProvider + useSseKind — client-side fan-out for the dashboard's
 * Server-Sent Events stream (Plan 03-07 Task 2).
 *
 * Mounted inside the authenticated (app)/layout tree. Opens one
 * `EventSource('/api/stream')` per tab, parses + validates every payload
 * against the shared `SseEventSchema`, and pushes each event to the set of
 * subscribers registered for its `kind`.
 *
 * View components in Plans 03-08 / 03-09 / 03-10 call:
 *
 *   useSseKind('inbox_item', (ev) => router.refresh());
 *
 * Design rules (03-UI-SPEC §Copywriting + §Accessibility):
 *   - NO user-facing message on reconnect — per the copy table "Error —
 *     SSE stream dropped" entry: *silent — auto-reconnect*. The provider
 *     only exposes a `status` channel so a small ConnectionStatus dot in
 *     the Topbar can surface the state if a future plan wants it.
 *   - Handlers may throw; the provider isolates them so one bad subscriber
 *     never knocks out the others.
 *
 * Why a custom event bus instead of addEventListener('kind')?
 *   The SSE server emits each payload as `data: <json>\n\n` (no per-kind
 *   `event:` label) so `EventSource.onmessage` is the single ingress.
 *   Dispatch by `kind` field after schema validation.
 *
 * Reconnect behaviour (R-12):
 *   Browser's native EventSource reconnect is a 3s fixed interval — our
 *   /api/stream emits `retry: 500` to override that to 500ms. On top of
 *   that, when WE observe an `onerror` we close + schedule a reconnect
 *   using our own 500ms -> 60s exponential backoff (nextBackoff). This
 *   handles the case where the server returns a non-200 response that the
 *   browser won't retry automatically.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import type { SseEvent, SseEventKind } from '@kos/contracts/dashboard';

import {
  BACKOFF_MIN,
  nextBackoff,
  parseMessage,
  type SseStatus,
} from '@/lib/sse-client';

type Handler<K extends SseEventKind = SseEventKind> = (
  ev: Extract<SseEvent, { kind: K }>,
) => void;

type SubscribeFn = (kind: SseEventKind, handler: Handler) => () => void;

type Ctx = {
  subscribe: SubscribeFn;
  status: SseStatus;
  /** Unix ms of the last successful `onopen` — null until first connect. */
  lastConnectedAt: number | null;
};

const defaultCtx: Ctx = {
  subscribe: () => () => {},
  status: 'idle',
  lastConnectedAt: null,
};

const SseCtx = createContext<Ctx>(defaultCtx);

export function useSse(): Ctx {
  return useContext(SseCtx);
}

/**
 * Register `handler` to be invoked for every SSE event whose `kind`
 * matches. Subscription is scoped to the component — it auto-removes on
 * unmount. Multiple subscribers per kind are allowed and each receives
 * every matching event.
 */
export function useSseKind<K extends SseEventKind>(
  kind: K,
  handler: Handler<K>,
): void {
  const { subscribe } = useSse();
  // Stable ref so the effect doesn't resubscribe on every render.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const trampoline: Handler = (ev) => {
      if (ev.kind !== kind) return;
      (handlerRef.current as unknown as (ev: SseEvent) => void)(ev);
    };
    return subscribe(kind, trampoline);
  }, [kind, subscribe]);
}

export function SseProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SseStatus>('idle');
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const subsRef = useRef<Map<SseEventKind, Set<Handler>>>(new Map());
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef<number>(BACKOFF_MIN);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const subscribe = useCallback<SubscribeFn>((kind, handler) => {
    const map = subsRef.current;
    let set = map.get(kind);
    if (!set) {
      set = new Set();
      map.set(kind, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
        return;
      }
      setStatus('connecting');
      const es = new EventSource('/api/stream');
      esRef.current = es;

      es.onopen = () => {
        if (cancelled) return;
        backoffRef.current = BACKOFF_MIN;
        setStatus('open');
        setLastConnectedAt(Date.now());
      };

      es.onmessage = (e) => {
        const ev = parseMessage(e.data);
        if (!ev) return;
        const subs = subsRef.current.get(ev.kind);
        if (!subs || subs.size === 0) return;
        // Copy first so a handler that unsubscribes mid-dispatch doesn't
        // mutate the set we're iterating.
        for (const h of [...subs]) {
          try {
            h(ev);
          } catch (err) {
            // Never let one broken subscriber kill the others.
            console.warn('[SseProvider] subscriber threw:', err);
          }
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        setStatus('closed');
        try {
          es.close();
        } catch {
          /* ignore */
        }
        const wait = backoffRef.current;
        backoffRef.current = nextBackoff(backoffRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          if (!cancelled) connect();
        }, wait);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try {
        esRef.current?.close();
      } catch {
        /* ignore */
      }
      esRef.current = null;
    };
  }, []);

  const value = useMemo<Ctx>(
    () => ({ subscribe, status, lastConnectedAt }),
    [subscribe, status, lastConnectedAt],
  );

  return <SseCtx.Provider value={value}>{children}</SseCtx.Provider>;
}
