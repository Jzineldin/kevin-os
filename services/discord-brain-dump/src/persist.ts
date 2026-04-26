/**
 * @kos/service-discord-brain-dump — persistence + emit.
 *
 * Phase 10 Plan 10-04 / CAP-10. Three responsibilities:
 *
 *   1. Deterministic ULID-shape `capture_id` from `(channel_id, message_id)`
 *      — the idempotency seed per 05-06-DISCORD-CONTRACT.md §Idempotency.
 *      Same `(channel_id, message_id)` always yields the same capture_id, so
 *      the Phase-2 triage's existing capture_id dedupe handles double-poll
 *      replays without any further work here.
 *
 *   2. RDS `agent_runs` idempotency check — defence-in-depth on top of the
 *      capture_id seed. We additionally insert a `started`/`ok` agent_runs
 *      row per message so the dashboard's run-history surface can render
 *      Discord captures alongside Granola/Notion/Email captures.
 *
 *   3. EventBridge PutEvents for `kos.capture / capture.received` with
 *      detail validated against `CaptureReceivedDiscordTextSchema` (the
 *      Phase 5 Plan 05-00 contract).
 *
 * RDS connection model mirrors `services/granola-poller/src/persist.ts`:
 * IAM-auth signed token via `@aws-sdk/rds-signer`, max-2 connections per
 * Lambda invocation. The rds-signer + pg deps are intentionally optional at
 * test time — `getPool()` returns the cached pool if pre-injected via
 * `__setPoolForTests` (so tests don't pay the cost of starting a Postgres).
 */
import { createHash } from 'node:crypto';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CaptureReceivedDiscordTextSchema,
  type CaptureReceivedDiscordText,
} from '@kos/contracts';

// ---------------------------------------------------------------------------
// Deterministic capture_id (sha256 → 26-char Crockford base32)
// ---------------------------------------------------------------------------

/** Crockford base32 alphabet (no I, L, O, U) — matches the ULID UlidRegex. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Derive a 26-char ULID-shape capture_id from `(channel_id, message_id)`.
 *
 * Mirrors the same construction used by `services/ses-inbound` and
 * `services/baileys-sidecar`: sha256 the source string, then map each of
 * the first 26 bytes through `byte % 32` into the Crockford alphabet.
 *
 * Determinism: same input → same output. Replays of the Lambda for the
 * same Discord message produce identical capture_ids, so Phase-2 triage's
 * capture_id dedupe naturally absorbs double-polls.
 *
 * Modulo-bias note: this is an idempotency key, NOT a uniformly random
 * id, so the slight bias from `byte % 32` is irrelevant — the requirement
 * is "stable function from input to UlidRegex-compatible string" only.
 */
export function deterministicCaptureId(
  channelId: string,
  messageId: string,
): string {
  const hash = createHash('sha256')
    .update(`discord:${channelId}:${messageId}`, 'utf8')
    .digest();
  let out = '';
  for (let i = 0; i < 26; i++) {
    // hash is 32 bytes; i ∈ [0,25] always defined.
    out += CROCKFORD[hash[i]! % 32];
  }
  return out;
}

// ---------------------------------------------------------------------------
// RDS agent_runs idempotency (lazy import of pg + rds-signer)
// ---------------------------------------------------------------------------

interface PgQueryResult<T = unknown> {
  rowCount: number | null;
  rows: T[];
}

/**
 * Minimal pool surface this module relies on. The real `pg.Pool` satisfies
 * this; tests inject a mock that implements `query()`.
 */
export interface PgLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
}

let pool: PgLike | null = null;

/**
 * Return the shared pg pool, lazily constructed at first call. The real
 * connection setup mirrors `services/granola-poller/src/persist.ts` so the
 * pattern stays uniform across pollers.
 *
 * Tests inject the pool via `__setPoolForTests` to avoid starting Postgres.
 */
