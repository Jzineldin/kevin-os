/**
 * @kos/test-fixtures — shared mocks for Phase 2 agent + capture services.
 *
 * Exports deterministic fakes for:
 *   - AWS Bedrock (Claude + Cohere Embed)
 *   - Telegram Bot API Update payloads (text + voice)
 *   - @notionhq/client subset used by agents (pages.create, databases.query, databases.retrieve)
 *
 * Full fixture + property-based tests land in Plan 03.
 */
export * from './bedrock.js';
export * from './telegram.js';
export * from './notion.js';
