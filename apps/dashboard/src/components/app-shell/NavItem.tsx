'use client';

/**
 * NavItem — single sidebar row in the v4 visual system.
 *
 * v4 behavior (mockup-v4 § Sidebar):
 *   1. Active state = surface-2 bg + accent-rail 3px on the left edge,
 *      colored by the route's section tone (`tone` prop).
 *   2. Motion rule 8 preserved — active-state toggle is INSTANT
 *      (no background transition on the active class).
 *   3. Hover on idle items = surface-2 fade, 140ms.
 *   4. Icon inherits the section tone only on the active row; idle
 *      rows use text-3 for the icon so the sidebar reads calmly.
 *   5. Count chip = tabular mono, surface-3 pill, right-aligned.
 *   6. Kbd hint = tiny mono, surface-1 pill, border-hover outline.
 *
 * Disabled items render a non-link span with a Tooltip explaining why.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';

/**
 * Section tone tokens consumed by NavItem for its active-state rail
 * color. Mirrors the six --color-sect-* variables in globals.css so
 * each route's tone is colocated with the rest of the v4 visual map.
 */
export type NavTone =
  | 'priority' // Today
  | 'inbox'
  | 'schedule' // Calendar
  | 'drafts' // Chat
  | 'channels' // Health
  | 'entities' // People / Projects
  | 'neutral';

const TONE_VAR: Record<NavTone, string> = {
  priority: 'var(--color-sect-priority)',
  inbox: 'var(--color-sect-inbox)',
  schedule: 'var(--color-sect-schedule)',
  drafts: 'var(--color-sect-drafts)',
  channels: 'var(--color-sect-channels)',
  entities: 'var(--color-sect-entities)',
  neutral: 'var(--color-text-3)',
};

export interface NavItemProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  count?: number;
  tone?: NavTone;
  disabled?: boolean;
  disabledTooltip?: string;
  /** Optional data-testid for parametric Playwright button-audit tests (Phase 11). */
  testId?: string;
}

const BASE =
  'relative flex items-center gap-[11px] rounded-md px-3 py-2 text-[14px] w-full font-medium';
const ACTIVE = 'bg-[color:var(--color-surface-2)] text-[color:var(--color-text)]';
const IDLE =
  'text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]';
const DISABLED = 'text-[color:var(--color-text-4)] cursor-not-allowed';

export function NavItem({
  href,
  icon,
  label,
  kbd,
  count,
  tone = 'neutral',
  disabled,
  disabledTooltip,
  testId,
}: NavItemProps) {
  const pathname = usePathname();
  const safePath = pathname ?? '';
  const hrefPath = href.split('?')[0] ?? href;
  const active =
    !disabled &&
    hrefPath !== '' &&
    (safePath === hrefPath ||
      (hrefPath !== '/' && safePath.startsWith(hrefPath + '/')));

  const toneVar = TONE_VAR[tone];

  const inner = (
    <>
      {/* Active-state left rail — 3px, section-tone colored. The
          sidebar container applies overflow:visible so this can peek
          out over the sidebar's own right border. */}
      {active ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-[10px] bottom-[10px] -left-[14px] w-[3px] rounded-r-sm"
          style={{ background: toneVar }}
        />
      ) : null}
      <span
        className="shrink-0 flex items-center justify-center"
        style={{
          color: active ? toneVar : 'var(--color-text-3)',
          width: 16,
          height: 16,
        }}
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {typeof count === 'number' && count > 0 ? (
        <span
          className="inline-flex min-w-[20px] items-center justify-center rounded-[3px] border px-1.5 py-px font-mono text-[10px] text-[color:var(--color-text-3)]"
          style={{
            background: 'var(--color-surface-3)',
            borderColor: 'var(--color-border)',
          }}
        >
          {count}
        </span>
      ) : null}
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </>
  );

  if (disabled) {
    const node = (
      <span
        aria-disabled="true"
        data-slot="nav-item"
        data-active="false"
        data-disabled="true"
        className={`${BASE} ${DISABLED}`}
      >
        {inner}
      </span>
    );
    if (!disabledTooltip) return node;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent>{disabledTooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      // Typed routes is enabled; `href` here is passed as a plain string by
      // callers that know their paths, so cast upstream if needed.
      href={href as never}
      data-slot="nav-item"
      data-active={active ? 'true' : 'false'}
      data-tone={tone}
      data-testid={testId}
      className={`${BASE} ${active ? ACTIVE : IDLE}`}
      // Motion rule 8: instant active state toggle — no background transition.
      style={{ transition: active ? 'none' : undefined }}
    >
      {inner}
    </Link>
  );
}
