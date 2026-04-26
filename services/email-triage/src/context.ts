/**
 * Email-triage context loader (AGT-05) — Phase 6 graceful-degrade adapter.
 *
 * D-19 (CONTEXT 04): try the full @kos/context-loader path first (Kevin
 * Context + entity dossiers + Azure semantic chunks + linked projects).
 * If the import resolves AND loadContext succeeds, return the rich bundle.
 *
 * Fallback: when @kos/context-loader is unresolvable at runtime (Phase 6
 * not yet shipped) OR the call throws, degrade to loading just the
 * Kevin Context block via the local pool. This keeps email-triage running
 * end-to-end during incremental Phase rollouts without requiring Phase 6
 * to land first.
 *
 * Returned shape is intentionally minimal — the agent prompts only need
 * a Kevin Context string + an optional additional dossier markdown string.
 */
import { getPool, loadKevinContextBlockLocal } from './persist.js';

export interface TriageContext {
  /** Kevin Context markdown (always populated; empty string only on full DB outage). */
  kevinContext: string;
  /** Optional dossier markdown from @kos/context-loader; '' when degraded. */
  additionalContextBlock: string;
  /** True iff the dossier cache was hit. */
  cacheHit: boolean;
  /** Wall-clock ms — useful for Langfuse + cost telemetry. */
  elapsedMs: number;
  /** True iff we fell back to the local Kevin-Context-only path. */
  degraded: boolean;
}

export interface LoadTriageContextArgs {
  entityIds: string[];
  ownerId: string;
  captureId: string;
  rawText?: string;
}

/**
 * Load the triage context bundle. Tries @kos/context-loader first; on
 * failure (import error or runtime exception) falls back to the local
 * Kevin Context loader and returns degraded=true.
 *
 * NEVER throws. The caller's downstream Bedrock calls are wrapped in
 * withTimeoutAndRetry and a missing context block degrades gracefully —
 * blocking the entire triage on a Phase 6 outage would be worse than
 * running with a thinner prompt.
 */
export async function loadTriageContext(
  args: LoadTriageContextArgs,
): Promise<TriageContext> {
  const t0 = Date.now();
  // Try the rich loadContext path first.
  try {
    const mod = await import('@kos/context-loader');
    if (typeof mod?.loadContext === 'function') {
      const pool = await getPool();
      const bundle = await mod.loadContext({
        entityIds: args.entityIds,
        agentName: 'email-triage',
        captureId: args.captureId,
        ownerId: args.ownerId,
        rawText: args.rawText,
        pool,
      });
      // Render Kevin Context as a markdown string for the system prompt.
      // The rich bundle exposes a `kevin_context` object; we project the
      // 6-section shape into the same markdown layout the local loader
      // produces so the agent prompts see a uniform format.
      const kevinContext = renderKevinContextMarkdown(bundle.kevin_context);
      return {
        kevinContext,
        additionalContextBlock: bundle.assembled_markdown ?? '',
        cacheHit: Boolean(bundle.cache_hit),
        elapsedMs: Date.now() - t0,
        degraded: false,
      };
    }
  } catch (err) {
    console.warn(
      '[email-triage] @kos/context-loader unavailable; using local Kevin-Context fallback',
      { err: String(err) },
    );
  }

  // Degraded fallback — local Kevin-Context-only loader.
  try {
    const pool = await getPool();
    const kevinContext = await loadKevinContextBlockLocal(pool, args.ownerId);
    return {
      kevinContext,
      additionalContextBlock: '',
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      degraded: true,
    };
  } catch (err) {
    console.warn(
      '[email-triage] local Kevin-Context loader failed; running with empty context',
      { err: String(err) },
    );
    return {
      kevinContext: '',
      additionalContextBlock: '',
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      degraded: true,
    };
  }
}

/**
 * Render the structured KevinContextBlock into the same markdown layout
 * loadKevinContextMarkdown produces (## section_heading + section_body).
 * Empty sections are skipped so the cache hits more often.
 */
interface KevinContextLikeShape {
  current_priorities?: string;
  active_deals?: string;
  whos_who?: string;
  blocked_on?: string;
  recent_decisions?: string;
  open_questions?: string;
}

function renderKevinContextMarkdown(block: KevinContextLikeShape | undefined): string {
  if (!block) return '';
  const sections: Array<[string, string | undefined]> = [
    ['Current priorities', block.current_priorities],
    ['Active deals', block.active_deals],
    ["Who's who", block.whos_who],
    ['Blocked on', block.blocked_on],
    ['Recent decisions', block.recent_decisions],
    ['Open questions', block.open_questions],
  ];
  return sections
    .filter(([, body]) => body && body.trim())
    .map(([heading, body]) => `## ${heading}\n${body}`)
    .join('\n\n');
}
