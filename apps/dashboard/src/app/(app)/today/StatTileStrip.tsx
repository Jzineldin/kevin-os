/**
 * StatTileStrip — v4 top-of-Today KPI strip.
 *
 * Visual reference: mockup-v4.html § .kpis row
 *
 * Four horizontal stat tiles that use the full content width of the
 * main column — the one thing big screens are actually for. Tones map
 * 1:1 onto the section palette so each KPI previews the section you'd
 * jump to (priority blue → Priorities panel, drafts violet → Drafts
 * panel, etc.), giving the page a consistent color grammar top to
 * bottom.
 *
 * When /today can't provide stat_tiles the tiles render zeros — D-12
 * calm empty-state policy applies even at the section level.
 */
import { CheckCheck, FileEdit, CalendarClock, InboxIcon } from 'lucide-react';

import { StatTile } from '@/components/dashboard/StatTile';
import type { StatTileData } from '@kos/contracts/dashboard';

const ZERO: StatTileData = {
  captures_today: 0,
  drafts_pending: 0,
  entities_active: 0,
  events_upcoming: 0,
};

export function StatTileStrip({
  data,
  prioritiesCount,
}: {
  data: StatTileData | undefined;
  prioritiesCount?: number;
}) {
  const safe = data ?? ZERO;
  // Priorities tile shows the length of the top-3 list (real, surfaceable
  // tasks Kevin acts on today). stat_tiles.entities_active is a count of
  // people/projects in entity_index and usually 0 until the entities DB
  // starts getting populated — wrong thing to show here.
  const pCount = prioritiesCount ?? 0;
  return (
    <div
      data-testid="stat-tile-strip"
      className="grid gap-[14px] mb-7"
      style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
    >
      <StatTile
        icon={CheckCheck}
        label="Priorities"
        value={pCount}
        tone="priority"
        delta={pCount > 0 ? 'today' : 'none'}
      />
      <StatTile
        icon={FileEdit}
        label="Drafts pending"
        value={safe.drafts_pending}
        tone="drafts"
        delta={safe.drafts_pending > 0 ? 'awaiting review' : 'caught up'}
      />
      <StatTile
        icon={CalendarClock}
        label="Meetings"
        value={safe.events_upcoming}
        tone="schedule"
        delta={safe.events_upcoming > 0 ? 'next 24h' : 'empty day'}
      />
      <StatTile
        icon={InboxIcon}
        label="Captures today"
        value={safe.captures_today}
        tone="inbox"
        delta="all sources"
      />
    </div>
  );
}
