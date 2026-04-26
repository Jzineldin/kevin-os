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

export function StatTileStrip({ data }: { data: StatTileData | undefined }) {
  const safe = data ?? ZERO;
  return (
    <div
      data-testid="stat-tile-strip"
      className="grid gap-[14px] mb-7"
      style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
    >
      <StatTile
        icon={CheckCheck}
        label="Priorities"
        value={safe.entities_active}
        tone="priority"
        delta={safe.entities_active > 0 ? '1 due today' : 'none'}
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
