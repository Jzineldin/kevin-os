/**
 * Phase 6 context-loader contracts — AGT-04 auto-context loader.
 *
 * Shared types for ContextBundle (loadContext output) + full-dossier event
 * (INF-10 Gemini 2.5 Pro). Consumed by @kos/context-loader and every agent
 * Lambda that calls loadContext() before invoking Bedrock.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// EntityDossier — the unit of "who is this person/project" context
// ---------------------------------------------------------------------------

export const EntityDossierSchema = z.object({
  entity_id: z.string().uuid(),
  name: z.string(),
  type: z.enum(['Person', 'Project', 'Company', 'Document']),
  aliases: z.array(z.string()).default([]),
  org: z.string().nullable(),
  role: z.string().nullable(),
  relationship: z.string().nullable(),
  status: z.string().nullable(),
  seed_context: z.string().nullable(),
  last_touch: z.string().datetime().nullable(),
  manual_notes: z.string().nullable(),
  confidence: z.number().min(0).max(1).default(1),
  source: z.array(z.string()).default([]),
  linked_project_ids: z.array(z.string().uuid()).default([]),
  // Computed from mention_events by context-loader
  recent_mentions: z
    .array(
      z.object({
        capture_id: z.string(),
        kind: z.string(),
        occurred_at: z.string().datetime(),
        excerpt: z.string().nullable(),
      }),
    )
    .default([]),
});
export type EntityDossier = z.infer<typeof EntityDossierSchema>;

// ---------------------------------------------------------------------------
// SearchHit — one Azure AI Search result chunk
// ---------------------------------------------------------------------------

export const SearchHitSchema = z.object({
  id: z.string(),
  source: z.enum(['entity', 'project', 'transcript', 'daily_brief']),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  reranker_score: z.number().nullable(),
  entity_ids: z.array(z.string().uuid()).default([]),
  indexed_at: z.string().datetime(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

// ---------------------------------------------------------------------------
// KevinContextBlock — the always-loaded prompt-cached dossier
// ---------------------------------------------------------------------------

export const KevinContextBlockSchema = z.object({
  current_priorities: z.string(),
  active_deals: z.string(),
  whos_who: z.string(),
  blocked_on: z.string(),
  recent_decisions: z.string(),
  open_questions: z.string(),
  last_updated: z.string().datetime().nullable(),
});
export type KevinContextBlock = z.infer<typeof KevinContextBlockSchema>;

// ---------------------------------------------------------------------------
// ContextBundle — the full output of loadContext()
// ---------------------------------------------------------------------------

export const ContextBundleSchema = z.object({
  kevin_context: KevinContextBlockSchema,
  entity_dossiers: z.array(EntityDossierSchema),
  recent_mentions: z.array(
    z.object({
      capture_id: z.string(),
      entity_id: z.string().uuid(),
      kind: z.string(),
      occurred_at: z.string().datetime(),
      excerpt: z.string().nullable(),
    }),
  ),
  semantic_chunks: z.array(SearchHitSchema),
  linked_projects: z.array(
    z.object({
      project_id: z.string().uuid(),
      name: z.string(),
      bolag: z.string().nullable(),
      status: z.string().nullable(),
    }),
  ),
  assembled_markdown: z.string(),
  elapsed_ms: z.number().int().nonnegative(),
  cache_hit: z.boolean(),
  partial: z.boolean().default(false),
  partial_reasons: z.array(z.string()).default([]),
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

// ---------------------------------------------------------------------------
// Phase 6 event: context.full_dossier_requested → dossier-loader (INF-10)
// ---------------------------------------------------------------------------

export const FullDossierRequestedSchema = z.object({
  capture_id: z.string(),
  owner_id: z.string().uuid(),
  entity_ids: z.array(z.string().uuid()).min(1),
  requested_by: z.string(),
  intent: z.string(),
  requested_at: z.string().datetime(),
});
export type FullDossierRequested = z.infer<typeof FullDossierRequestedSchema>;

// ---------------------------------------------------------------------------
// Phase 6 event: transcript.available (Granola poller → extractor)
// ---------------------------------------------------------------------------

export const TranscriptAvailableSchema = z.object({
  capture_id: z.string(),
  owner_id: z.string().uuid(),
  transcript_id: z.string(),
  notion_page_id: z.string(),
  title: z.string().nullable(),
  source: z.literal('granola'),
  last_edited_time: z.string().datetime(),
  raw_length: z.number().int().nonnegative(),
});
export type TranscriptAvailable = z.infer<typeof TranscriptAvailableSchema>;

// ---------------------------------------------------------------------------
// AGT-06 structured output (Bedrock tool_use) — action items + mentions
// ---------------------------------------------------------------------------

export const TranscriptExtractionSchema = z.object({
  action_items: z.array(
    z.object({
      title: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      due_hint: z.string().nullable(),
      linked_entity_ids: z.array(z.string().uuid()).default([]),
      source_excerpt: z.string(),
    }),
  ),
  mentioned_entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['Person', 'Project', 'Company', 'Document', 'Unknown']),
      aliases: z.array(z.string()).default([]),
      sentiment: z.enum(['positive', 'neutral', 'negative']).default('neutral'),
      occurrence_count: z.number().int().positive(),
      excerpt: z.string(),
    }),
  ),
  summary: z.string().max(800),
  decisions: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});
export type TranscriptExtraction = z.infer<typeof TranscriptExtractionSchema>;
