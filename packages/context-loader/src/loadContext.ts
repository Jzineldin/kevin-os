/**
 * loadContext — Phase 6 AGT-04 core implementation.
 *
 * Fetches entity dossiers + Kevin Context + recent mentions + Azure Search
 * semantic chunks + linked projects in parallel. Checks dossier cache
 * (Postgres `entity_dossiers_cached`) to short-circuit Azure + Postgres
 * traffic when entity state hasn't changed.
 *
 * Spec: .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
 *
 * Contract (must_haves):
 *   - Returns ContextBundle with all 8 fields populated (empty arrays OK
 *     for entity_dossiers/semantic_chunks/etc if data missing).
 *   - Empty entityIds → degraded path: Kevin Context still loaded; Azure
 *     semantic search on rawText (if provided) populates semantic_chunks.
 *   - `partial: true` + `partial_reasons: [...]` when any subfetch fails.
 *     loadContext MUST NOT throw on subfetch failure — prefer partial
 *     context over blocking the downstream agent.
 *   - `elapsed_ms` measured wall-clock from start to assembled_markdown.
 *   - Target p95 < 800ms including Azure query.
 */
import type { Pool as PgPool } from 'pg';
import type { ContextBundle, EntityDossier, SearchHit } from '@kos/contracts/context';
import { loadKevinContextBlock } from './kevin.js';
import { buildDossierMarkdown } from './markdown.js';
import {
  computeLastTouchHash,
  readDossierCache,
  writeDossierCache,
  type DossierCacheRow,
} from './cache.js';

export interface LoadContextInput {
  entityIds: string[];
  agentName: string;
  captureId: string;
  ownerId: string;
  rawText?: string;
  maxSemanticChunks?: number;
  pool: PgPool;
  /**
   * Optional: Azure Search hybrid-query callable. Injected so this module
   * stays stringly-decoupled from @kos/azure-search (avoids a circular
   * import if azure-search ever reaches back for context).
   */
  azureSearch?: (query: {
    rawText: string;
    entityIds: string[];
    topK: number;
  }) => Promise<SearchHit[]>;
}

