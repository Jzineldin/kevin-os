/**
 * /entities list page — RSC entry.
 *
 * Resolves paper cut #1 from the 2026-04-24 v2 handoff: the sidebar's
 * "People" and "Projects" nav items linked to `/entities?type=person` and
 * `/entities?type=project` but this route did not exist, producing 404s
 * on every click. The detail route at `/entities/[id]` already shipped;
 * this file supplies the missing list view that sidebar links target.
 *
 * Design decisions:
 *   - Reuses `getPaletteEntities()` — the same server helper the command
 *     palette uses (hits dashboard-api `/entities/list` via SigV4). Single
 *     source of truth: if the endpoint changes shape, both surfaces update
 *     together. No second code path duplicated for the sidebar.
 *   - Graceful fallback on invalid/missing `?type=` — renders the ALL
 *     view with filter chips rather than 404ing or throwing.
 *   - Server-rendered only. No `'use client'`, no SSE refresh loop. This
 *     is a list Kevin navigates to; entity additions are rare and he
 *     triggered them. If an `entity_added` SSE kind lands later, a
 *     follow-up quick task can wire `router.refresh()`.
 *   - Swedish-first locale sort per CLAUDE.md bilingual constraint.
 *   - Rows link to `/entities/${id}` (existing dossier route).
 */
import Link from 'next/link';
import { Users, Folder, Building2, FileText, HelpCircle } from 'lucide-react';

import {
  getPaletteEntities,
  type PaletteEntity,
} from '@/components/palette/palette-root';

export const dynamic = 'force-dynamic';

const KNOWN_TYPES = ['person', 'project', 'company', 'document'] as const;
type KnownType = (typeof KNOWN_TYPES)[number];

const TITLES: Record<KnownType | 'all', string> = {
  person: 'People',
  project: 'Projects',
  company: 'Companies',
  document: 'Documents',
  all: 'Entities',
};

function isKnownType(value: string | undefined): value is KnownType {
  return (
    typeof value === 'string' &&
    (KNOWN_TYPES as readonly string[]).includes(value)
  );
}

function EntityIcon({ type }: { type: string }) {
  const className = 'text-[color:var(--color-text-3)]';
  const size = 14;
  switch (type) {
    case 'person':
      return <Users size={size} className={className} />;
    case 'project':
      return <Folder size={size} className={className} />;
    case 'company':
      return <Building2 size={size} className={className} />;
    case 'document':
      return <FileText size={size} className={className} />;
    default:
      return <HelpCircle size={size} className={className} />;
  }
}

const FILTER_CHIPS: Array<{ type: KnownType; label: string }> = [
  { type: 'person', label: 'People' },
  { type: 'project', label: 'Projects' },
  { type: 'company', label: 'Companies' },
  { type: 'document', label: 'Documents' },
];

export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const filterType: KnownType | null = isKnownType(type) ? type : null;

  const entities = await getPaletteEntities();
  // `getPaletteEntities` returns [] on failure; no try/catch needed here.
  const filtered: PaletteEntity[] = (
    filterType
      ? entities.filter((e) => e.type === filterType)
      : [...entities]
  ).sort((a, b) => a.name.localeCompare(b.name, 'sv'));

  const title = TITLES[filterType ?? 'all'];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[20px] font-semibold text-[color:var(--color-text)]">
          {title}
        </h1>
        <p className="text-[13px] text-[color:var(--color-text-3)]">
          {filtered.length}{' '}
          {filtered.length === 1 ? 'entity' : 'entities'}
        </p>
      </div>

      {filterType === null && (
        <nav
          aria-label="Filter entities by type"
          className="flex flex-wrap gap-2"
        >
          {FILTER_CHIPS.map((chip) => (
            <Link
              key={chip.type}
              href={`/entities?type=${chip.type}`}
              className="inline-flex items-center gap-2 rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-[12px] text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
            >
              <EntityIcon type={chip.type} />
              <span>{chip.label}</span>
            </Link>
          ))}
        </nav>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-md border border-[color:var(--color-border)] px-4 py-6 text-[13px] text-[color:var(--color-text-3)]">
          No {title.toLowerCase()} yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((e) => (
            <li key={e.id}>
              <Link
                href={`/entities/${e.id}`}
                className="flex items-center gap-3 rounded-md px-[10px] py-[8px] text-[13px] text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
              >
                <EntityIcon type={e.type} />
                <span className="flex-1 truncate text-[color:var(--color-text)]">
                  {e.name}
                </span>
                {e.bolag && (
                  <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]">
                    {e.bolag}
                  </span>
                )}
                <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]">
                  {e.type}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
