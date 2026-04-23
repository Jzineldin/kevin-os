'use client';

/**
 * DroppedThreads — entities whose last-touch timestamp has grown stale.
 * Clicking a row deep-links to the dossier. Per UI-SPEC §Today, renders
 * inside a `.side-card` with 28×28 initial avatars.
 */
import Link from 'next/link';
import type { Route } from 'next';
import { AnimatePresence, motion } from 'framer-motion';

import type { TodayDroppedThread } from '@kos/contracts/dashboard';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function ago(days: number): string {
  if (days < 1) return 'today';
  if (days < 7) return `${Math.round(days)}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function DroppedThreads({ items }: { items: TodayDroppedThread[] }) {
  return (
    <section aria-label="Dropped threads">
      <div className="h-section">DROPPED THREADS</div>
      <div className="side-card">
        {items.length === 0 ? (
          <p className="text-[13px] text-[color:var(--color-text-3)]">
            All threads are active.
          </p>
        ) : (
          <AnimatePresence initial={false}>
            {items.map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <Link
                  href={`/entities/${t.entity_id}` as Route}
                  className="thread-row"
                >
                  <span className="thread-avatar" aria-hidden="true">
                    {initials(t.entity)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="thread-title truncate">{t.entity}</div>
                    <div className="thread-meta mono">{ago(t.age_days)}</div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </section>
  );
}
