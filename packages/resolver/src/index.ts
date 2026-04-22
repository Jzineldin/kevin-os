/**
 * @kos/resolver — ENT-09 hybrid scoring + D-10 stage routing library.
 *
 * Consumed by: services/entity-resolver, services/voice-capture,
 * services/bulk-import-kontakter, services/bulk-import-granola-gmail.
 * Real integration against pgvector + Bedrock Cohere Embed lands in Plan 03+.
 */
export { hybridScore, resolveStage, type Stage } from './score.js';
