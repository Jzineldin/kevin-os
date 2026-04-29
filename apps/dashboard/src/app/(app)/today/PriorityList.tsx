'use client';

import { useState, useTransition, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { TodayPriority } from '@kos/contracts/dashboard';
import { Panel, PanelAction } from '@/components/dashboard/Panel';
import { markPriorityDone, markPriorityDefer, delegateToZinclaw } from './actions';
import { toast } from 'sonner';

const STORAGE_KEY = 'kos:dismissed-priorities';
const MOTION = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, height: 0, marginTop: 0 },
  transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

function getDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(arr);
  } catch { return new Set(); }
}

function addDismissed(id: string) {
  if (typeof window === 'undefined') return;
  try {
    const dismissed = getDismissed();
    dismissed.add(id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch {}
}

function PriorityRow({ priority, index, onRemove }: {
  priority: TodayPriority;
  index: number;
  onRemove: (id: string) => void;
}) {
  const [, startTransition] = useTransition();
  const [delegating, setDelegating] = useState(false);

  const handleDone = () => {
    // Optimistic remove + persist dismissal immediately
    addDismissed(priority.id);
    onRemove(priority.id);
    startTransition(async () => {
      try {
        await markPriorityDone(priority.id);
        toast.success('Marked as done ✓');
      } catch {
        toast.error('Failed to update Notion — try again');
        // Don't un-remove from UI; user can refresh if needed
      }
    });
  };

  const handleDefer = () => {
    addDismissed(priority.id);
    onRemove(priority.id);
    startTransition(async () => {
      try {
        await markPriorityDefer(priority.id);
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
      toast.success('💬 Sent to #kos-development — Zinclaw will respond there');
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
          <PanelAction onClick={handleDone} title="Mark done">✓ Done</PanelAction>
          <PanelAction onClick={handleDefer} title="Defer">⏳ Defer</PanelAction>
          <PanelAction
            onClick={handleDelegate}
            title="Ask Zinclaw"
            disabled={delegating}
          >
            {delegating ? '…' : '💬 Ask Zinclaw'}
          </PanelAction>
        </div>
      </div>
      {priority.due === 'today' && (
        <span
          className="font-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--color-accent)',
            background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
            padding: '2px 7px',
            borderRadius: 4,
            alignSelf: 'flex-start',
            marginTop: 2,
          }}
        >
          DUE TODAY
        </span>
      )}
    </div>
  );
}

export function PriorityList({ priorities }: { priorities: TodayPriority[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Load dismissed set from localStorage on mount (client-only)
  useEffect(() => {
    setDismissed(getDismissed());
  }, []);

  const [items, setItems] = useState(priorities);

  // When server sends new priorities (e.g. after revalidation), merge but keep dismissed hidden
  useEffect(() => {
    setItems(priorities);
  }, [priorities]);

  const visible = items.filter(p => !dismissed.has(p.id));

  const handleRemove = (id: string) => {
    setDismissed(prev => new Set([...prev, id]));
    setItems(prev => prev.filter(p => p.id !== id));
  };

  return (
    <Panel
      label="PRIORITIES"
      badge={`Top ${visible.length}`}
      accent="var(--color-sect-actions)"
    >
      {visible.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--color-text-4)', padding: '12px 0' }}>
          All clear — no open priorities. ✅
        </p>
      ) : (
        <AnimatePresence initial={false}>
          {visible.map((p, i) => (
            <motion.div key={p.id} {...MOTION}>
              <PriorityRow priority={p} index={i} onRemove={handleRemove} />
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </Panel>
  );
}
