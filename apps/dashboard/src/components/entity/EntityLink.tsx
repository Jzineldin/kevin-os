/**
 * EntityLink — the canonical `.ent` accent-2 link with dotted accent-border
 * underline used inline across Brief prose, priority rows, draft cards, and
 * the dossier timeline. Renders as a Next `<Link>` so client-side navigation
 * stays intact on Kevin's single-user dashboard.
 *
 * Design: 03-UI-SPEC.md §"View 1 — Today" (entity link treatment) +
 * §Accessibility rule 11 (entity links MUST be `<a>` elements with href).
 *
 * Focus ring uses `--color-accent` per the accent-bordered ring convention
 * (globals.css `.ent:focus-visible`).
 */
import Link from 'next/link';
import type { Route } from 'next';

export function EntityLink({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string;
}) {
  // typedRoutes=true on next.config — cast to Route since /entities/[id] is dynamic.
  const href = `/entities/${id}` as Route;
  return (
    <Link href={href} className={['ent', className].filter(Boolean).join(' ')}>
      {name}
    </Link>
  );
}
