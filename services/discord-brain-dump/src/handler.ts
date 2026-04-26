/**
 * @kos/service-discord-brain-dump — CAP-10 Discord brain-dump poller.
 *
 * Phase 10 Plan 10-04. Filled-in body for the Wave-0 scaffold.
 *
 * Invocation contract (Phase 5 Plan 05-06's EventBridge Scheduler):
 *   ```json
 *   { "channel": "brain-dump", "owner_id": "<UUID>", "trigger_source": "kos-discord-poll-scheduler" }
 *   ```
 * The Discord channel snowflake to poll is NOT in the input — it is supplied
 * via `DISCORD_BRAIN_DUMP_CHANNEL_ID` env var (CDK-baked at deploy time).
 * This separation matches `05-06-DISCORD-CONTRACT.md`: the Scheduler stays
 * channel-agnostic, the Lambda owns channel + cursor.
 *
 * Per-fire flow:
 *   1. Validate input shape (channel === 'brain-dump' OR fall back to
 *      legacy MigrationStack `{ owner_id, channel_ids }` shape).
 *   2. Resolve bot token from Secrets Manager (cached across cold starts).
 *   3. Read cursor from DynamoDB (`getCursor`, see `src/cursor.ts`).
 *   4. Fetch new messages via `fetchNewMessages` (Discord REST `?after=`).
 *   5. For each message (oldest-first):
 *        a. Derive deterministic `capture_id` from `(channel_id, message_id)`.
 *        b. agent_runs idempotency check — skip if already `ok`.
 *        c. Insert started agent_runs row + tagTraceWithCaptureId.
 *        d. Build + Zod-validate `CaptureReceivedDiscordText` detail.
 *        e. PutEvents on `kos.capture`.
 *        f. Update agent_runs to `ok`.
 *        g. Advance cursor to this message's id.
 *      On any per-message exception: update agent_runs to `error`, BREAK
 *      the loop (cursor stays at the last-successful id), rethrow so
 *      Lambda surfaces a CloudWatch error.
 *   6. Graceful degradation per the contract: 401/403/404 from Discord →
 *      log + return success (cursor unchanged); transient 5xx → throw so
 *      Lambda retries on the next 5-min fire.
 *   7. Cold-start policy (cursor=null): per the contract, fetch the most
 *      recent message ONLY, seed the cursor with its id, emit zero events.
 *      No backfill — that is an operator-runbook concern.
 */
import { z } from 'zod';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  CaptureReceivedDiscordTextSchema,
  type CaptureReceivedDiscordText,
} from '@kos/contracts';
import { initSentry, wrapHandler, Sentry } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { getCursor, setCursor } from './cursor.js';
import {
  fetchNewMessages,
  DiscordAuthError,
  DiscordRateLimitError,
  DiscordTransientError,
} from './discord.js';
import {
  deterministicCaptureId,
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  publishDiscordCapture,
} from './persist.js';

// AWS_REGION default for tests + local invocation. Lambda always sets this.
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

// ---------------------------------------------------------------------------
// Input schemas — accept BOTH the canonical Plan 05-06 contract AND the
// legacy MigrationStack `{ owner_id, channel_ids }` shape for deploy
// resilience. The contract wins when both are valid.
// ---------------------------------------------------------------------------

const ContractInputSchema = z.object({
  channel: z.literal('brain-dump'),
  owner_id: z.string().uuid(),
  trigger_source: z.string().optional(),
});

const LegacyInputSchema = z.object({
  owner_id: z.string().uuid(),
  channel_ids: z.array(z.string()).optional(),
});

// EventBridge Scheduler can also fire a generic ScheduledEvent envelope when
// a CDK rule (vs Scheduler) is used; we defensively accept either shape and
// fall back to env vars when the input is empty (e.g. a bare manual invoke).
const InvokeInputSchema = z.union([ContractInputSchema, LegacyInputSchema]);

// ---------------------------------------------------------------------------
// Bot-token resolution (cached across invocations)
// ---------------------------------------------------------------------------

let cachedBotToken: string | null = null;

async function resolveBotToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken;
  const direct = process.env.DISCORD_BOT_TOKEN;
  if (direct) {
    cachedBotToken = direct;
    return direct;
  }
  const arn = process.env.DISCORD_BOT_TOKEN_SECRET_ARN;
  if (!arn) {
    throw new Error(
      'DISCORD_BOT_TOKEN_SECRET_ARN (or DISCORD_BOT_TOKEN) must be set',
    );
  }
  const sm = new SecretsManagerClient({});
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString || r.SecretString === 'PLACEHOLDER') {
    throw new Error(
      `Discord bot token secret ${arn} is empty/PLACEHOLDER — operator must seed kos/discord-bot-token`,
    );
  }
  cachedBotToken = r.SecretString;
  return cachedBotToken;
}

