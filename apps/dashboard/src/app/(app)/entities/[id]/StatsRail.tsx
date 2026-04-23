/**
 * Per-entity stats side rail + Edit / Merge CTAs (UI-SPEC §View 2 side rail).
 *
 * Person variant shows: First contact · Total mentions · Last activity ·
 *   Linked projects · Active threads.
 * Project variant shows: Owner · Status · Deadline · Last activity ·
 *   Linked entities.
 *
 * Edit button is a client-bridge that opens `EditEntityDialog` (controlled
 * via the `onEdit` callback). "Merge duplicates" is a plain link to
 * `/entities/[id]/merge` per D-27 (Plan 11 renders the merge page).
 */
'use client';

import Link from 'next/link';
import type { EntityResponse } from '@kos/contracts/dashboard';
import { Button } from '@/components/ui/button';

function relativeDays(iso: string | null): string {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const days = Math.floor(d / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="pstat-label">{label}</div>
      <div className="pstat-value">{value}</div>
    </div>
  );
}

export function StatsRail({
  entity,
  onEdit,
}: {
  entity: EntityResponse;
  onEdit: () => void;
}) {
  const stats =
    entity.type === 'Project' ? (
      <>
        <Stat label="Owner" value={entity.role ?? '—'} />
        <Stat label="Status" value={entity.status ?? '—'} />
        <Stat label="Last activity" value={relativeDays(entity.last_touch)} />
        <Stat label="Linked entities" value={entity.linked_projects.length} />
        <Stat label="Total mentions" value={entity.stats.total_mentions} />
      </>
    ) : (
      <>
        <Stat label="First contact" value={relativeDays(entity.stats.first_contact)} />
        <Stat label="Total mentions" value={entity.stats.total_mentions} />
        <Stat label="Last activity" value={relativeDays(entity.last_touch)} />
        <Stat label="Linked projects" value={entity.linked_projects.length} />
        <Stat label="Active threads" value={entity.stats.active_threads} />
      </>
    );

  return (
    <aside
      className="flex flex-col gap-4 min-w-[260px] max-w-[320px]"
      data-testid="stats-rail"
    >
      <div className="flex flex-col gap-4 rounded-[var(--radius-xl)] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5">
        {stats}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          data-testid="edit-entity-button"
        >
          Edit entity
        </Button>
        <Link
          href={`/entities/${entity.id}/merge` as never}
          className="text-center text-[12px] text-[color:var(--color-text-3)] hover:text-[color:var(--color-text-2)] transition-colors"
          data-testid="merge-duplicates-link"
        >
          Merge duplicates
        </Link>
      </div>
    </aside>
  );
}
