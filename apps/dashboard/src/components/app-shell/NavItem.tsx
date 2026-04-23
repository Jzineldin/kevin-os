'use client';

/**
 * NavItem — single sidebar row. Encodes two UI-SPEC rules:
 *
 *   1. Active state uses --color-accent-bg + --color-accent-2 (§Sidebar
 *      "Active state").
 *   2. Active state application is INSTANT — no transition — per §Motion
 *      rule 8. Hover transitions still apply via Tailwind's transition-colors
 *      on the idle path. We force `transition: none` inline on the active
 *      state so the toggle class swap does not animate.
 *
 * Disabled items (e.g. Chat "Ships with Phase 4") render a non-link span
 * with a shadcn Tooltip explaining why. aria-disabled=true preserves
 * screen-reader semantics.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';

export interface NavItemProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  count?: number;
  disabled?: boolean;
  disabledTooltip?: string;
}

const BASE =
  'flex items-center gap-[10px] rounded-md px-[10px] py-[6px] text-[13px] w-full';
const ACTIVE =
  'bg-[color:var(--color-accent-bg)] text-[color:var(--color-accent-2)]';
const IDLE =
  'text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-hover)] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)]';
const DISABLED =
  'text-[color:var(--color-text-4)] cursor-not-allowed';

export function NavItem({
  href,
  icon,
  label,
  kbd,
  count,
  disabled,
  disabledTooltip,
}: NavItemProps) {
  const pathname = usePathname();
  // `pathname` is null during testing environments or initial SSR hydration.
  const safePath = pathname ?? '';
  // href may include a querystring for entity filters — match against the
  // pathname portion only.
  const hrefPath = href.split('?')[0] ?? href;
  const active =
    !disabled &&
    hrefPath !== '' &&
    (safePath === hrefPath ||
      (hrefPath !== '/' && safePath.startsWith(hrefPath + '/')));

  const inner = (
    <span className="flex w-full items-center justify-between gap-2">
      <span className="flex items-center gap-[10px]">
        {icon}
        <span>{label}</span>
      </span>
      <span className="flex items-center gap-2">
        {typeof count === 'number' && count > 0 && (
          <span className="text-[11px] text-[color:var(--color-text-4)] font-mono">
            {count}
          </span>
        )}
        {kbd && <Kbd>{kbd}</Kbd>}
      </span>
    </span>
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
      className={`${BASE} ${active ? ACTIVE : IDLE}`}
      // Motion rule 8: instant active state toggle — no background transition.
      style={{ transition: active ? 'none' : undefined }}
    >
      {inner}
    </Link>
  );
}
