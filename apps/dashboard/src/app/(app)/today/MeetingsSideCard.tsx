'use client';

/**
 * MeetingsSideCard — today's meetings rail. Mono 56px `meeting-time` +
 * title + meta per UI-SPEC. Active meeting uses `meeting-now` accent-2.
 *
 * Phase 3: meetings come from Command Center Deadlines (not Google
 * Calendar — that's Phase 8). The response shape is the same either way.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { format, parseISO } from 'date-fns';

import type { TodayMeeting } from '@kos/contracts/dashboard';
import { BolagBadge } from '@/components/badge/BolagBadge';

function hhmm(iso: string): string {
  try {
    return format(parseISO(iso), 'HH:mm');
  } catch {
    return '--:--';
  }
}

export function MeetingsSideCard({ meetings }: { meetings: TodayMeeting[] }) {
  return (
    <section aria-label="Today's meetings" className="side-card">
      <div className="h-section">TODAY</div>
      {meetings.length === 0 ? (
        <p className="text-[13px] text-[color:var(--color-text-3)]">
          Nothing on your calendar today.
        </p>
      ) : (
        <AnimatePresence initial={false}>
          {meetings.map((m) => (
            <motion.div
              key={m.id}
              className="meeting-row"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              <div
                className={`meeting-time${m.is_now ? ' meeting-now' : ''}`}
              >
                {hhmm(m.start_at)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="meeting-title truncate">{m.title}</div>
                <div className="meeting-meta flex items-center gap-2">
                  <BolagBadge org={m.bolag} />
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </section>
  );
}
