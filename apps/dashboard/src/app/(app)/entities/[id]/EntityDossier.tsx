/**
 * EntityDossier — the main Person / Project page body.
 *
 * Layout (UI-SPEC §View 2): entity header + main column (AI block +
 * linked work + timeline) + 260-320px stats rail. The two templates
 * differ only in the stats rail labels (handled in StatsRail.tsx) and
 * the header meta line — everything else is shared per D-03.
 *
 * SSE:
 *   - `entity_merge` for this entity id triggers a `router.refresh()` so
 *     the dossier re-fetches the canonical record. If Kevin's current
 *     entity was merged INTO a different canonical entity, dashboard-api
 *     will 404 on re-fetch and the boundary above handles it.
 */
'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { EntityResponse, TimelinePage } from '@kos/contracts/dashboard';
import { getBolagClass } from '@/lib/bolag';
import { useSseKind } from '@/components/system/SseProvider';

import { AiBlock } from './AiBlock';
import { LinkedWork } from './LinkedWork';
import { StatsRail } from './StatsRail';
import { Timeline } from './Timeline';
import { EditEntityDialog } from './EditEntityDialog';

export function EntityDossier({
  entity,
  initialTimeline,
}: {
  entity: EntityResponse;
  initialTimeline: TimelinePage;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const router = useRouter();

  const onEntityMerge = useCallback(
    (ev: { entity_id?: string }) => {
      if (ev.entity_id === entity.id) {
        // Canonical entity changed — re-fetch to either re-render or 404.
        router.refresh();
      }
    },
    [entity.id, router],
  );
  useSseKind('entity_merge', onEntityMerge);

  const bolagClass = getBolagClass(entity.org);
  const isProject = entity.type === 'Project';

  return (
    <div className="flex flex-col gap-6" data-testid="entity-dossier" data-type={entity.type}>
      <header className="flex items-start gap-4" data-testid="entity-header">
        <div
          aria-hidden
          className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-md)] bg-[color:var(--color-surface-2)] text-[15px] font-semibold text-[color:var(--color-text)]"
        >
          {(entity.name[0] ?? '?').toUpperCase()}
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
              {entity.name}
            </h1>
            {entity.org ? (
              <span className={`badge ${bolagClass}`} data-testid="bolag-chip">
                {entity.org}
              </span>
            ) : null}
            <span className="text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-text-3)]">
              {entity.status}
            </span>
          </div>
          <p className="text-[13px] text-[color:var(--color-text-2)]">
            {isProject
              ? `Project · Owner: ${entity.role ?? '—'} · Status: ${entity.status}`
              : `Person · Role: ${entity.role ?? '—'} · Org: ${entity.org ?? '—'}${
                  entity.relationship ? ` · ${entity.relationship}` : ''
                }`}
          </p>
          {entity.aliases.length > 0 ? (
            <p className="text-[11px] text-[color:var(--color-text-3)]">
              aka {entity.aliases.join(', ')}
            </p>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <main className="flex flex-col gap-7 min-w-0">
          <AiBlock entity={entity} />
          <LinkedWork entity={entity} />
          <section aria-label="Timeline">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--color-text-3)]">
                TIMELINE
              </span>
              <span className="text-[11px] text-[color:var(--color-text-3)]">
                {entity.stats.total_mentions} total
              </span>
            </div>
            <Timeline entityId={entity.id} initial={initialTimeline} />
          </section>
        </main>

        <StatsRail entity={entity} onEdit={() => setEditOpen(true)} />
      </div>

      <EditEntityDialog entity={entity} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
