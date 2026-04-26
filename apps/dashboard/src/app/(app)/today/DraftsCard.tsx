'use client';

/**
 * DraftsCard — v4 Drafts to Review section.
 *
 * Visual reference: mockup-v4.html § .draft-row
 *
 * Row anatomy per draft:
 *   HEAD : mono pill (channel) · "to" · entity link · bolag badge · time
 *   BODY : 2-line clamped prose inside a left-violet rule (sect-drafts)
 *   FOOT : Approve / Edit / Skip buttons — sized `sm`, primary/outline/ghost
 *
 * The v3 card-within-card treatment is gone. Rows are flush with the
 * panel body (bodyPadding="flush") and divided only by rails. This is
 * a substantial density win over the Phase 3 version without losing
 * any affordance.
 *
 * Approve / Edit / Skip actions still deep-link to /inbox (where actual
 * triage happens in Phase 3). Keeping them as navigation rather than
 * mutations is deliberate — no fake affordances (D-31).
 */
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { formatDistanceToNow, parseISO } from 'date-fns';

import type { TodayDraft } from '@kos/contracts/dashboard';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/dashboard/Panel';
import { BolagBadge } from '@/components/badge/BolagBadge';

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
  const count = drafts.length;
  return (
    <Panel
      tone="drafts"
      name="Drafts"
      count={count > 0 ? `· ${count} pending` : undefined}
      action={
        count > 0 ? (
          <Link href="/inbox" className="panel-action">
            Open inbox
          </Link>
        ) : undefined
      }
      bodyPadding="flush"
      aria-label="Drafts to review"
      testId="drafts-card"
    >
      {count === 0 ? (
        <div className="px-5 py-5 text-[13px] text-[color:var(--color-text-3)]">
          No drafts awaiting review. ✅
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {drafts.map((d) => (
            <motion.article
              key={d.id}
              className="draft-row"
              initial={MOTION.initial}
              animate={MOTION.animate}
              exit={MOTION.exit}
              transition={MOTION.transition}
            >
              <header className="draft-head">
                <span className="draft-chip">
                  {d.from ? `${d.from} · reply` : 'draft'}
                </span>
                {d.entity ? (
                  <>
                    <span>to</span>
                    <span className="ent">{d.entity}</span>
                    <BolagBadge org={d.entity} />
                  </>
                ) : null}
                <span className="panel-spread" />
                <span>drafted {relative(d.received_at)}</span>
              </header>

              {d.subject ? (
                <div className="mb-[10px] text-[14px] font-medium text-[color:var(--color-text)]">
                  {d.subject}
                </div>
              ) : null}

              <p className="draft-text line-clamp-2">{d.preview}</p>

              <div className="draft-actions">
                <Button asChild size="sm" variant="default">
                  <Link href="/inbox" data-testid="drafts-approve">
                    Approve &amp; send
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/inbox" data-testid="drafts-edit">
                    Edit
                  </Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/inbox" data-testid="drafts-skip">
                    Discard
                  </Link>
                </Button>
              </div>
            </motion.article>
          ))}
        </AnimatePresence>
      )}
    </Panel>
  );
}
