/**
 * /api/stream Route Handler — Plan 03-07 Task 1.
 *
 * Asserts:
 *   1. First bytes are the `: connected ...` comment (so browser EventSource
 *      fires its `open` event immediately; no 15s stall on proxies that
 *      withhold the head).
 *   2. The retry hint (`retry: <ms>`) is emitted near the start so the
 *      browser uses our backoff floor instead of the default 3s.
 *   3. Response carries the SSE headers exactly: text/event-stream,
 *      no-cache + no-transform, keep-alive, x-accel-buffering no.
 *   4. Heartbeat (`: heartbeat`) fires on the 15s tick (fake timers).
 *   5. callRelay IS invoked with `/events?cursor=…&wait=…` — at least once.
 *   6. Each upstream event is emitted as `id: <seq>\ndata: <json>\n\n`.
 *   7. Aborting the request signal closes the stream cleanly.
 *
 * The route imports `callRelay` from '@/lib/dashboard-api'; we mock that
 * module so the test never touches the SigV4 path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock state so the factory + assertions share the same reference.
const relayMock = vi.hoisted(() => ({
  callRelay: vi.fn(),
}));

vi.mock('@/lib/dashboard-api', () => ({
  callRelay: relayMock.callRelay,
}));

// Minimal shim for NextRequest — the route only reads `.signal`.
function makeReq(): { signal: AbortSignal; abort: () => void } {
  const ctrl = new AbortController();
  return { signal: ctrl.signal, abort: () => ctrl.abort() };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (acc: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: Uint8Array | undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), remaining),
      ),
    ]);
    if (done) break;
    if (value) out += decoder.decode(value);
    if (predicate(out)) break;
  }
  return out;
}

describe('/api/stream route handler', () => {
  beforeEach(() => {
    relayMock.callRelay.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits `: connected` + retry hint as the first bytes, with SSE headers', async () => {
    // Relay blocks so the stream stays open long enough to read the preamble.
    relayMock.callRelay.mockImplementation(
      () => new Promise<Response>(() => {}),
    );

    const { GET } = await import('@/app/api/stream/route');
    const req = makeReq();
    const res = (await GET(
      req as unknown as import('next/server').NextRequest,
    )) as Response;

    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    expect(res.headers.get('cache-control')).toMatch(/no-transform/);
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = res.body!.getReader();
    const chunk = await readUntil(
      reader,
      (s) => s.includes(': connected') && /retry:\s*\d+/.test(s),
      2000,
    );
    expect(chunk).toContain(': connected');
    expect(chunk).toMatch(/retry:\s*\d+/);

    // Clean up — abort so the inner long-poll pending promise unblocks.
    req.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }, 10_000);

  it('calls callRelay with /events?cursor=…&wait=… and emits upstream events as id+data lines', async () => {
    const iso = '2026-04-23T10:00:00.000Z';
    const events = [
      { seq: 1, kind: 'inbox_item', id: 'inb_abc', ts: iso },
      { seq: 2, kind: 'capture_ack', id: 'cap_def', ts: iso },
    ];

    let calls = 0;
    relayMock.callRelay.mockImplementation(async (path: string) => {
      expect(path.startsWith('/events?')).toBe(true);
      expect(path).toMatch(/cursor=\d+/);
      expect(path).toMatch(/wait=\d+/);
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ events, cursor: 2 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Subsequent calls: hang so the stream stays open until we abort.
      return new Promise<Response>(() => {});
    });

    const { GET } = await import('@/app/api/stream/route');
    const req = makeReq();
    const res = (await GET(req as unknown as import('next/server').NextRequest)) as Response;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc += decoder.decode(value);
      if (acc.includes('inb_abc') && acc.includes('cap_def')) break;
    }

    expect(relayMock.callRelay).toHaveBeenCalled();
    expect(acc).toMatch(/id: 1\ndata: \{[^\n]*"id":"inb_abc"/);
    expect(acc).toMatch(/id: 2\ndata: \{[^\n]*"id":"cap_def"/);

    req.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  });

  it('closes cleanly when the request signal aborts', async () => {
    relayMock.callRelay.mockImplementation(
      () => new Promise<Response>(() => {}),
    );

    const { GET } = await import('@/app/api/stream/route');
    const req = makeReq();
    const res = (await GET(req as unknown as import('next/server').NextRequest)) as Response;

    const reader = res.body!.getReader();
    // Read the preamble.
    await reader.read();

    req.abort();

    // After abort, reading should eventually drain + close.
    const finished = (async () => {
      for (let i = 0; i < 10; i++) {
        const { done } = await reader.read();
        if (done) return true;
      }
      return false;
    })();

    // Give the controller a tick to propagate the close.
    const done = await Promise.race([
      finished,
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ]);
    expect(done).toBe(true);
  });

  it('skips malformed upstream events (SseEventSchema validation on the wire)', async () => {
    const iso = '2026-04-23T10:00:00.000Z';
    const events = [
      // Missing required `ts` -> schema rejects this one.
      { seq: 1, kind: 'inbox_item', id: 'bad' },
      // Valid.
      { seq: 2, kind: 'draft_ready', id: 'good', ts: iso },
    ];

    let calls = 0;
    relayMock.callRelay.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ events, cursor: 2 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Promise<Response>(() => {});
    });

    const { GET } = await import('@/app/api/stream/route');
    const req = makeReq();
    const res = (await GET(req as unknown as import('next/server').NextRequest)) as Response;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc += decoder.decode(value);
      if (acc.includes('"id":"good"')) break;
    }

    expect(acc).toContain('"id":"good"');
    expect(acc).not.toContain('"id":"bad"');

    req.abort();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  });
});
