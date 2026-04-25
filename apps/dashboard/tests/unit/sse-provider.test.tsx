/**
 * SseProvider + useSseKind — browser-side behaviour (Plan 03-07 Task 2).
 *
 * jsdom has no `EventSource`, so we install a minimal controllable fake on
 * `globalThis.EventSource` before rendering. The fake records instances
 * created so the test can drive onopen / onmessage / onerror and verify:
 *
 *   1. Provider opens a single EventSource('/api/stream') on mount.
 *   2. useSseKind('inbox_item', h) fires h only for matching events.
 *   3. Unsubscribe on unmount — handler no longer receives later events.
 *   4. onerror closes the current ES + schedules a reconnect (new instance).
 *   5. Garbage / schema-invalid messages are dropped silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';

import { SseProvider, useSseKind } from '@/components/system/SseProvider';

// --- EventSource fake ---------------------------------------------------

type ESHandler = ((ev: MessageEvent) => void) | null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ESHandler = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  // Test helpers.
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _message(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  _raw(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
  _error() {
    this.onerror?.();
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
    FakeEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: typeof FakeEventSource })
    .EventSource;
});

function Probe({
  kind,
  onEvent,
}: {
  kind: 'inbox_item' | 'capture_ack' | 'draft_ready' | 'entity_merge' | 'timeline_event';
  onEvent: (ev: unknown) => void;
}) {
  useSseKind(kind, (ev) => {
    onEvent(ev);
  });
  return null;
}

function UnmountableProbe({
  kind,
  onEvent,
  mounted,
}: {
  kind: 'inbox_item';
  onEvent: (ev: unknown) => void;
  mounted: boolean;
}) {
  useEffect(() => {
    /* keep mount tick stable */
  }, [mounted]);
  if (!mounted) return null;
  return <Probe kind={kind} onEvent={onEvent} />;
}

describe('SseProvider', () => {
  it('opens a single EventSource(/api/stream) on mount', () => {
    render(
      <SseProvider>
        <div>child</div>
      </SseProvider>,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/stream');
  });

  it('closes EventSource on unmount', () => {
    const { unmount } = render(
      <SseProvider>
        <div>child</div>
      </SseProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });

  it('useSseKind only fires for matching event kinds', () => {
    const inboxSpy = vi.fn();
    const draftSpy = vi.fn();
    render(
      <SseProvider>
        <Probe kind="inbox_item" onEvent={inboxSpy} />
        <Probe kind="draft_ready" onEvent={draftSpy} />
      </SseProvider>,
    );

    const es = FakeEventSource.instances[0]!;
    act(() => es._open());
    act(() =>
      es._message({
        kind: 'inbox_item',
        id: 'inb_1',
        ts: '2026-04-23T00:00:00.000Z',
      }),
    );
    act(() =>
      es._message({
        kind: 'draft_ready',
        id: 'dr_1',
        ts: '2026-04-23T00:00:01.000Z',
      }),
    );

    expect(inboxSpy).toHaveBeenCalledTimes(1);
    expect(inboxSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inbox_item', id: 'inb_1' }),
    );
    expect(draftSpy).toHaveBeenCalledTimes(1);
    expect(draftSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'draft_ready', id: 'dr_1' }),
    );
  });

  it('unsubscribes the handler when the consuming component unmounts', () => {
    const spy = vi.fn();
    const { rerender } = render(
      <SseProvider>
        <UnmountableProbe kind="inbox_item" onEvent={spy} mounted={true} />
      </SseProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => es._open());
    act(() =>
      es._message({
        kind: 'inbox_item',
        id: 'a',
        ts: '2026-04-23T00:00:00.000Z',
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);

    rerender(
      <SseProvider>
        <UnmountableProbe kind="inbox_item" onEvent={spy} mounted={false} />
      </SseProvider>,
    );

    act(() =>
      es._message({
        kind: 'inbox_item',
        id: 'b',
        ts: '2026-04-23T00:00:02.000Z',
      }),
    );
    // Still 1 — unsubscribed consumer should not see the second event.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reconnects after onerror using exponential backoff', () => {
    render(
      <SseProvider>
        <div>child</div>
      </SseProvider>,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0]!;

    act(() => first._open());
    act(() => first._error());

    expect(first.closed).toBe(true);
    // Reconnect is scheduled via setTimeout; no new instance yet.
    expect(FakeEventSource.instances).toHaveLength(1);

    // Advance past BACKOFF_MIN (500ms).
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toBe('/api/stream');
  });

  it('silently drops malformed / schema-invalid messages', () => {
    const spy = vi.fn();
    render(
      <SseProvider>
        <Probe kind="inbox_item" onEvent={spy} />
      </SseProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => es._open());
    // Broken JSON.
    act(() => es._raw('not-json'));
    // Wrong shape.
    act(() => es._message({ not: 'an-sse-event' }));
    // Matching kind but missing required ts.
    act(() => es._message({ kind: 'inbox_item', id: 'x' }));

    expect(spy).not.toHaveBeenCalled();
  });
});
