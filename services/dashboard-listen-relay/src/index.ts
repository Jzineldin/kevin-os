/**
 * @kos/dashboard-listen-relay — tiny Fargate task (0.25 vCPU / 0.5 GB) that
 * holds a continuous Postgres LISTEN on `kos_output` and exposes a long-poll
 * HTTP API for the Vercel SSE Route Handler. See 03-CONTEXT.md D-24.
 *
 * Endpoints:
 *   GET /healthz
 *     -> 200 { ok: true, buffered, max_seq } when LISTEN connection is healthy.
 *     -> 500 { ok: false, reason } otherwise.
 *
 *   GET /events?cursor=<seq>&wait=<seconds>
 *     -> 200 { events: SseEventWithSeq[], cursor: maxSeq }
 *     - If events with seq>cursor exist -> return immediately.
 *     - Else wait up to min(wait, 25) seconds for new events, then return
 *       whatever is available (possibly []).
 *     Long-poll cap 25s keeps us safely under the Vercel SSE
 *     `maxDuration: 300` reconnect cadence (D-23).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Subscriber } from 'pg-listen';
import { RingBuffer } from './buffer.js';
import { startSubscriber } from './subscriber.js';

type QueryString = { cursor?: string; wait?: string };
type Notifications = { kos_output: unknown };

export interface BuiltApp {
  app: FastifyInstance;
  buffer: RingBuffer;
  subscriber: Subscriber<Notifications>;
  subscriberHealthy: () => boolean;
}

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true });
  const buffer = new RingBuffer(256);

  // Health flag is owned by startSubscriber — its listeners are registered
  // BEFORE the awaited connect(), which is required because pg-listen emits
  // 'connected' synchronously from inside connect(). Attaching health
  // listeners here (after await) was the bug that kept /healthz returning
  // 500 for the entire task lifetime.
  const { subscriber, isHealthy } = await startSubscriber(buffer);

  app.get('/healthz', async (_req, reply) => {
    if (!isHealthy()) {
      return reply.code(500).send({ ok: false, reason: 'subscriber not connected' });
    }
    return { ok: true, buffered: buffer.size, max_seq: buffer.maxSeq };
  });

  app.get('/events', async (req) => {
    const q = req.query as QueryString;
    const cursor = Number(q.cursor ?? '0') || 0;
    const wait = Math.min(Math.max(Number(q.wait ?? '0') || 0, 0), 25);

    const immediate = buffer.since(cursor);
    if (immediate.length > 0 || wait === 0) {
      return { events: immediate, cursor: buffer.maxSeq };
    }

    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const pending = buffer.since(cursor);
      if (pending.length > 0) {
        return { events: pending, cursor: buffer.maxSeq };
      }
    }
    return { events: [], cursor: buffer.maxSeq };
  });

  app.addHook('onClose', async () => {
    try {
      await subscriber.close();
    } catch {
      /* best-effort on shutdown */
    }
  });

  return { app, buffer, subscriber, subscriberHealthy: isHealthy };
}

// Entrypoint guard — only run the listen server when invoked directly.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === 'file://' + process.argv[1].split(String.fromCharCode(92)).join('/');

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 8080);
  buildApp()
    .then(({ app }) => {
      const shutdown = async (signal: string) => {
        console.log(`[relay] received ${signal}, shutting down`);
        try {
          await app.close();
        } finally {
          process.exit(0);
        }
      };
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
      process.once('SIGINT', () => void shutdown('SIGINT'));
      return app.listen({ host: '0.0.0.0', port });
    })
    .catch((err) => {
      console.error('[relay] startup failed', err);
      process.exit(1);
    });
}
