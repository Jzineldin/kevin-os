/**
 * Brief — v4 Morning Brief hero block on /today.
 *
 * Visual reference: mockup-v4.html § .hero-brief
 *
 * This is the one visually distinct surface on the Today view. It does
 * NOT use <Panel /> — the hero carries its own treatment (radial amber
 * glow in the top-right, no bordered header) so it pulls the eye first
 * without being a different "colored box" competing with the other
 * panels below. The exception is deliberate, documented, and scoped
 * here only.
 *
 * Body text renders at 17px with a 1.6 line-height in the brief palette
 * (text-1 on surface-1 + glow tint). `.hi` highlighted spans use the
 * sect-brief amber to tag named entities the brief references — the
 * three things that matter today.
 *
 * Phase 3 still serves a placeholder body until Phase 7 AUTO-01 ships
 * the real generated brief. The brief-dot pulsing var(--color-success)
 * signals pipeline health even when the body is placeholder.
 */
import type { TodayBrief } from '@kos/contracts/dashboard';

const PLACEHOLDER = 'Brief generated daily at 07:00 — ships with Phase 7.';

export function Brief({ brief }: { brief: TodayBrief | null }) {
  const body = brief?.body ?? PLACEHOLDER;
  const hasBrief = Boolean(brief?.body);

  return (
    <article
      className="hero-brief"
      data-slot="hero-brief"
      aria-label="AI Morning Brief"
    >
      <header className="hero-brief-meta">
        <span className="dot" aria-hidden />
        <span>AI Morning Brief</span>
        <span className="sub">· 07:02</span>
      </header>

      <p className="hero-brief-body">{body}</p>

      {hasBrief ? (
        <div className="hero-brief-foot">
          <span>
            <span className="k">Sources</span>{' '}
            <span className="v">gmail · calendar · notion</span>
          </span>
          <span>
            <span className="k">Generated</span>{' '}
            <span className="v">07:02</span>
          </span>
        </div>
      ) : null}
    </article>
  );
}
