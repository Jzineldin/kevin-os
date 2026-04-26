/**
 * @kos/service-discord-brain-dump — type re-exports.
 *
 * The Discord channel-message shape lives in @kos/contracts/migration so the
 * cursor module + downstream Lambda body can speak the same Zod-validated
 * envelope.
 */
export type { DiscordChannelMessage } from '@kos/contracts';
