'use client';

import { useState, useTransition } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { TodayPriority } from '@kos/contracts/dashboard';
import { Panel, PanelAction } from '@/components/dashboard/Panel';
import { markPriorityDone, markPriorityDefer, delegateToZinclaw } from './actions';
import { toast } from 'sonner';

const MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0, marginTop: 0 },
  transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

function PriorityRow({ priority, index, onRemove }: {
  priority: TodayPriority;
  index: number;
  onRemove: (id: string) => void;
}) {
  const [, startTransition] = useTransition();
  const [delegating, setDelegating] = useState(false);

  const handleDone = () => {
    startTransition(async () => {
      try {
        await markPriorityDone(priority.id);
        onRemove(priority.id);
        toast.success('Marked as done ✓');
      } catch {
        toast.error('Failed to update — try again');
      }
    });
  };

  const handleDefer = () => {
    startTransition(async () => {
      try {
        await markPriorityDefer(priority.id);
        onRemove(priority.id);
        toast.success('Deferred ⏳');
      } catch {
        toast.error('Failed to defer — try again');
      }
    });
  };

  const handleDelegate = async () => {
    setDelegating(true);
    try {
      await delegateToZinclaw({
        kind: 'priority',
        id: priority.id,
        title: priority.title,
        context: `Bolag: ${priority.bolag ?? 'unknown'}`,
      });
      toast.success('💬 Sent to Zinclaw — check Discord DM');
    } catch {
      toast.error('Could not reach Zinclaw');
    } finally {
      setDelegating(false);
    }
  };

  return (
    <div className="pri-row group">
      <div className="pri-num">{String(index + 1).padStart(2, '0')}</div>
      <div className="min-w-0 flex-1">
        <div className="pri-title truncate">{priority.title}</div>
        {priority.bolag && (
          <div className="pri-meta">
            <span style={{ color: 'var(--color-text-4)', fontSize: 11 }}>{priority.bolag}</span>
          </div>
        )}
        {/* Action row — visible on hover */}
        <div
          className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100"
          style={{ transition: 'opacity 0.15s ease' }}
        >
          <button
            type="button"
            onClick={handleDone}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--color-success)', background: 'color-mix(in srgb, var(--color-success) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-success) 25%, transparent)',
              borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
            }}
          >
            ✓ Done
          </button>
          <button
            type="button"
            onClick={handleDefer}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--color-text-3)', background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)', borderRadius: 4,
              padding: '3px 8px', cursor: 'pointer',
            }}
          >
            ⏳ Defer
          </button>
          <button
            type="button"
            onClick={handleDelegate}
            disabled={delegating}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--color-sect-drafts)',
              background: 'color-mix(in srgb, var(--color-sect-drafts) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-sect-drafts) 25%, transparent)',
              borderRadius: 4, padding: '3px 8px', cursor: delegating ? 'default' : 'pointer',
              opacity: delegating ? 0.6 : 1,
            }}
          >
            {delegating ? '...' : '💬 Ask Zinclaw'}
          </button>
        </div>
      </div>
      <div className={`when${index === 0 ? ' soon' : ''}`}>
        {index === 0 ? 'DUE TODAY' : 'anytime'}
      </div>
    </div>
  );
}

export function PriorityList({ priorities }: { priorities: TodayPriority[] }) {
  const [items, setItems] = useState(priorities);
  const count = items.length;

  const handleRemove = (id: string) => {
    setItems(prev => prev.filter(p => p.id !== id));
  };

  return (
    <Panel
      tone="priority"
      name="Priorities"
      count={count > 0 ? `· Top ${Math.min(count, 3)}` : undefined}
      bodyPadding="flush"
      aria-label="Top 3 priorities"
      testId="priority-list"
    >
      {count === 0 ? (
        <div className="px-5 py-5 text-[13px] text-[color:var(--color-text-3)]">
          All clear — no open priorities. ✅
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {items.slice(0, 3).map((p, idx) => (
            <motion.div
              key={p.id}
              initial={MOTION.initial}
              animate={MOTION.animate}
              exit={MOTION.exit}
              transition={MOTION.transition}
            >
              <PriorityRow priority={p} index={idx} onRemove={handleRemove} />
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </Panel>
  );
}
