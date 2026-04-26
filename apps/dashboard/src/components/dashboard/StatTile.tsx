/**
 * StatTile — caps-label + giant numeric tile for the mission-control top strip.
 *
 * Visual reference: 11-RESEARCH.md "Visual Pattern Reference" — top stat row
 * (CAPTURES TODAY / DRAFTS PENDING / ENTITIES ACTIVE / EVENTS UPCOMING).
 * Analog: PulseDot (single-purpose primitive with tone variants).
 *
 * Renders a tonal icon chip + uppercase label + large tabular-number value.
 * No glassmorphism / .macos-panel — flat surface-1 over the existing token system.
 */
import type { ComponentType, SVGProps } from 'react';
import { TONES, type Tone } from '@/lib/design-tokens';

type IconType = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

export function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'accent',
}: {
  icon: IconType;
  label: string;
  value: number | string;
  tone?: Tone;
}) {
  const t = TONES[tone];
  return (
    <div
      className="mc-stat-tile"
      data-tone={tone}
      style={{
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface-1)',
        borderRadius: 16,
        padding: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: t.bg,
            color: t.fg,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon size={14} />
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-text-3)',
          }}
        >
          {label}
        </span>
      </div>
      <p
        className="tabular-nums"
        style={{
          fontSize: 28,
          fontWeight: 300,
          color: 'var(--color-text)',
          margin: 0,
        }}
      >
        {value}
      </p>
    </div>
  );
}
