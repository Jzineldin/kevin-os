/**
 * /api/stream — Vercel-side SSE Route Handler (Plan 03-07 Task 1).
 *
 * Runtime: Node (P-01 forbids Edge here — aws4fetch + long execution need
 * Node APIs via `@/lib/dashboard-api`).
 *
 * Lifecycle (RESEARCH §12 + CONTEXT D-23):
 *   - First bytes: `: connected at <iso>\n\n` + `retry: 500\n\n` so the
 *     browser's EventSource fires `open` immediately and picks our 500ms
 *     backoff floor instead of the spec default 3s.
 *   - Every 15s: `: heartbeat\n\n` comment to flush proxy buffers (P-08).
 *   - Loop: SigV4-call `callRelay('/events?cursor=<last>&wait=25')`. For
 *     each `event` in the response, emit `id: <seq>\ndata: <json>\n\n`
 *     after validating against `SseEventSchema`; malformed events are
 *     silently dropped (T-3-07-03).
 *   - At ~280s wall time: close gracefully. Vercel Pro's hard cap is 300s
 *     (P-09); closing 20s early avoids the platform-terminated 504 that
 *     would flood Sentry.
 *   - On `req.signal.aborted` (browser tab closed): close immediately.
 *   - On relay 5xx / fetch error: emit `: reconnecting\n\n` + exponential
 *     backoff 500ms → 5s, keep the stream open (short outages look like
 *     long heartbeats to the client).
 *
 * Auth: inherits the `kos_session` cookie gate from middleware — matcher
 * in `src/middleware.ts` catches every non-public path, including
 * `/api/stream`. No per-route check needed here.
 *
 * Threat dispositions:
 *   - T-3-07-01 (DoS): stream closes at STREAM_DEADLINE_MS; upstream long
 *     poll capped at 25s. No infinite waits.
 *   - T-3-07-02 (leak): payload is pointer-only per D-25; full row fetched
 *     via the authenticated `callApi` path by downstream views.
 *   - T-3-07-03 (tampering): `SseEventSchema.parse` runs on every event.
 *   - T-3-07-04 (CSRF): EventSource same-origin + SameSite=Lax cookie.
 */
import type { NextRequest } from 'next/server';

import { SseEventSchema } from '@kos/contracts/dashboard';
import { callRelay } from '@/lib/dashboard-api';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 15_000;
// Close before Vercel Pro's 300s hard cap (P-09).
const STREAM_DEADLINE_MS = 280_000;
const LONG_POLL_WAIT_S = 25;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5_000;
// Client `retry:` hint — EventSource uses this as its reconnect floor.
const CLIENT_RETRY_MS = 500;

type RelayEvent = {
  seq?: number;
  kind?: string;
  id?: string;
  entity_id?: string;
  ts?: string;
};

type RelayResponseBody = {
  events?: RelayEvent[];
  cursor?: number;
};

export function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const started = Date.now();
  let cursor = 0;
  let backoff = BACKOFF_MIN_MS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Preamble — browser fires `open` on first bytes, and our retry hint
      // tells it to reconnect no sooner than 500ms (under our 60s cap).
      write(`: connected at ${new Date().toISOString()}\n\n`);
      write(`retry: ${CLIENT_RETRY_MS}\n\n`);

      const heartbeat = setInterval(
        () => write(`: heartbeat\n\n`),
        HEARTBEAT_MS,
      );
      const closeSoon = setTimeout(() => {
        clearInterval(heartbeat);
        closeOnce();
      }, STREAM_DEADLINE_MS);

      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        clearTimeout(closeSoon);
        closeOnce();
      });

      try {
        while (!req.signal.aborted && Date.now() - started < STREAM_DEADLINE_MS) {
          try {
            const res = await callRelay(
              `/events?cursor=${cursor}&wait=${LONG_POLL_WAIT_S}`,
              { method: 'GET', signal: req.signal },
            );
            if (!res.ok) {
              write(`: relay ${res.status}, retrying\n\n`);
              await sleep(backoff);
              backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
              continue;
            }
            backoff = BACKOFF_MIN_MS;
            const body = (await res.json()) as RelayResponseBody;
            for (const raw of body.events ?? []) {
              const parsed = SseEventSchema.safeParse(raw);
              if (!parsed.success) continue;
              const seq = typeof raw.seq === 'number' ? raw.seq : cursor + 1;
              write(`id: ${seq}\ndata: ${JSON.stringify(parsed.data)}\n\n`);
              if (seq > cursor) cursor = seq;
            }
            if (typeof body.cursor === 'number' && body.cursor > cursor) {
              cursor = body.cursor;
            }
          } catch (err) {
            if ((err as { name?: string } | null)?.name === 'AbortError') break;
            write(`: reconnecting\n\n`);
            await sleep(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          }
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(closeSoon);
        closeOnce();
      }
    },
    cancel() {
      /* abort handled via req.signal listener above */
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