export async function getPool(): Promise<PgLike> {
  if (pool) return pool;
  // Dynamic imports — avoids paying the cost (and the test-side mocking
  // dance) for pg / rds-signer when a test injects a fake pool.
  const [{ default: pg }, { Signer }] = await Promise.all([
    import('pg'),
    import('@aws-sdk/rds-signer'),
  ]);
  const host = process.env.RDS_PROXY_ENDPOINT ?? process.env.DATABASE_HOST;
  const user = process.env.RDS_IAM_USER ?? process.env.DATABASE_USER ?? 'kos_admin';
  if (!host) throw new Error('RDS_PROXY_ENDPOINT (or DATABASE_HOST) not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const signer = new Signer({ hostname: host, port, region, username: user });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool = new (pg as any).Pool({
    host,
    port,
    user,
    database: process.env.DATABASE_NAME ?? 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  });
  return pool!;
}

/** Test-only: inject a pre-built pool so unit tests skip the import dance. */
export function __setPoolForTests(p: PgLike | null): void {
  pool = p;
}

export type AgentRunStatus = 'started' | 'ok' | 'error';

const AGENT_NAME = 'discord-brain-dump';

/**
 * D-21 idempotency check — was this `(capture_id, agent_name, owner_id)`
 * already processed to `ok` in a prior fire? If so, the handler skips emit
 * and does not regress the cursor.
 *
 * Returns `true` when a prior `ok` row exists.
 */
export async function findPriorOkRun(
  captureId: string,
  ownerId: string,
): Promise<boolean> {
  const p = await getPool();
  const r = await p.query<{ '?column?': number }>(
    `SELECT 1 FROM agent_runs
       WHERE owner_id = $1 AND capture_id = $2 AND agent_name = $3 AND status = 'ok'
       LIMIT 1`,
    [ownerId, captureId, AGENT_NAME],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface InsertAgentRunInput {
  ownerId: string;
  captureId: string;
  status: AgentRunStatus;
}

export async function insertAgentRun(row: InsertAgentRunInput): Promise<string> {
  const p = await getPool();
  const r = await p.query<{ id: string }>(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [row.ownerId, row.captureId, AGENT_NAME, row.status],
  );
  return r.rows[0]!.id;
}

export interface UpdateAgentRunPatch {
  status: AgentRunStatus;
  outputJson?: unknown;
  errorMessage?: string;
}

export async function updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void> {
  const p = await getPool();
  await p.query(
    `UPDATE agent_runs
        SET status = $2,
            output_json = $3,
            error_message = $4,
            finished_at = NOW()
      WHERE id = $1`,
    [id, patch.status, patch.outputJson ?? null, patch.errorMessage ?? null],
  );
}

// ---------------------------------------------------------------------------
// EventBridge PutEvents — kos.capture / capture.received (CAP-10)
// ---------------------------------------------------------------------------

let ebClient: EventBridgeClient | null = null;
function getEventBridge(): EventBridgeClient {
  if (!ebClient) ebClient = new EventBridgeClient({});
  return ebClient;
}

/** Test-only: inject a pre-built EB client. */
export function __setEbForTests(c: EventBridgeClient | null): void {
  ebClient = c;
}

const SOURCE = 'kos.capture-discord-brain-dump';
const DETAIL_TYPE = 'capture.received';

/**
 * Emit one `capture.received` per Discord message. Validates the detail
 * against `CaptureReceivedDiscordTextSchema` BEFORE PutEvents — a Zod parse
 * failure here means the handler tried to publish a malformed event;
 * better to throw locally (fail the message, leave cursor at last good)
 * than emit garbage onto the bus.
 */
export async function publishDiscordCapture(
  detail: CaptureReceivedDiscordText,
): Promise<void> {
  // Validate one more time at the emit boundary — the handler's parse is
  // belt; this is braces. Cheap, and means a future refactor that drops
  // the handler-side parse can't quietly publish bad data.
  const validated = CaptureReceivedDiscordTextSchema.parse(detail);
  const busName = process.env.KOS_CAPTURE_BUS_NAME;
  if (!busName) throw new Error('KOS_CAPTURE_BUS_NAME not set');
  await getEventBridge().send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: SOURCE,
          DetailType: DETAIL_TYPE,
          Detail: JSON.stringify(validated),
        },
      ],
    }),
  );
}

/** Test-only helper: reset module-scope clients between tests. */
export function __resetForTests(): void {
  pool = null;
  ebClient = null;
}
