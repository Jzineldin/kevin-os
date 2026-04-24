/**
 * @kos/service-dossier-loader — Phase 6 INF-10 Vertex Gemini 2.5 Pro.
 *
 * Consumes `context.full_dossier_requested` from `kos.agent` — emitted only
 * on explicit intent (e.g. "load Damien's full dossier before drafting").
 * Aggregates every row tied to each entity (entity_index row, all
 * mention_events, email_drafts touching the entity, document_versions,
 * agent_runs context.summary per transcript) into a single 200k-800k token
 * context. Calls Vertex Gemini 2.5 Pro in europe-west4 with context caching
 * enabled.
 *
 * Writes result to `entity_dossiers_cached` with `last_touch_hash` prefix
 * 'gemini-full:' so regular loadContext() path treats it as a distinct
 * cache entry (invalidated on mention_events insert via trigger).
 *
 * Spec: .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
 */
import type { EventBridgeEvent } from 'aws-lambda';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import {
  FullDossierRequestedSchema,
  type FullDossierRequested,
} from '@kos/contracts/context';
import { writeDossierCache } from './persist.js';
import { getPool } from './persist.js';
import { callGeminiWithCache } from './vertex.js';
import { aggregateEntityCorpus } from './aggregate.js';

const MAX_INPUT_TOKENS = 800_000;

export const handler = wrapHandler(async (
  event: EventBridgeEvent<'context.full_dossier_requested', unknown>,
): Promise<{
  status: 'ok' | 'skipped';
  entity_count: number;
  elapsed_ms: number;
  tokens_input?: number;
  tokens_output?: number;
  cost_estimate_usd?: number;
}> => {
  await initSentry();

  const detail: FullDossierRequested = FullDossierRequestedSchema.parse(event.detail);
  tagTraceWithCaptureId(detail.capture_id);

  if (detail.entity_ids.length === 0) {
    return { status: 'skipped', entity_count: 0, elapsed_ms: 0 };
  }

  const started = Date.now();
  const pool = await getPool();

  const corpus = await aggregateEntityCorpus({
    pool,
    ownerId: detail.owner_id,
    entityIds: detail.entity_ids,
    maxTokens: MAX_INPUT_TOKENS,
  });

  const geminiRes = await callGeminiWithCache({
    corpus,
    entityIds: detail.entity_ids,
    captureId: detail.capture_id,
    intent: detail.intent,
  });

  // Write to dossier cache with gemini-full: prefix so loadContext()
  // distinguishes this from the fast-path bundle.
  for (const entityId of detail.entity_ids) {
    await writeDossierCache({
      pool,
      ownerId: detail.owner_id,
      entityId,
      lastTouchHash: `gemini-full:${Date.now()}`,
      bundle: {
        kevin_context: {
          current_priorities: '',
          active_deals: '',
          whos_who: '',
          blocked_on: '',
          recent_decisions: '',
          open_questions: '',
          last_updated: null,
        },
        entity_dossiers: [],
        recent_mentions: [],
        semantic_chunks: [],
        linked_projects: [],
        assembled_markdown: geminiRes.response_text,
        elapsed_ms: Date.now() - started,
        cache_hit: false,
        partial: false,
        partial_reasons: [],
      },
      ttlSeconds: 24 * 3600,
    });
  }

  return {
    status: 'ok',
    entity_count: detail.entity_ids.length,
    elapsed_ms: Date.now() - started,
    tokens_input: geminiRes.tokens_input,
    tokens_output: geminiRes.tokens_output,
    cost_estimate_usd: geminiRes.cost_estimate_usd,
  };
});
