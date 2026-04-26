'use client';

/**
 * MeetingsSideCard — v4 Schedule timeline for /today.
 *
 * Visual reference: mockup-v4.html § .schedule + .meet-row
 *
 * Left-padded 78px timeline with a faint vertical rail that intensifies
 * between 40% and 60% height (emphasising the "now" middle of the day).
 * Each meeting row has an absolute-positioned mono time on the left,
 * a dot on the rail, and the title + meta on the right.
 *
 * The `.meet-row.now` variant replaces the old `.meeting-now` class —
 * it tints both the dot (sect-schedule fill with halo) and the time
 * label (sect-schedule text) and renders a "starts in Nm" pill above
 * the title.
 *
 * Phase 3: meetings still come from Command Center Deadlines (not
 * Google Calendar — that's Phase 8). The response shape is the same.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { format, parseISO } from 'date-fns';

import type { TodayMeeting } from '@kos/contracts/dashboard';
import { Panel } from '@/components/dashboard/Panel';

function hhmm(iso: string): string {
  try {
    return format(parseISO(iso), 'HH:mm');
  } catch {
    return '--:--';
  }
}

function minsUntil(iso: string): number | null {
  try {
    const diff = parseISO(iso).getTime() - Date.now();
    if (diff <= 0) return null;
    return Math.round(diff / 60_000);
  } catch {
    return null;
  }
}

export function MeetingsSideCard({ meetings }: { meetings: TodayMeeting[] }) {
  return (
    <Panel
      tone="schedule"
      name="Schedule"
      count={
        meetings.length > 0
          ? `· ${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`
          : undefined
      }
      aria-label="Today's meetings"
      testId="meetings-side"
    >
      {meetings.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-text-3)]">
          Nothing on your calendar today.
        </p>
      ) : (
        <div className="schedule">
          <AnimatePresence initial={false}>
            {meetings.map((m) => {
              const mins = m.is_now ? null : minsUntil(m.start_at);
              return (
                <motion.div
                  key={m.id}
                  className={`meet-row${m.is_now ? ' now' : ''}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="meet-time">{hhmm(m.start_at)}</div>
                  {m.is_now ? (
                    <div className="now-pill">
                      <span>in progress</span>
                    </div>
                  ) : mins !== null && mins <= 60 ? (
                    <div className="now-pill">
                      <span>starts in {mins}m</span>
                    </div>
                  ) : null}
                  <div className="meet-title truncate">{m.title}</div>
                  {m.bolag ? (
                    <div className="meet-sub">{m.bolag}</div>
                  ) : null}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </Panel>
  );
}
