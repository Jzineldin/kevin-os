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
    <div className="stagger flex flex-col gap-6">
      <header>
        <h1 className="h-page" style={{ marginBottom: 8 }}>
          {title}
        </h1>
        <p className="h-page-meta">
          {filtered.length}{' '}
          {filtered.length === 1 ? 'entity' : 'entities'}
          {filterType ? ` · filtered to ${filterType}` : ''}
        </p>
      </header>

      {filterType === null && (
        <nav
          aria-label="Filter entities by type"
          className="flex flex-wrap gap-2"
        >
          {FILTER_CHIPS.map((chip) => (
            <Link
              key={chip.type}
              href={`/entities?type=${chip.type}`}
              className="inline-flex items-center gap-[8px] rounded-md border px-3 h-[30px] text-[12px] font-medium transition-[background,border-color,color] duration-[var(--transition-fast)] ease-[var(--ease)]"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-surface-2)',
                color: 'var(--color-text-2)',
              }}
              data-testid={`entity-filter-${chip.type}`}
            >
              <EntityIcon type={chip.type} />
              <span>{chip.label}</span>
            </Link>
          ))}
        </nav>
      )}

      {filtered.length === 0 ? (
        <div
          className="rounded-lg border px-5 py-6"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface-1)',
            boxShadow: 'var(--shadow-1)',
            color: 'var(--color-text-3)',
            fontSize: 13,
          }}
        >
          No {title.toLowerCase()} yet.
        </div>
      ) : (
        <ul
          className="overflow-hidden rounded-lg border"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface-1)',
            boxShadow: 'var(--shadow-1)',
          }}
        >
          {filtered.map((e, i) => (
            <li
              key={e.id}
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--rail)',
              }}
            >
              <Link
                href={`/entities/${e.id}`}
                className="flex items-center gap-3 px-[18px] py-[11px] text-[13px] transition-colors duration-[var(--transition-fast)] ease-[var(--ease)] hover:bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)]"
              >
                <EntityIcon type={e.type} />
                <span className="flex-1 truncate text-[color:var(--color-text)]" style={{ fontWeight: 500, letterSpacing: '-0.003em' }}>
                  {e.name}
                </span>
                {e.bolag && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.12em',
                      color: 'var(--color-text-4)',
                    }}
                  >
                    {e.bolag}
                  </span>
                )}
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 3,
                    background:
                      'color-mix(in srgb, var(--color-sect-entities) 10%, transparent)',
                    border:
                      '1px solid color-mix(in srgb, var(--color-sect-entities) 26%, transparent)',
                    color: 'var(--color-sect-entities)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    fontWeight: 600,
                  }}
                >
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
