/**
 * withTimeoutAndRetry — shared resilience wrapper for every agent tool call
 * in Phase 4+. Per Phase 4 D-24: 10s timeout, 2 retries, exponential backoff,
 * dead-letter write + EventBridge emit on final failure. NEVER wraps the
 * dead-letter write itself (P-11 infinite-loop guard).
 *
 * Algorithm:
 *   for attempt in 0..maxRetries:
 *     race fn() vs setTimeout(timeoutMs, reject(TimeoutError))
 *     on success → return value
 *     on caught error:
 *       if shouldRetry(err) AND attempt < maxRetries:
 *         delay = 2^attempt * 1000  (1s, 2s)
 *         await delay
 *         continue
 *       else break
 *   on final failure:
 *     write agent_dead_letter row (try/catch — failure logged, NOT thrown)
 *     emit InboxDeadLetterSchema event (try/catch — failure logged, NOT thrown)
 *     re-throw the original error
 *
 * Default shouldRetry returns true for:
 *   - Error message matches /timeout/i (TimeoutError from our race)
 *   - err.name === 'ThrottlingException'  (Bedrock / SES throttle)
 *   - err.statusCode >= 500
 *   - err.code in {'ECONNRESET','ETIMEDOUT','EAI_AGAIN'}  (network)
 *
 * 4xx errors, schema errors, and unrecognised errors are NOT retried —
 * they are deterministic failures that retry can't fix. The Approve gate
 * is also NOT retried (a missing email_send_authorizations row is a
 * business-logic failure, not a transient one).
 *
 * Dependencies are injected (pool, eventBridge) so tests can stub them
 * cleanly. Lambda callers wire their existing pg.Pool + EventBridgeClient.
 */
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';

// pg is loaded by callers; we keep this module pg-free at import time so
// unit tests don't need to install pg. The injected `pool` only needs
// `.query(text, params): Promise<{ rowCount: number }>`.
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rowCount?: number | null }>;
}

export interface WithTimeoutAndRetryOpts {
  /** Per-attempt timeout. Default 10_000 ms. */
  timeoutMs?: number;
  /** Max retries after the initial attempt. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Optional agent_runs.id to stamp on the dead-letter row. */
  agentRunId?: string;
  /** Required: tool name for the dead-letter row (e.g. 'bedrock:haiku'). */
  toolName: string;
  /** Required: capture_id (ULID) — used by dashboard SSE to fan out the failure. */
  captureId: string;
  /** Required: owner_id (UUID) — every Phase 4 table has owner_id NOT NULL. */
  ownerId: string;
  /** Injected pg pool (or pool-like). On final failure, INSERTs into agent_dead_letter. */
  pool?: PgPoolLike;
  /** Injected EventBridge client. On final failure, emits InboxDeadLetterSchema. */
  eventBridge?: EventBridgeClient;
  /** Override the default classifier — return true to retry. */
  shouldRetry?: (err: unknown) => boolean;
  /** Override the per-attempt backoff. Default 2^attempt * 1000ms (1s, 2s, 4s, ...). */
  backoffMs?: (attempt: number) => number;
  /** Optional: short preview of the request for the dead-letter row. */
  requestPreview?: string;
}

/**
 * Default shouldRetry classifier. Conservative — only obvious transient
 * errors are retried. Schema / 4xx / approve-gate failures fall straight
 * through to the dead-letter path.
 */
export function defaultShouldRetry(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as {
    name?: string;
    code?: string;
    statusCode?: number;
    message?: string;
  };

  // Our internal timeout race.
  if (typeof e.message === 'string' && /timeout/i.test(e.message)) return true;

  // AWS SDK throttling.
  if (e.name === 'ThrottlingException') return true;

  // 5xx upstream.
  if (typeof e.statusCode === 'number' && e.statusCode >= 500) return true;

  // Common Node network error codes.
  if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'EAI_AGAIN') {
    return true;
  }

  return false;
}

/** Internal: race a promise against a timeout. */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([
    fn().finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

/** Internal: sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write the dead-letter row + emit the InboxDeadLetterSchema event.
 *
 * **Critical**: this function is NEVER wrapped in withTimeoutAndRetry
 * itself (P-11 — would cause infinite recursion on a failing pool /
 * EventBridge). Each side-effect is in its own try/catch so a failing
 * pool does not stop the EventBridge emit (and vice versa).
 *
 * Errors here are logged to console but never thrown — the caller must
 * receive the ORIGINAL error, not a downstream observability error.
 */
export async function writeDeadLetter(
  opts: WithTimeoutAndRetryOpts,
  err: unknown,
): Promise<void> {
  const e = err as { name?: string; message?: string };
  const errorClass = e.name ?? 'Error';
  const errorMessage = e.message ?? String(err);

  if (opts.pool) {
    try {
      await opts.pool.query(
        `INSERT INTO agent_dead_letter
            (owner_id, capture_id, agent_run_id, tool_name, error_class,
             error_message, request_preview, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          opts.ownerId,
          opts.captureId,
          opts.agentRunId ?? null,
          opts.toolName,
          errorClass,
          errorMessage,
          opts.requestPreview ?? null,
        ],
      );
    } catch (writeErr) {
      // P-11 guard: log + continue. Caller will still see the original error.
      // Do NOT call writeDeadLetter recursively (would loop).
      // eslint-disable-next-line no-console
      console.error('[with-timeout-retry] dead-letter pool.query failed:', writeErr);
    }
  }

  if (opts.eventBridge) {
    try {
      const detail = {
        capture_id: opts.captureId,
        tool_name: opts.toolName,
        error_class: errorClass,
        preview: errorMessage.slice(0, 400),
        occurred_at: new Date().toISOString(),
      };
      await opts.eventBridge.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.output',
              Source: 'kos.output',
              DetailType: 'inbox.dead_letter',
              Detail: JSON.stringify(detail),
            },
          ],
        }),
      );
    } catch (emitErr) {
      // eslint-disable-next-line no-console
      console.error('[with-timeout-retry] dead-letter eventBridge.send failed:', emitErr);
    }
  }
}

/**
 * Run `fn` with timeout + retry + dead-letter-on-final-failure semantics.
 *
 * Returns the value `fn` resolves with. On final failure, the dead-letter
 * row is written + event emitted, and the ORIGINAL error is re-thrown.
 */
export async function withTimeoutAndRetry<T>(
  fn: () => Promise<T>,
  opts: WithTimeoutAndRetryOpts,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRetries = opts.maxRetries ?? 2;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const backoff =
    opts.backoffMs ?? ((attempt: number) => Math.pow(2, attempt) * 1000);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (err) {
      lastErr = err;
      const more = attempt < maxRetries;
      if (more && shouldRetry(err)) {
        await sleep(backoff(attempt));
        continue;
      }
      break;
    }
  }

  // Final failure — write dead letter + emit event, then re-throw.
  await writeDeadLetter(opts, lastErr);
  throw lastErr;
}
