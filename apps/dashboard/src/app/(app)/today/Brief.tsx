/**
 * Brief — the Morning Brief card. Per 03-CONTEXT D-05, Phase 3 renders a
 * placeholder until Phase 7 AUTO-01 ships the real generated brief.
 *
 * The brief-dot pulses `--color-success` to signal the pipeline is healthy
 * even when the brief body is the placeholder string.
 */
import type { TodayBrief } from '@kos/contracts/dashboard';

const PLACEHOLDER = 'Brief generated daily at 07:00 — ships with Phase 7.';

export function Brief({ brief }: { brief: TodayBrief | null }) {
  const body = brief?.body ?? PLACEHOLDER;
  return (
    <article className="brief fade-up" aria-label="AI Morning Brief">
      <header className="mb-3 flex items-center gap-2 text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-text-3)]">
        <span className="brief-dot" aria-hidden="true" />
        <span>AI Morning Brief · 07:00</span>
      </header>
      <p
        className="text-[15px] text-[color:var(--color-text-2)]"
        style={{ lineHeight: 1.65 }}
      >
        {body}
      </p>
    </article>
  );
}
