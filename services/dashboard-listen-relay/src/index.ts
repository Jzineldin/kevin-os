/**
 * @kos/dashboard-listen-relay — tiny Fargate task (0.25 vCPU / 0.5 GB) that
 * holds a Postgres LISTEN on `kos_output` and exposes a long-poll HTTP
 * endpoint for the Vercel SSE Route Handler. See 03-CONTEXT.md D-24.
 *
 * Wave 0 scaffold only — Fastify + pg-listen wiring lands in plan 03-06.
 */
import Fastify from 'fastify';

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ ok: true, buffered: 0 }));

  app.get('/events', async () => ({ events: [], next_cursor: null }));

  return app;
}

// Entry point (for ts-node / bundled output). Kept minimal in Wave 0.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  buildServer()
    .listen({ host: '0.0.0.0', port })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
