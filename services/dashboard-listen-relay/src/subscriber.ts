/**
 * @kos/dashboard-listen-relay — pg-listen subscriber.
 *
 * Holds a continuous Postgres LISTEN on the `kos_output` channel. Every NOTIFY
 * payload is validated against SseEventSchema (from @kos/contracts/dashboard)
 * and pushed into the provided RingBuffer; malformed payloads are logged and
 * dropped.
 *
 * Connection:
 *   - RDS Proxy endpoint via IAM auth (15-minute token lifetime handled by
 *     pg-listen's built-in reconnect loop + fresh Signer.getAuthToken() on
 *     each (re)connect).
 *   - ssl.rejectUnauthorized=true (RDS Proxy uses managed certs).
 *
 * Per 03-RESEARCH.md §17 P-12: raw node-postgres LISTEN has a silent-stall
 * bug (#967). `pg-listen` wraps node-postgres with a paranoid-check query
 * every 30s AND reconnect-on-error, which sidesteps the stall. Do not replace
 * with a direct `pg.Client.query('LISTEN …')` without re-reading that issue.
 *
 * Reconnect policy:
 *   - retryInterval 500ms
 *   - retryTimeout infinite (task life is ECS's concern; we reconnect until
 *     the process is SIGTERM'd)
 *   - on fatal error -> process.exit(1) so ECS replaces the task
 */
import createSubscriber, { type Subscriber } from 'pg-listen';
import { Signer } from '@aws-sdk/rds-signer';
import { SseEventSchema } from '@kos/contracts/dashboard';
import type { RingBuffer } from './buffer.js';

type Notifications = { kos_output: unknown };

export interface StartedSubscriber {
  subscriber: Subscriber<Notifications>;
  /** True once pg-listen emits `connected`; flipped false on `error`. */
  isHealthy: () => boolean;
}

export async function startSubscriber(buffer: RingBuffer): Promise<StartedSubscriber> {
  const endpoint = process.env.RDS_PROXY_ENDPOINT;
  const region = process.env.AWS_REGION;
  if (!endpoint) throw new Error('RDS_PROXY_ENDPOINT env var is required');
  if (!region) throw new Error('AWS_REGION env var is required');

  const signer = new Signer({
    hostname: endpoint,
    port: 5432,
    username: process.env.RDS_USER ?? 'dashboard_relay',
    region,
  });

  const password = await signer.getAuthToken();

  const subscriber = createSubscriber<Notifications>(
    {
      host: endpoint,
      port: 5432,
      user: process.env.RDS_USER ?? 'dashboard_relay',
      database: process.env.RDS_DATABASE ?? 'kos',
      password,
      ssl: { rejectUnauthorized: true },
    },
    {
      paranoidChecking: 30_000,
      retryInterval: 500,
      retryTimeout: Number.POSITIVE_INFINITY,
    },
  );

  // Health flag — flipped by the 'connected' listener. MUST be registered
  // BEFORE `await subscriber.connect()` because pg-listen emits 'connected'
  // synchronously inside connect() (see node_modules/pg-listen line ~286:
  // `emit('connected')` fires before the promise resolves). Attaching the
  // listener after the await races with a done-deal event and never fires
  // for the initial connect — that was the bug that made /healthz return 500
  // for the whole task lifetime and kill ECS service stabilization.
  let healthy = false;

  subscriber.notifications.on('kos_output', (raw: unknown) => {
    try {
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const ev = SseEventSchema.parse(payload);
      buffer.push(ev);
    } catch (err) {
      console.warn('[relay] dropped malformed NOTIFY payload', err);
    }
  });

  subscriber.events.on('error', (err: Error) => {
    healthy = false;
    console.error('[relay] subscriber error, exiting for ECS restart', err);
    process.exit(1);
  });

  subscriber.events.on('connected', () => {
    healthy = true;
    console.log('[relay] LISTEN connected');
  });
  subscriber.events.on('reconnect', (attempt: number) => {
    healthy = false;
    console.log('[relay] reconnect attempt', attempt);
  });

  await subscriber.connect();
  await subscriber.listenTo('kos_output');
  return { subscriber, isHealthy: () => healthy };
}
