'use client';

/**
 * PriorityList — v4 Top 3 Priorities section.
 *
 * Visual reference: mockup-v4.html § .pri-row (inside the Priorities
 * panel). Row layout:
 *
 *   [ 32px num ] [ 1fr title + meta ] [ auto when-pill ]
 *
 * `.when.soon` (amber) and `.when.now` (sect-priority blue) variants
 * replace the old fixed "anytime/DUE 16:00" strings — the pill itself
 * carries the urgency. A row with neither flag renders the plain
 * surface-2 variant.
 *
 * Animation primitive unchanged: AnimatePresence wraps row insertions
 * so SSE-driven refreshes animate a 4px fade-up slide per motion rule 6.
 */
import { AnimatePresence, motion } from 'framer-motion';

import type { TodayPriority } from '@kos/contracts/dashboard';
import { EntityLink } from '@/components/entity/EntityLink';
import { BolagBadge } from '@/components/badge/BolagBadge';
import { Panel, PanelAction } from '@/components/dashboard/Panel';

const MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const },
};

export function PriorityList({ priorities }: { priorities: TodayPriority[] }) {
  const count = priorities.length;
  return (
    <Panel
      tone="priority"
      name="Priorities"
      count={count > 0 ? `· Top ${Math.min(count, 3)}` : undefined}
      action={count > 1 ? <PanelAction>Reprioritize</PanelAction> : undefined}
      bodyPadding="flush"
      aria-label="Top 3 priorities"
      testId="priority-list"
    >
      {count === 0 ? (
        <div className="px-5 py-5 text-[13px] text-[color:var(--color-text-3)]">
          No priorities yet. KOS surfaces them from Command Center every
          morning.
        </div>
      ) : (
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
                    <span className="ent">{p.entity_name}</span>
                  ) : null}
                  <BolagBadge org={p.bolag} />
                </div>
              </div>
              <div
                className={`when${idx === 0 ? ' soon' : ''}`}
                aria-label="when"
              >
                {idx === 0 ? 'DUE TODAY' : 'anytime'}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </Panel>
  );
}
