/**
 * StatTileStrip — top-of-Today mission-control 4-tile row.
 *
 * Renders the four stat tiles defined in 11-CONTEXT.md "specifics §1":
 *   CAPTURES TODAY / DRAFTS PENDING / ENTITIES ACTIVE / EVENTS UPCOMING
 *
 * Data is supplied by the /today response payload's `stat_tiles` field
 * (Plan 11-04 Task 1). When the field is undefined (e.g. degraded /today
 * fetch), tiles render zero values rather than blanking — D-12 calm
 * empty-state policy applies even at the section level.
 *
 * Tonal palette (per Plan 11-02 design tokens):
 *   captures  → accent  (purple — primary capture stream)
 *   drafts    → warning (amber — awaiting Kevin's review)
 *   entities  → success (green — active relationships)
 *   events    → info    (blue — upcoming calendar)
 */
import { Inbox, FileText, Users, CalendarDays } from 'lucide-react';
import { StatTile } from '@/components/dashboard/StatTile';
import { StatTileGrid } from '@/components/dashboard/StatTileGrid';
import type { StatTileData } from '@kos/contracts/dashboard';

const ZERO: StatTileData = {
  captures_today: 0,
  drafts_pending: 0,
  entities_active: 0,
  events_upcoming: 0,
};

export function StatTileStrip({ data }: { data: StatTileData | undefined }) {
  const safe = data ?? ZERO;
  return (
    <div data-testid="stat-tile-strip" style={{ marginBottom: 24 }}>
      <StatTileGrid>
        <StatTile
          icon={Inbox}
          label="CAPTURES TODAY"
          value={safe.captures_today}
          tone="accent"
        />
        <StatTile
          icon={FileText}
          label="DRAFTS PENDING"
          value={safe.drafts_pending}
          tone="warning"
        />
        <StatTile
          icon={Users}
          label="ENTITIES ACTIVE"
          value={safe.entities_active}
          tone="success"
        />
        <StatTile
          icon={CalendarDays}
          label="EVENTS UPCOMING"
          value={safe.events_upcoming}
          tone="info"
        />
      </StatTileGrid>
    </div>
  );
}
