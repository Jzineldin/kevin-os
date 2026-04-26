'use client';

/**
 * TodayView — client wrapper that composes the Today layout per
 * 03-UI-SPEC §"View 1 — Today" + Phase 11 D-07 mission-control rebuild.
 *
 * Layout (top to bottom):
 *   1. Page heading + meta line
 *   2. StatTileStrip — 4-up mission-control row (Phase 11 Plan 11-04)
 *   3. ChannelHealth strip — capture-channel snapshot (Plan 11-04)
 *   4. 2-column grid:
 *        main:  Brief → PriorityList → DraftsCard → DroppedThreads
 *        side:  MeetingsSideCard → Composer
 *   5. CapturesList — all-source today's-capture feed (Plan 11-04)
 *
 * Subscribes to SSE `inbox_item` + `draft_ready` kinds to auto-refresh
 * via `router.refresh()` when the pipeline emits new items, announcing
 * via the app-shell LiveRegion for a11y. Phase 11 D-14 preserves this
 * behavior — all new sections re-fetch in lockstep on SSE refresh
 * because they're sourced from the same RSC payload.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import type { TodayResponse } from '@kos/contracts/dashboard';
import { useSseKind } from '@/components/system/SseProvider';
import { useLiveRegion } from '@/components/system/LiveRegion';
import { ChannelHealth } from '@/components/dashboard/ChannelHealth';

import { Brief } from './Brief';
import { PriorityList } from './PriorityList';
import { DraftsCard } from './DraftsCard';
import { DroppedThreads } from './DroppedThreads';
import { MeetingsSideCard } from './MeetingsSideCard';
import { Composer } from './Composer';
import { StatTileStrip } from './StatTileStrip';
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

  const meta = [
    `${data.priorities.length} ${data.priorities.length === 1 ? 'prioritering' : 'prioriteringar'}`,
    `${data.drafts.length} drafts`,
    `${data.meetings.length} ${data.meetings.length === 1 ? 'möte' : 'möten'}`,
  ].join(' · ');

  return (
    <div className="fade-up">
      <div className="mb-6">
        <h1 className="h-page">Today</h1>
        <p className="h-page-meta mono">{meta}</p>
      </div>

      <StatTileStrip data={data.stat_tiles} />

      <div
        data-testid="channel-health-strip"
        style={{
          marginBottom: 24,
          padding: '16px 20px',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          background: 'var(--color-surface-1)',
        }}
      >
        <h2
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-text-3)',
            marginBottom: 12,
          }}
        >
          Channels
        </h2>
        <ChannelHealth channels={data.channels} />
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: '1fr 320px', gap: 32 }}
      >
        <section className="flex min-w-0 flex-col" style={{ gap: 28 }}>
          <Brief brief={data.brief} />
          <PriorityList priorities={data.priorities} />
          <DraftsCard drafts={data.drafts} />
          <DroppedThreads items={data.dropped} />
        </section>
        <aside className="flex flex-col" style={{ gap: 24 }}>
          <MeetingsSideCard meetings={data.meetings} />
          <Composer />
        </aside>
      </div>

      <div style={{ marginTop: 24 }}>
        <CapturesList captures={data.captures_today} />
      </div>
    </div>
  );
}