/** Test-only: clear the token cache between invocations. */
export function __resetTokenCacheForTests(): void {
  cachedBotToken = null;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface PollerResult {
  processed: number;
  skipped: number;
  errors: number;
  cursor_before: string | null;
  cursor_after: string | null;
  cold_start_seeded: boolean;
}

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

export const handler = wrapHandler(async (event: unknown): Promise<PollerResult> => {
  await initSentry();
  await setupOtelTracingAsync();

  // 1. Resolve owner_id (input > env). Channel id always from env (per contract).
  const ownerId = resolveOwnerId(event);
  const channelId = process.env.DISCORD_BRAIN_DUMP_CHANNEL_ID;
  if (!channelId) {
    throw new Error('DISCORD_BRAIN_DUMP_CHANNEL_ID env var is not set');
  }

  // Sentry v8 deprecated configureScope in favour of setTag at the static
  // namespace; we tag at scope-of-this-invocation so per-message
  // captureException calls inherit the channel tag without re-stating it.
  // Cast through unknown — Sentry's type surface for setTag varies across
  // SDK versions and our wrapHandler shim doesn't surface a strongly-typed
  // API. Best-effort: noop if the function isn't present.
  const sentryAny = Sentry as unknown as {
    setTag?: (k: string, v: string) => void;
  };
  sentryAny.setTag?.('discord.channel_id', channelId);

  // 2. Bot token + cursor.
  const botToken = await resolveBotToken();
  const cursorBefore = await getCursor(channelId);

  let processed = 0;
  let skipped = 0;
  let errorCount = 0;
  let cursorAfter: string | null = cursorBefore;
  let coldStartSeeded = false;

  try {
    // 3. Discord API call (typed errors → graceful-degradation matrix).
    let messages;
    try {
      messages = await fetchNewMessages(channelId, cursorBefore, botToken);
    } catch (err) {
      if (err instanceof DiscordAuthError) {
        // 401/403/404 = token revoked OR channel archived. Per contract:
        // log + exit success so the Scheduler's retry budget isn't burned;
        // operator surfaces via system_alerts (deferred to runbook).
        Sentry.captureException?.(err, {
          tags: { 'discord.degraded': 'auth' },
          extra: { channel_id: channelId, cursor_before: cursorBefore ?? '<null>' },
        });
        // eslint-disable-next-line no-console
        console.warn('[discord-brain-dump] auth degraded', { status: err.status, message: err.message });
        return {
          processed: 0,
          skipped: 0,
          errors: 1,
          cursor_before: cursorBefore,
          cursor_after: cursorBefore,
          cold_start_seeded: false,
        };
      }
      if (err instanceof DiscordRateLimitError) {
        // Two consecutive 429s. Defer to next fire (cursor unchanged).
        Sentry.captureException?.(err, {
          tags: { 'discord.degraded': 'rate-limit' },
          extra: { channel_id: channelId, retry_after_ms: err.retryAfterMs },
        });
        // eslint-disable-next-line no-console
        console.warn('[discord-brain-dump] rate-limited; deferring to next fire');
        return {
          processed: 0,
          skipped: 0,
          errors: 1,
          cursor_before: cursorBefore,
          cursor_after: cursorBefore,
          cold_start_seeded: false,
        };
      }
      if (err instanceof DiscordTransientError) {
        // 5xx — let Lambda fail so Scheduler's retryPolicy fires once;
        // cursor stays put (we never wrote it).
        throw err;
      }
      throw err;
    }

    // 4. Cold-start seeding policy: cursor was null AND we got >=1 message →
    // seed cursor to the LAST (newest) id, do NOT emit anything. The next
    // fire will emit messages newer than the seed.
    if (cursorBefore === null && messages.length > 0) {
      const newestId = messages[messages.length - 1]!.id;
      await setCursor(channelId, newestId);
      cursorAfter = newestId;
      coldStartSeeded = true;
      // eslint-disable-next-line no-console
      console.info('[discord-brain-dump] cold-start seeded cursor', {
        channel_id: channelId,
        seeded_to: newestId,
        skipped_messages: messages.length,
      });
      return {
        processed: 0,
        skipped: messages.length,
        errors: 0,
        cursor_before: null,
        cursor_after: newestId,
        cold_start_seeded: true,
      };
    }

    // 5. Per-message: idempotency, emit, advance cursor.
    for (const msg of messages) {
      const captureId = deterministicCaptureId(msg.channel_id, msg.id);
      tagTraceWithCaptureId(captureId);

      // D-21: skip if a prior `ok` agent_runs row exists for this capture_id.
      let priorOk = false;
      try {
        priorOk = await findPriorOkRun(captureId, ownerId);
      } catch (err) {
        // Pool failure is rare and non-fatal — log + continue without the
        // belt-and-braces check (capture_id determinism still gates dupes
        // at the triage consumer).
        Sentry.captureException?.(err, {
          tags: { 'discord.warn': 'agent_runs_check_failed' },
          extra: { capture_id: captureId },
        });
        // eslint-disable-next-line no-console
        console.warn('[discord-brain-dump] agent_runs check failed; proceeding without idempotency belt');
      }
      if (priorOk) {
        skipped++;
        // Cursor still advances — we already processed this id, the next
        // fire shouldn't re-fetch it.
        await setCursor(channelId, msg.id);
        cursorAfter = msg.id;
        continue;
      }

      let runId: string | null = null;
      try {
        runId = await insertAgentRun({
          ownerId,
          captureId,
          status: 'started',
        }).catch((e) => {
          // Treat insertAgentRun failure as non-fatal: log + emit anyway.
          // The capture_id is the load-bearing dedup; the agent_runs row is
          // observability sugar.
          Sentry.captureException?.(e, {
            tags: { 'discord.warn': 'agent_runs_insert_failed' },
            extra: { capture_id: captureId },
          });
          return null;
        });

        const detail: CaptureReceivedDiscordText = CaptureReceivedDiscordTextSchema.parse({
          capture_id: captureId,
          channel: 'discord' as const,
          kind: 'discord_text' as const,
          channel_id: msg.channel_id,
          message_id: msg.id,
          author: {
            id: msg.author.id,
            display: msg.author.username,
          },
          body: msg.content,
          // Normalize Discord's `+00:00` offset to the canonical `Z`
          // suffix that `z.string().datetime()` requires (default offset
          // mode is offset-disallowed). new Date(...).toISOString() is
          // a robust no-op for already-canonical strings AND a normalizer
          // for Discord's offset format.
          sent_at: new Date(msg.timestamp).toISOString(),
          received_at: new Date().toISOString(),
        });

        await publishDiscordCapture(detail);

        if (runId) {
          await updateAgentRun(runId, {
            status: 'ok',
            outputJson: {
              channel_id: msg.channel_id,
              message_id: msg.id,
              author_id: msg.author.id,
              body_length: msg.content.length,
              sent_at: msg.timestamp,
            },
          }).catch(() => {
            // Non-fatal: the event is already on the bus; agent_runs
            // observability lag is acceptable.
          });
        }

        // Cursor advance happens AFTER successful emit so a partial-run
        // crash leaves the cursor at the last truly processed id.
        await setCursor(channelId, msg.id);
        cursorAfter = msg.id;
        processed++;
      } catch (err) {
        errorCount++;
        const msgText = err instanceof Error ? err.message : String(err);
        Sentry.captureException?.(err, {
          tags: { 'discord.error': 'per_message_emit_failed' },
          extra: {
            capture_id: captureId,
            channel_id: msg.channel_id,
            message_id: msg.id,
          },
        });
        if (runId) {
          await updateAgentRun(runId, { status: 'error', errorMessage: msgText }).catch(() => {
            // best-effort
          });
        }
        // BREAK on first error: do NOT advance cursor past the offending
        // message id; next fire retries from the same point. This means
        // one poison-pill message DOES wedge the channel — the operator's
        // remedy per the runbook is a manual cursor bump.
        throw err;
      }
    }
  } finally {
    await langfuseFlush();
  }

  return {
    processed,
    skipped,
    errors: errorCount,
    cursor_before: cursorBefore,
    cursor_after: cursorAfter,
    cold_start_seeded: coldStartSeeded,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOwnerId(event: unknown): string {
  // Try parsing the event body first. EventBridge Scheduler calls Lambdas
  // with the input payload AS the event (no envelope), so this works for
  // both Scheduler shapes.
  const parsed = InvokeInputSchema.safeParse(event);
  if (parsed.success) return parsed.data.owner_id;

  const fromEnv = process.env.KEVIN_OWNER_ID;
  if (fromEnv) return fromEnv;
  throw new Error(
    'discord-brain-dump: owner_id not in event payload AND KEVIN_OWNER_ID env var is unset',
  );
}
