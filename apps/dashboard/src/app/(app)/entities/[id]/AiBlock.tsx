/**
 * "What you need to know" AI block for the per-entity dossier.
 *
 * Phase 3 MUST NOT invoke an LLM (RESEARCH §10). The dashboard-api
 * `EntityResponseSchema.ai_block` is always the cached `seed_context` or
 * null; Phase 6 AGT-04 will swap this with a live Gemini 2.5 Pro call.
 *
 * Copy (binding per UI-SPEC §Copywriting + TFOS-ui.html §AI block):
 *   - Eyebrow: "WHAT YOU NEED TO KNOW"
 *   - Empty placeholder: "Summary generates on next morning brief. Until
 *     then, see timeline below."
 */
import type { EntityResponse } from '@kos/contracts/dashboard';

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return '';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AiBlock({ entity }: { entity: EntityResponse }) {
  const body = entity.ai_block?.body?.trim() ?? '';
  const cached = entity.ai_block?.cached_at ?? null;

  const placeholder = 'Summary generates on next morning brief. Until then, see timeline below.';
  const showPlaceholder = body.length === 0;

  return (
    <section
      className="ai-block"
      aria-label="What you need to know"
      data-testid="ai-block"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--color-accent-2)]">
          WHAT YOU NEED TO KNOW
        </span>
        {cached ? (
          <span className="text-[11px] text-[color:var(--color-text-3)]">
            cached {relativeTime(cached)}
          </span>
        ) : null}
      </div>
      <p
        className="mt-3 text-[15px] leading-relaxed text-[color:var(--color-text)]"
        data-testid={showPlaceholder ? 'ai-block-placeholder' : 'ai-block-body'}
      >
        {showPlaceholder ? placeholder : body}
      </p>
    </section>
  );
}
