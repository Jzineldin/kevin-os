'use client';

/**
 * PriorityList — Top 3 Priorities section. Each row shows a mono 01/02/03
 * priority number, the title, an entity link + bolag badge in the meta row,
 * and right-side pri-actions that fade in on hover (per UI-SPEC motion).
 *
 * AnimatePresence wraps row insertions so SSE-driven refreshes animate a
 * 4px fade-in slide per motion rule 6 (list-insertion only).
 */
import { AnimatePresence, motion } from 'framer-motion';

import type { TodayPriority } from '@kos/contracts/dashboard';
import { EntityLink } from '@/components/entity/EntityLink';
import { BolagBadge } from '@/components/badge/BolagBadge';

const MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const },
};

export function PriorityList({ priorities }: { priorities: TodayPriority[] }) {
  return (
    <section aria-label="Top 3 priorities">
      <div className="flex items-center">
        <div className="h-section">TOP 3 PRIORITIES</div>
        {priorities.length > 0 ? (
          <span className="count-chip mono" aria-hidden="true">
            {priorities.length}
          </span>
        ) : null}
      </div>
      {priorities.length === 0 ? (
        <div className="side-card">
          <p className="text-[13px] text-[color:var(--color-text-3)]">
            No priorities yet. KOS surfaces them from Command Center every morning.
          </p>
        </div>
      ) : (
        <div className="priority-list">
          <AnimatePresence initial={false}>
            {priorities.slice(0, 3).map((p, idx) => (
              <motion.div
                key={p.id}
                className="pri-row"
                initial={MOTION.initial}
                animate={MOTION.animate}
                exit={MOTION.exit}
                transition={MOTION.transition}
              >
                <div className="pri-num">
                  {String(idx + 1).padStart(2, '0')}
                </div>
                <div className="min-w-0">
                  <div className="pri-title truncate">{p.title}</div>
                  <div className="pri-meta">
                    {p.entity_id && p.entity_name ? (
                      <EntityLink id={p.entity_id} name={p.entity_name} />
                    ) : p.entity_name ? (
                      <span className="ent-tag">{p.entity_name}</span>
                    ) : null}
                    <BolagBadge org={p.bolag} />
                  </div>
                </div>
                <div className="pri-actions" aria-hidden="true" />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
