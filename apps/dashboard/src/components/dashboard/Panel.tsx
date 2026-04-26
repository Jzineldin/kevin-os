/**
 * Panel — v4 shared panel primitive.
 *
 * Visual reference: mockup-v4.html § .panel + .p-head + .p-body
 *
 * Every section on /today (and the other views in phase 5) is built from
 * this same shell, only the tone and children differ. Keeping it in one
 * file means any future tweak to panel chrome (e.g. header height, rail
 * treatment, divider color) happens once.
 *
 * Tone drives the header dot + name color. The body offers three
 * paddings: `default` (20px), `tight` (14px/20px), `flush` (no padding,
 * for list panels where the child rows handle their own indent).
 *
 * Not a shadcn component — this is an in-house compositional primitive
 * sitting above the token layer. The shadcn <Card /> is retained for
 * quieter surfaces that don't need a labelled header.
 */
import type { ReactNode } from 'react';

export type PanelTone =
  | 'priority'
  | 'brief'
  | 'schedule'
  | 'drafts'
  | 'inbox'
  | 'channels'
  | 'entities';

const TONE_VAR: Record<PanelTone, string> = {
  priority: 'var(--color-sect-priority)',
  brief: 'var(--color-sect-brief)',
  schedule: 'var(--color-sect-schedule)',
  drafts: 'var(--color-sect-drafts)',
  inbox: 'var(--color-sect-inbox)',
  channels: 'var(--color-sect-channels)',
  entities: 'var(--color-sect-entities)',
};

export interface PanelProps {
  tone: PanelTone;
  /** Uppercase mono section name (e.g. "Priorities"). */
  name: string;
  /** Optional mono sub-label rendered after the name in text-4 (e.g. "· 3"). */
  count?: ReactNode;
  /** Optional right-aligned action link or button. */
  action?: ReactNode;
  /** `flush` removes .panel-body padding; `tight` keeps the 14/20 vertical. */
  bodyPadding?: 'default' | 'tight' | 'flush';
  children: ReactNode;
  /** Passed through for layout tests / targeted Playwright selectors. */
  testId?: string;
  /** Accessible landmark label. */
  'aria-label'?: string;
}

export function Panel({
  tone,
  name,
  count,
  action,
  bodyPadding = 'default',
  children,
  testId,
  'aria-label': ariaLabel,
}: PanelProps) {
  const bodyClass =
    bodyPadding === 'flush'
      ? 'panel-body flush'
      : bodyPadding === 'tight'
        ? 'panel-body tight'
        : 'panel-body';

  return (
    <section
      className="panel"
      data-slot="panel"
      data-tone={tone}
      data-testid={testId}
      aria-label={ariaLabel}
      style={{ ['--tone' as string]: TONE_VAR[tone] }}
    >
      <header className="panel-head">
        <span className="panel-dot" aria-hidden />
        <span className="panel-name">{name}</span>
        {count !== undefined && count !== null ? (
          <span className="panel-count">{count}</span>
        ) : null}
        <span className="panel-spread" />
        {action}
      </header>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/**
 * PanelAction — small mono uppercase text-button for the right side of
 * the panel header. Hover swaps to surface-2 + text-1. Keeps the
 * primary action visually quiet so it doesn't compete with the panel
 * content.
 */
export function PanelAction({
  children,
  onClick,
  type = 'button',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  testId?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      className="panel-action"
      data-testid={testId}
    >
      {children}
    </button>
  );
}
