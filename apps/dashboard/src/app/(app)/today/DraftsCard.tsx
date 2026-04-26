'use client';

/**
 * DraftsCard — Drafts to Review section. Each draft card shows entity +
 * bolag + relative time in the header, a 2-line clamped preview, and
 * Approve / Edit / Skip buttons. List-insertion fades in per motion rule 6.
 *
 * The Approve / Edit / Skip actions are stubbed (they'll be wired to the
 * inbox Server Actions from Plan 03-09). Leaving them as visible but
 * non-functional buttons in this plan would violate the "no fake
 * affordances" rule — so they're disabled with a tooltip pointing at the
 * inbox view, which is where triage actually happens in Phase 3.
 */
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { formatDistanceToNow, parseISO } from 'date-fns';

import type { TodayDraft } from '@kos/contracts/dashboard';
import { Button } from '@/components/ui/button';

const MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as const },
};

function relative(iso: string): string {
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function DraftsCard({ drafts }: { drafts: TodayDraft[] }) {
  return (
    <section aria-label="Drafts to review">
      <div className="flex items-center">
        <div className="h-section">DRAFTS TO REVIEW</div>
        {drafts.length > 0 ? (
          <span className="count-chip mono" aria-hidden="true">
            {drafts.length}
          </span>
        ) : null}
      </div>
      {drafts.length === 0 ? (
        <div className="side-card">
          <p className="text-[13px] text-[color:var(--color-text-3)]">
            No drafts awaiting review. ✅
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {drafts.map((d) => (
              <motion.article
                key={d.id}
                className="draft-card"
                initial={MOTION.initial}
                animate={MOTION.animate}
                exit={MOTION.exit}
                transition={MOTION.transition}
              >
                <header className="flex items-center gap-2 text-[12px] text-[color:var(--color-text-3)]">
                  <span className="text-[color:var(--color-text-2)]">
                    {d.from ?? d.entity}
                  </span>
                  <span>·</span>
                  <span>{d.entity}</span>
                  <span>·</span>
                  <span className="mono">{relative(d.received_at)}</span>
                </header>
                {d.subject ? (
                  <div className="text-[14px] font-medium text-[color:var(--color-text)]">
                    {d.subject}
                  </div>
                ) : null}
                <p className="line-clamp-2 text-[13px] text-[color:var(--color-text-2)]">
                  {d.preview}
                </p>
                <div className="flex items-center gap-2">
                  <Button asChild size="sm" variant="default">
                    <Link href="/inbox" data-testid="drafts-approve">
                      Approve
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/inbox" data-testid="drafts-edit">
                      Edit
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/inbox" data-testid="drafts-skip">
                      Skip
                    </Link>
                  </Button>
                </div>
              </motion.article>
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
