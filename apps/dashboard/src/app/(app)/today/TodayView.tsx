'use client';

/**
 * TodayView — v4 client wrapper composing the Today layout.
 *
 * Visual reference: mockup-v4.html § wide-screen rethink
 *
 * Layout (top to bottom):
 *   1. Page head — inline title + meta + week/date
 *   2. KPI strip — 4-up full-width stat row
 *   3. 2-column grid, 60/40:
 *        LEFT  (1.5fr): Brief (hero) → Priorities → Drafts
 *        RIGHT (1fr)  : Schedule → Capture → Channels → Inbox preview
 *                       → Active entities (dropped)
 *
 * The previous 3-column rail layout is gone. 60/40 reads naturally on
 * a 27" without cramping the middle column, and on <1200px it
 * collapses to a single column (handled by the responsive Tailwind
 * grid classes).
 *
 * SSE behavior preserved: subscribes to `inbox_item` + `draft_ready`
 * to auto-refresh via router.refresh() and announces via LiveRegion.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';

import type { TodayResponse } from '@kos/contracts/dashboard';
import { useSseKind } from '@/components/system/SseProvider';
import { useLiveRegion } from '@/components/system/LiveRegion';
import { ChannelsCompact } from '@/components/dashboard/ChannelsCompact';

import { Brief } from './Brief';
import { PriorityList } from './PriorityList';
import { DraftsCard } from './DraftsCard';
import { DroppedThreads } from './DroppedThreads';
import { MeetingsSideCard } from './MeetingsSideCard';
import { Composer } from './Composer';
import { StatTileStrip } from './StatTileStrip';
import { PendingProposalsCard } from './PendingProposalsCard';
import { CapturesList } from './CapturesList';

export function TodayView({ data }: { data: TodayResponse }) {
  const router = useRouter();
  const { announce } = useLiveRegion();

  const onInbox = useCallback(() => {
    announce('New inbox item');
    router.refresh();
  }, [announce, router]);

  const onDraft = useCallback(() => {
    announce('New draft available');
    router.refresh();
  }, [announce, router]);

  useSseKind('inbox_item', onInbox);
  useSseKind('draft_ready', onDraft);

  const now = new Date();
  const dayLabel = format(now, 'EEEE, MMMM d');
  const weekLabel = `Week ${format(now, 'II')}`;

  return (
    <div className="stagger">
      {/* Row 1 — page head */}
      <header className="mb-[22px] flex items-baseline gap-[18px]">
        <h1 className="h-page">Today</h1>
        <span className="h-page-meta">{dayLabel}</span>
        <span className="flex-1" />
        <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-[color:var(--color-text-4)]">
          {weekLabel}
        </span>
      </header>

      {/* Row 2 — KPI strip */}
      <StatTileStrip
        data={data.stat_tiles}
        prioritiesCount={data.priorities.length}
      />

      {/* Row 3 — main 60/40 grid */}
      <div
        className="grid items-start gap-7"
        style={{
          gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
        }}
        data-slot="today-grid"
      >
        {/* LEFT column (60%) */}
        <section className="flex min-w-0 flex-col gap-6">
          <Brief brief={data.brief} />
          <PendingProposalsCard />
          <PriorityList priorities={data.priorities} />
          <DraftsCard drafts={data.drafts} />
        </section>

        {/* RIGHT column (40%) */}
        <aside className="flex min-w-0 flex-col gap-6">
          <MeetingsSideCard meetings={data.meetings} />
          <Composer />
          <ChannelsCompact channels={data.channels} />
          <CapturesList captures={data.captures_today} />
          <DroppedThreads items={data.dropped} />
        </aside>
      </div>
    </div>
  );
}
