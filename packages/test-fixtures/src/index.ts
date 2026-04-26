/**
 * @kos/test-fixtures — shared mocks for Phase 2 agent + capture services
 * + Phase 6 Granola/Azure/Vertex memory layer.
 *
 * Exports deterministic fakes for:
 *   - AWS Bedrock (Claude + Cohere Embed)
 *   - Telegram Bot API Update payloads (text + voice)
 *   - @notionhq/client subset used by agents (pages.create, databases.query, databases.retrieve)
 *   - Phase 6: Granola transcripts (TranscriptAvailable detail)
 *   - Phase 6: Azure AI Search hits (SearchHit shape)
 *   - Phase 6: Vertex Gemini 2.5 Pro cachedContent + generateContent responses
 *
 * Full fixture + property-based tests land in Plan 03.
 */
export * from './bedrock.js';
export * from './telegram.js';
export * from './notion.js';
export * from './granola.js';
export * from './azure-search.js';
export * from './vertex.js';
// Phase 4 Plan 04-00 Task 5 — email + iOS Shortcut fixtures.
export * from './adversarial-email.js';
export * from './duplicate-email.js';
export * from './forwarded-email.js';
export * from './ios-shortcut.js';
// Phase 5 Plan 05-00 Task 4 — messaging-channel fixtures (Chrome MV3 stub +
// LinkedIn Voyager + Baileys WhatsApp).
export * from './phase-5/index.js';
// Phase 8 Plan 08-00 Task 5 — outbound content + mutation + calendar +
// document-diff fixtures.
export * from './imperative-mutations.js';
export * from './postiz-mcp-responses.js';
export * from './gcal-events.js';
export * from './document-diff-pairs.js';
