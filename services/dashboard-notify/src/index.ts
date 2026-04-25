/**
 * @kos/dashboard-notify — EventBridge rule target on the `kos.output` bus.
 *
 * For every KOS event that originates OUTSIDE of an RDS trigger (e.g. a
 * Lambda or service publishing directly to EventBridge), this Lambda
 * translates the event envelope into a Postgres NOTIFY on the `kos_output`
 * channel. The `dashboard-listen-relay` Fargate task picks it up via LISTEN
 * and pushes it to the Vercel SSE Route Handler.
 *
 * Belt-and-braces alongside migration 0009 triggers (which cover
 * RDS-originated events directly): duplicates are harmless since the SSE
 * payload is pointer-only — the browser dedupes by id.
 *
 * Contract (D-22/D-25):
 *   detail-type -> kind; one of {inbox_item, entity_merge, capture_ack, draft_ready, timeline_event}
 *   detail.id (or event.id fallback) -> pointer id
 *   detail.entity_id -> optional entity pointer
 *   detail.ts -> ISO 8601 UTC timestamp (defaults to now())
 *
 * IAM: runs as RDS user `dashboard_notify` with EXECUTE on `pg_notify` only —
 * no SELECT/INSERT rights (Plan 05 enforces). Short-lived pg.Client per
 * invocation; no connection pool (Lambda warm reuse doesn't benefit LISTEN;
 * pg_notify is fire-and-forget).
 *
 * Error path: parse/validation failures throw -> EventBridge retries per
 * default policy (24h / 185 attempts) then routes to DLQ in Plan 05.
 */
import type { EventBridgeHandler } from 'aws-lambda';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { SseEventSchema, SseEventKindSchema } from '@kos/contracts/dashboard';

const ALLOWED_KINDS = new Set<string>([
  'inbox_item',
  'entity_merge',
  'capture_ack',
  'draft_ready',
  'timeline_event',
]);

export interface NotifyDeps {
  makeClient?: (password: string) => pg.Client;
  getAuthToken?: () => Promise<string>;
}

type DetailShape = {
  id?: string;
  entity_id?: string;
  ts?: string;
};

export function createHandler(
  deps: NotifyDeps = {},
): EventBridgeHandler<string, DetailShape, { ok: true; notified: boolean }> {
  return async (event) => {
    const detailType = event['detail-type'];

    // Allowlist gate — silently ignore rule-matching events that are not in the
    // SSE contract. This keeps the Lambda safe if the EventBridge rule is ever
    // widened.
    if (!ALLOWED_KINDS.has(detailType)) {
      console.warn('[dashboard-notify] ignored detail-type', detailType);
      return { ok: true, notified: false };
    }

    // Build and validate the SSE payload (pointer-only per D-25).
    const detail = (event.detail ?? {}) as DetailShape;
    const rawPayload: Record<string, unknown> = {
      kind: SseEventKindSchema.parse(detailType),
      id: String(detail.id ?? event.id ?? ''),
      ts: detail.ts ?? new Date().toISOString(),
    };
    if (detail.entity_id) rawPayload.entity_id = detail.entity_id;

    const payload = SseEventSchema.parse(rawPayload);
    const serialised = JSON.stringify(payload);

    // Pointer-only invariant (Postgres NOTIFY payload cap is 8 KB).
    if (serialised.length > 8000) {
      throw new Error(
        `[dashboard-notify] payload exceeds 8KB NOTIFY cap (${serialised.length} bytes)`,
      );
    }

    const endpoint = process.env.RDS_PROXY_ENDPOINT;
    const region = process.env.AWS_REGION;
    if (!endpoint) throw new Error('RDS_PROXY_ENDPOINT env var is required');
    if (!region) throw new Error('AWS_REGION env var is required');

    const getToken =
      deps.getAuthToken ??
      (() => {
        const signer = new Signer({
          hostname: endpoint,
          port: 5432,
          username: process.env.RDS_USER ?? 'dashboard_notify',
          region,
        });
        return signer.getAuthToken();
      });
    const password = await getToken();

    const client =
      deps.makeClient?.(password) ??
      new pg.Client({
        host: endpoint,
        port: 5432,
        user: process.env.RDS_USER ?? 'dashboard_notify',
        database: process.env.RDS_DATABASE ?? 'kos',
        ssl: { rejectUnauthorized: true },
        password,
      });

    await client.connect();
    try {
      await client.query('SELECT pg_notify($1, $2)', ['kos_output', serialised]);
    } finally {
      await client.end();
    }

    return { ok: true, notified: true };
  };
}

export const handler = createHandler();