export async function loadContext(input: LoadContextInput): Promise<ContextBundle> {
  const started = Date.now();
  const {
    entityIds,
    ownerId,
    rawText,
    maxSemanticChunks = 10,
    pool,
    azureSearch,
  } = input;

  const partialReasons: string[] = [];
  let cacheHit = false;

  // 1. Kevin Context — always loaded, always first.
  const kevinContext = await loadKevinContextBlock({ pool, ownerId }).catch((err) => {
    partialReasons.push(`kevin_context: ${(err as Error).message}`);
    return emptyKevinContext();
  });

  // 2. Check dossier cache for requested entities.
  let cached: Map<string, DossierCacheRow> = new Map();
  try {
    cached = await readDossierCache({ pool, ownerId, entityIds });
  } catch (err) {
    partialReasons.push(`dossier_cache_read: ${(err as Error).message}`);
  }

  // 3. For un-cached entities, fetch dossier + recent mentions in parallel.
  const missIds = entityIds.filter((id) => !cached.has(id));
  const [dossiers, mentionRows] = await Promise.all([
    fetchDossiers(pool, ownerId, missIds).catch((err) => {
      partialReasons.push(`entity_dossiers: ${(err as Error).message}`);
      return [] as EntityDossier[];
    }),
    fetchRecentMentions(pool, ownerId, entityIds).catch((err) => {
      partialReasons.push(`recent_mentions: ${(err as Error).message}`);
      return [] as ContextBundle['recent_mentions'];
    }),
  ]);

  // 4. Parallel: Azure semantic chunks + linked projects.
  const [semanticChunks, linkedProjects] = await Promise.all([
    azureSearch
      ? azureSearch({
          rawText: rawText ?? '',
          entityIds,
          topK: maxSemanticChunks,
        }).catch((err) => {
          partialReasons.push(`azure_search: ${(err as Error).message}`);
          return [] as SearchHit[];
        })
      : Promise.resolve<SearchHit[]>([]),
    fetchLinkedProjects(pool, ownerId, entityIds).catch((err) => {
      partialReasons.push(`linked_projects: ${(err as Error).message}`);
      return [] as ContextBundle['linked_projects'];
    }),
  ]);

  if (entityIds.length > 0 && cached.size === entityIds.length) {
    cacheHit = true;
  }

  // 5. Compose cached + freshly-fetched dossiers in input order.
  const allDossiers: EntityDossier[] = entityIds.map((id) => {
    const hit = cached.get(id);
    if (hit) return (hit as unknown as { bundle: ContextBundle }).bundle.entity_dossiers[0] ?? placeholderDossier(id);
    return dossiers.find((d) => d.entity_id === id) ?? placeholderDossier(id);
  });

  // 6. Write cache for newly-fetched dossiers.
  for (const d of dossiers) {
    const hash = computeLastTouchHash({
      name: d.name,
      last_touch: d.last_touch,
      recent_mention_count: mentionRows.filter((m) => m.entity_id === d.entity_id).length,
    });
    const subBundle: ContextBundle = {
      kevin_context: kevinContext,
      entity_dossiers: [d],
      recent_mentions: mentionRows.filter((m) => m.entity_id === d.entity_id),
      semantic_chunks: [],
      linked_projects: linkedProjects.filter((p) => d.linked_project_ids.includes(p.project_id)),
      assembled_markdown: '',
      elapsed_ms: 0,
      cache_hit: false,
      partial: false,
      partial_reasons: [],
    };
    void writeDossierCache({
      pool,
      ownerId,
      entityId: d.entity_id,
      lastTouchHash: hash,
      bundle: subBundle,
    }).catch(() => {
      /* cache writes are best-effort; don't block loadContext */
    });
  }

  const bundleWithoutMarkdown: ContextBundle = {
    kevin_context: kevinContext,
    entity_dossiers: allDossiers,
    recent_mentions: mentionRows,
    semantic_chunks: semanticChunks,
    linked_projects: linkedProjects,
    assembled_markdown: '',
    elapsed_ms: 0,
    cache_hit: cacheHit,
    partial: partialReasons.length > 0,
    partial_reasons: partialReasons,
  };

  const assembled = buildDossierMarkdown(bundleWithoutMarkdown);

  return {
    ...bundleWithoutMarkdown,
    assembled_markdown: assembled,
    elapsed_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Subfetch helpers
// ---------------------------------------------------------------------------

async function fetchDossiers(
  pool: PgPool,
  ownerId: string,
  entityIds: string[],
): Promise<EntityDossier[]> {
  if (entityIds.length === 0) return [];
  const { rows } = await pool.query<EntityDossier & { linked_project_ids: string[] }>(
    `SELECT entity_id, name, type, aliases, org, role, relationship, status,
            seed_context, last_touch, manual_notes, confidence, source,
            COALESCE(linked_project_ids, ARRAY[]::uuid[]) AS linked_project_ids,
            ARRAY[]::jsonb[] AS recent_mentions
       FROM entity_index
      WHERE owner_id = $1
        AND entity_id = ANY($2::uuid[])`,
    [ownerId, entityIds],
  );
  return rows.map((r) => ({
    ...r,
    last_touch: r.last_touch ? new Date(r.last_touch).toISOString() : null,
    recent_mentions: [],
  }));
}

async function fetchRecentMentions(
  pool: PgPool,
  ownerId: string,
  entityIds: string[],
): Promise<ContextBundle['recent_mentions']> {
  if (entityIds.length === 0) return [];
  const { rows } = await pool.query<{
    capture_id: string;
    entity_id: string;
    kind: string;
    occurred_at: Date;
    excerpt: string | null;
  }>(
    `SELECT capture_id, entity_id, kind, occurred_at, excerpt
       FROM mention_events
      WHERE owner_id = $1
        AND entity_id = ANY($2::uuid[])
      ORDER BY occurred_at DESC
      LIMIT 20`,
    [ownerId, entityIds],
  );
  return rows.map((r) => ({
    capture_id: r.capture_id,
    entity_id: r.entity_id,
    kind: r.kind,
    occurred_at: r.occurred_at.toISOString(),
    excerpt: r.excerpt,
  }));
}

async function fetchLinkedProjects(
  pool: PgPool,
  ownerId: string,
  entityIds: string[],
): Promise<ContextBundle['linked_projects']> {
  if (entityIds.length === 0) return [];
  const { rows } = await pool.query<{
    project_id: string;
    name: string;
    bolag: string | null;
    status: string | null;
  }>(
    `SELECT DISTINCT p.project_id, p.name, p.bolag, p.status
       FROM project_index p
       JOIN entity_index e ON e.owner_id = p.owner_id
      WHERE e.owner_id = $1
        AND e.entity_id = ANY($2::uuid[])
        AND p.project_id = ANY(e.linked_project_ids)`,
    [ownerId, entityIds],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function emptyKevinContext(): ContextBundle['kevin_context'] {
  return {
    current_priorities: '',
    active_deals: '',
    whos_who: '',
    blocked_on: '',
    recent_decisions: '',
    open_questions: '',
    last_updated: null,
  };
}

function placeholderDossier(entityId: string): EntityDossier {
  return {
    entity_id: entityId,
    name: `(unknown entity ${entityId})`,
    type: 'Person',
    aliases: [],
    org: null,
    role: null,
    relationship: null,
    status: null,
    seed_context: null,
    last_touch: null,
    manual_notes: null,
    confidence: 0,
    source: [],
    linked_project_ids: [],
    recent_mentions: [],
  };
}
