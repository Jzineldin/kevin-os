'use client';

/**
 * TodayView — client wrapper that composes the Today layout per
 * 03-UI-SPEC §"View 1 — Today". Subscribes to SSE `inbox_item` +
 * `draft_ready` kinds to auto-refresh the drafts section when the pipeline
 * emits new items, announcing via the app-shell LiveRegion for a11y.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import type { TodayResponse } from '@kos/contracts/dashboard';
import { useSseKind } from '@/components/system/SseProvider';
import { useLiveRegion } from '@/components/system/LiveRegion';

import { Brief } from './Brief';
import { PriorityList } from './PriorityList';
import { DraftsCard } from './DraftsCard';
import { DroppedThreads } from './DroppedThreads';
import { MeetingsSideCard } from './MeetingsSideCard';
import { Composer } from './Composer';

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
    </div>
  );
}
