/**
 * PulseDot — the single 6×6 pulsing dot that replaces all skeleton/spinner
 * loading states per 03-UI-SPEC.md §Motion Contract rule 5 + D-12.
 *
 * Tone selects the base color via CSS tokens; any interior component that
 * needs a loading affordance (SSE status light, brief header, composer
 * ack) uses this rather than authoring a bespoke pulse.
 *
 * The `.pulse-dot` class in globals.css already owns keyframes + size;
 * this component only injects the inline `background` override so every
 * caller sees the same 6×6 geometry and timing.
 */
export type PulseTone = 'success' | 'warning' | 'danger' | 'accent' | 'info';

export function PulseDot({
  tone = 'success',
  className,
}: {
  tone?: PulseTone;
  className?: string;
}) {
  const colorVar =
    tone === 'success'
      ? 'var(--color-success)'
      : tone === 'warning'
        ? 'var(--color-warning)'
        : tone === 'danger'
          ? 'var(--color-danger)'
          : tone === 'info'
            ? 'var(--color-info)'
            : 'var(--color-accent)';

  return (
    <span
      className={['pulse-dot', className].filter(Boolean).join(' ')}
      style={{ background: colorVar }}
      aria-hidden="true"
      data-tone={tone}
    />
  );
}
