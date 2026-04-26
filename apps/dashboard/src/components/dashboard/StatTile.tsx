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
        position: 'relative',
        border: '1px solid var(--color-border)',
        background: `linear-gradient(180deg, color-mix(in srgb, ${t.fg} 7%, var(--color-surface-1)) 0%, var(--color-surface-1) 60%)`,
        borderRadius: 16,
        padding: '22px 22px 20px',
        overflow: 'hidden',
        boxShadow: `0 1px 0 0 color-mix(in srgb, ${t.fg} 10%, transparent) inset, 0 8px 24px -12px rgba(0,0,0,0.5)`,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, ${t.fg} 0%, transparent 100%)`,
          opacity: 0.7,
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: t.bg,
            color: t.fg,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid color-mix(in srgb, ${t.fg} 25%, transparent)`,
            boxShadow: `0 0 0 4px color-mix(in srgb, ${t.fg} 6%, transparent)`,
          }}
        >
          <Icon size={16} />
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--color-text-3)',
          }}
        >
          {label}
        </span>
      </div>
      <p
        className="tabular-nums"
        style={{
          fontSize: 44,
          fontWeight: 600,
          lineHeight: 1,
          letterSpacing: '-0.02em',
          color: 'var(--color-text)',
          margin: 0,
          fontFeatureSettings: '"tnum" 1, "ss01" 1',
        }}
      >
        {value}
      </p>
    </div>
  );
}
