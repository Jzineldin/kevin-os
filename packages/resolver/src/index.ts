/**
 * @kos/resolver — ENT-09 hybrid scoring + D-10 stage routing + candidate retrieval.
 *
 * Consumed by: services/entity-resolver, services/voice-capture,
 * services/bulk-import-kontakter, services/bulk-import-granola-gmail.
 */
export { hybridScore, resolveStage, type Stage } from './score.js';
export {
  embedBatch,
  buildEntityEmbedText,
  MODEL_ID as EMBED_MODEL_ID,
  type EmbedInputType,
} from './embed.js';
export {
  findCandidates,
  hasProjectCooccurrence,
  CANDIDATE_SQL,
  type Candidate,
  type FindCandidatesInput,
} from './candidates.js';
