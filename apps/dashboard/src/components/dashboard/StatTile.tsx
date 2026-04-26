/**
 * StatTile — v4 compact KPI tile for the top strip on /today.
 *
 * Visual reference: mockup-v4.html § .kpi
 *
 * Layout: horizontal row (icon chip · label + value/delta stack) with a
 * 2px left-edge rail colored by the section tone. This is a significant
 * departure from the Phase 11 StatTile — denser, wider, no colored top
 * rail + no large hero number. v4 puts the big numbers inline with the
 * label so the four-up strip reads as a single data band instead of
 * four competing cards.
 *
 * Props additive: optional `delta` renders after the value as a mono
 * micro-label ("1 due today", "▲ 12 vs yesterday"). TodayView uses this
 * for the live row; /integrations-health uses the base version without
 * delta.
 */
import type { ComponentType, ReactNode, SVGProps } from 'react';

export type StatTileTone =
  | 'priority'
  | 'brief'
  | 'schedule'
  | 'drafts'
  | 'inbox'
  | 'channels'
  | 'entities';

const TONE_VAR: Record<StatTileTone, string> = {
  priority: 'var(--color-sect-priority)',
  brief: 'var(--color-sect-brief)',
  schedule: 'var(--color-sect-schedule)',
  drafts: 'var(--color-sect-drafts)',
  inbox: 'var(--color-sect-inbox)',
  channels: 'var(--color-sect-channels)',
  entities: 'var(--color-sect-entities)',
};

type IconType = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

export function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'priority',
  delta,
}: {
  icon: IconType;
  label: string;
  value: number | string;
  tone?: StatTileTone;
  /** Optional delta / sub-label rendered after the value in mono-12. */
  delta?: ReactNode;
}) {
  const toneVar = TONE_VAR[tone];
  return (
    <div
      className="kpi"
      data-tone={tone}
      style={{ ['--tone' as string]: toneVar }}
    >
      <span className="kpi-ico" aria-hidden>
        <Icon size={16} strokeWidth={1.7} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[1px]">
        <span className="kpi-lbl">{label}</span>
        <div className="flex items-baseline gap-2">
          <span className="kpi-val tabular-nums">{value}</span>
          {delta ? <span className="kpi-delta">{delta}</span> : null}
        </div>
      </div>
    </div>
  );
}
