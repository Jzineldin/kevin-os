/**
 * @kos/service-discord-brain-dump — CAP-10 Discord poller Lambda handler.
 *
 * Wave 0 SCAFFOLD ONLY. Plan 10-04 (Wave 4) drops the body in.
 *
 * EventBridge Scheduler input (per `05-06-DISCORD-CONTRACT.md`):
 *   {
 *     "owner_id": "<KEVIN_OWNER_ID>",
 *     "channel_ids": ["<channel_snowflake>", ...]
 *   }
 *
 * The Wave 4 body MUST:
 *   1. for each channel: read cursor via `getCursor(channelId)`,
 *   2. call Discord REST `GET /channels/{id}/messages?after=<cursor>` with
 *      the bot token from `DISCORD_BOT_TOKEN_SECRET_ARN`,
 *   3. Zod-parse each message against `DiscordChannelMessageSchema`,
 *   4. emit one `capture.received` to `kos.capture` per non-bot message,
 *   5. write the new high-water-mark via `setCursor(channelId, lastId)`.
 *
 * Failure semantics: Discord 429 → swallow + log; next 5-min fire retries.
 * Schema parse failures → drop with structured log; do not advance cursor
 * past the offending message ID.
 */
import type { ScheduledEvent } from 'aws-lambda';

class NotImplementedYet extends Error {
  constructor(what: string) {
    super(`discord-brain-dump: ${what} not implemented (Wave 0 scaffold)`);
    this.name = 'NotImplementedYet';
  }
}

export interface DiscordPollSchedulerInput {
  owner_id: string;
  channel_ids: string[];
}

/**
 * Lambda entry point. The Scheduler invokes the Lambda with the static
 * input shape above (NOT the standard ScheduledEvent shape) — we widen the
 * type so either invocation style typechecks against this signature.
 */
export async function handler(
  _event: ScheduledEvent | DiscordPollSchedulerInput,
): Promise<void> {
  throw new NotImplementedYet('handler');
}
