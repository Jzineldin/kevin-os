'use client';

/**
 * DroppedThreads — v4 Active Entities panel on the right rail.
 *
 * Visual reference: mockup-v4.html § Active entities panel
 *
 * Repurposes the Phase-3 "dropped-threads" data (entities whose last
 * touch has gone stale) into a compact avatar + name + bolag-tag row
 * list. Clicking a row still deep-links to the dossier. Renamed the
 * panel label to "Active entities" to match the v4 right-column intent
 * (quick jump to frequently-touched people/projects) while preserving
 * the underlying /today response field `dropped`.
 *
 * The v3 thread-avatar class is retained for the 28×28 initial circle.
 */
import Link from 'next/link';
import type { Route } from 'next';
import { AnimatePresence, motion } from 'framer-motion';

import type { TodayDroppedThread } from '@kos/contracts/dashboard';
import { Panel } from '@/components/dashboard/Panel';
import { BolagBadge } from '@/components/badge/BolagBadge';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function DroppedThreads({ items }: { items: TodayDroppedThread[] }) {
  return (
    <Panel
      tone="entities"
      name="Active entities"
      count={items.length > 0 ? `· dropped threads` : undefined}
      bodyPadding="tight"
      aria-label="Dropped threads"
      testId="dropped-threads"
    >
      {items.length === 0 ? (
        <p className="text-[12px] text-[color:var(--color-text-3)]">
          No stale threads.
        </p>
      ) : (
        <div className="flex flex-col gap-[10px]">
          <AnimatePresence initial={false}>
            {items.slice(0, 5).map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <Link
                  href={`/entities/${t.entity_id}` as Route}
                  className="flex items-center gap-[10px] no-underline"
                  data-testid="dropped-row"
                >
                  <span
                    aria-hidden
                    className="inline-grid place-items-center rounded-full text-[10px] font-semibold"
                    style={{
                      width: 24,
                      height: 24,
                      background: 'var(--color-surface-3)',
                      border: '1px solid var(--color-border-hover)',
                      color: 'var(--color-text-2)',
                    }}
                  >
                    {initials(t.entity)}
                  </span>
                  <span className="flex-1 truncate text-[13px] text-[color:var(--color-text)]">
                    {t.entity}
                  </span>
                  {t.bolag ? (
                    <BolagBadge org={t.bolag} />
                  ) : (
                    <span className="mono text-[10px] text-[color:var(--color-text-4)]">
                      {t.age_days < 1
                        ? 'today'
                        : t.age_days < 7
                          ? `${Math.round(t.age_days)}d`
                          : t.age_days < 30
                            ? `${Math.round(t.age_days / 7)}w`
                            : `${Math.round(t.age_days / 30)}mo`}
                    </span>
                  )}
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Panel>
  );
}
