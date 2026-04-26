/**
 * Pill — D-05 (classification, status) → visual pill component.
 *
 * Source mapping: 11-RESEARCH.md "Pill mapping for D-05" lines 204-216.
 * Analog component: BolagBadge (apps/dashboard/src/components/badge/BolagBadge.tsx)
 * — single-purpose tinted pill driven by typed inputs and a small lookup table.
 *
 * Tone resolution flows through TONES from `@/lib/design-tokens`, which only
 * references `--color-*` tokens already declared in globals.css @theme. Adding
 * a new tone requires extending TONES + globals.css together; this component
 * stays thin.
 */
import { TONES, type Tone } from '@/lib/design-tokens';

export type Classification =
  | 'urgent'
  | 'important'
  | 'informational'
  | 'junk'
  | null
  | undefined;

export type Status =
  | 'pending_triage'
  | 'draft'
  | 'edited'
  | 'approved'
  | 'sent'
  | 'failed'
  | 'skipped';

interface PillSpec {
  label: string;
  tone: Tone;
  pulse?: boolean;
}

/**
 * D-05 mapping: (classification, status) → visual pill spec.
 * Pre-triage and skipped status overrides take precedence over classification.
 */
function resolvePill(
  classification: Classification,
  status: Status,
): PillSpec {
  if (status === 'pending_triage')
    return { label: 'Triaging…', tone: 'accent', pulse: true };
  if (status === 'skipped') return { label: 'Skipped', tone: 'dim' };

  switch (classification) {
    case 'urgent':
      if (status === 'draft')
        return { label: 'URGENT — Draft ready', tone: 'danger' };
      if (status === 'edited')
        return { label: 'URGENT — Edited', tone: 'warning' };
      if (status === 'approved')
        return { label: 'URGENT — Sending…', tone: 'info' };
      if (status === 'sent')
        return { label: 'URGENT — Sent', tone: 'success' };
      if (status === 'failed')
        return { label: 'URGENT — Failed', tone: 'danger' };
      return { label: 'URGENT', tone: 'danger' };
    case 'important':
      return { label: 'Important', tone: 'info' };
    case 'informational':
      return { label: 'FYI', tone: 'neutral' };
    case 'junk':
      return { label: 'Junk', tone: 'dim' };
    default:
      return { label: 'Triaging…', tone: 'accent', pulse: true };
  }
}

export function Pill({
  classification,
  status,
  className,
}: {
  classification: Classification;
  status: Status;
  className?: string;
}) {
  const spec = resolvePill(classification, status);
  const tone = TONES[spec.tone];
  return (
    <span
      className={['mc-pill', className].filter(Boolean).join(' ')}
      data-tone={spec.tone}
      data-pulse={spec.pulse ? 'true' : 'false'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.02,
        color: tone.fg,
        background: tone.bg,
      }}
    >
      {spec.pulse ? <span className="pulse-dot" aria-hidden /> : null}
      {spec.label}
    </span>
  );
}
