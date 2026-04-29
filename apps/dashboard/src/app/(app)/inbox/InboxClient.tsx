'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type {
  EmailDraftStatus,
  InboxItem,
} from '@kos/contracts/dashboard';
import { PulseDot } from '@/components/system/PulseDot';
import { useLiveRegion } from '@/components/system/LiveRegion';
import { useSseKind } from '@/components/system/SseProvider';
import { isTypingInField, useKeys } from '@/lib/tinykeys';

import { approveInbox, editInbox, skipInbox } from './actions';
import { ItemDetail } from './ItemDetail';
import { ItemRow } from './ItemRow';

const CONFLICT_COPY = 'Already handled elsewhere.';
const EMPTY_HEADLINE = 'Inbox clear. ✅';
const EMPTY_BODY = 'Nothing to review. KOS surfaces drafts as they arrive.';
const PAGE_SIZE = 13;

const TERMINAL_EMAIL_STATUSES: ReadonlySet<EmailDraftStatus> = new Set<EmailDraftStatus>([
  'approved', 'sent', 'skipped', 'failed',
]);

export function isTerminalInboxItem(item: InboxItem | null | undefined): boolean {
  if (!item) return false;
  if (item.kind === 'dead_letter') return true;
  if (!item.email_status) return false;
  return TERMINAL_EMAIL_STATUSES.has(item.email_status);
}

export function InboxClient({
  initialItems,
  focusId,
}: {
  initialItems: InboxItem[];
  focusId: string | null;
}) {
  const router = useRouter();
  const { announce } = useLiveRegion();

  const [items, setItems] = useState<InboxItem[]>(initialItems);
  useEffect(() => { setItems(initialItems); }, [initialItems]);

  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(0);

  // Filter: by default hide already-handled items
  const filteredItems = useMemo(() => {
    if (showAll) return items;
    return items.filter(i => !isTerminalInboxItem(i));
  }, [items, showAll]);

  const [optimistic, removeOptimistic] = useOptimistic<InboxItem[], string>(
    filteredItems,
    (cur, removeId) => cur.filter((i) => i.id !== removeId),
  );

  // Page slicing
  const totalPages = Math.max(1, Math.ceil(optimistic.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageItems = optimistic.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  const skippedCount = useMemo(() =>
    items.filter(i => isTerminalInboxItem(i)).length, [items]);
  const pendingCount = items.length - skippedCount;

  const initialIndex = useMemo(() => {
    if (!focusId) return 0;
    const stripped = focusId.startsWith('resume-') ? focusId.slice('resume-'.length) : focusId;
    const byId = initialItems.findIndex((i) => i.id === focusId);
    if (byId >= 0) return byId;
    const byMerge = initialItems.findIndex((i) => i.merge_id === stripped);
    return byMerge >= 0 ? byMerge : 0;
  }, [initialItems, focusId]);

  const [selectedIdx, setSelectedIdx] = useState(initialIndex);
  const [editMode, setEditMode] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (pageItems.length === 0) return;
    if (selectedIdx >= pageItems.length) setSelectedIdx(pageItems.length - 1);
  }, [pageItems.length, selectedIdx]);

  const selected = pageItems[selectedIdx] ?? null;
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const onSseRefresh = useCallback(
    (label: string) => () => { announce(label); router.refresh(); },
    [announce, router],
  );
  useSseKind('inbox_item', onSseRefresh('New inbox item'));
  useSseKind('draft_ready', onSseRefresh('New draft ready'));
  useSseKind('entity_merge', onSseRefresh('Merge status updated'));

  const doApprove = useCallback(() => {
    const cur = selectedRef.current;
    if (!cur) return;
    if (isTerminalInboxItem(cur)) { announce('Read-only item'); return; }
    const id = cur.id;
    const title = cur.title;
    announce(`Approving ${title}`);
    startTransition(async () => {
      removeOptimistic(id);
      try {
        await approveInbox(id);
        setItems((prev) => prev.filter((i) => i.id !== id));
        announce(`Approved ${title}`);
      } catch {
        toast.error(CONFLICT_COPY, { duration: 4_000 });
      }
    });
  }, [announce, removeOptimistic]);

  const doSkip = useCallback(() => {
    const cur = selectedRef.current;
    if (!cur) return;
    if (isTerminalInboxItem(cur)) { announce('Read-only item'); return; }
    const id = cur.id;
    const title = cur.title;
    announce(`Skipping ${title}`);
    startTransition(async () => {
      removeOptimistic(id);
      try {
        await skipInbox(id);
        setItems((prev) => prev.filter((i) => i.id !== id));
        announce(`Skipped ${title}`);
      } catch {
        toast.error(CONFLICT_COPY, { duration: 4_000 });
      }
    });
  }, [announce, removeOptimistic]);

  const bindings = useMemo(
    () => ({
      j: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        const nextIdx = selectedIdx + 1;
        if (nextIdx < pageItems.length) {
          setSelectedIdx(nextIdx);
        } else if (clampedPage < totalPages - 1) {
          setPage(clampedPage + 1);
          setSelectedIdx(0);
        }
        setEditMode(false);
      },
      k: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        if (selectedIdx > 0) {
          setSelectedIdx(selectedIdx - 1);
        } else if (clampedPage > 0) {
          setPage(clampedPage - 1);
          setSelectedIdx(PAGE_SIZE - 1);
        }
        setEditMode(false);
      },
      Enter: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        doApprove();
      },
      e: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        if (selectedRef.current) setEditMode(true);
      },
      s: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        doSkip();
      },
      Escape: (e: KeyboardEvent) => {
        if (editMode) { e.preventDefault(); setEditMode(false); }
      },
    }),
    [doApprove, doSkip, editMode, selectedIdx, pageItems.length, clampedPage, totalPages],
  );
  useKeys(bindings);

  const editInboxBound = useCallback(
    async (id: string, fields: Record<string, unknown>) => { await editInbox(id, fields); },
    [],
  );
  void editInboxBound;

  // Empty state (no pending)
  if (optimistic.length === 0 && !showAll) {
    return (
      <div>
        <div className="h-full grid place-items-center py-24">
          <div className="text-center flex flex-col gap-3 items-center">
            <div className="flex items-center gap-[10px]">
              <PulseDot tone="success" />
              <span className="text-[15px] font-medium" style={{ color: 'var(--color-text)' }}>
                {EMPTY_HEADLINE}
              </span>
            </div>
            <p className="text-[13px]" style={{ color: 'var(--color-text-3)', maxWidth: 380, lineHeight: 1.55 }}>
              {EMPTY_BODY}
            </p>
            {skippedCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mt-2 text-[12px] font-mono uppercase tracking-wider"
                style={{ color: 'var(--color-text-4)' }}
              >
                Show {skippedCount} handled items
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid rounded-lg overflow-hidden border"
      style={{
        gridTemplateColumns: '360px 1fr',
        minHeight: 'calc(100vh - 52px - 64px)',
        borderColor: 'var(--color-border)',
        background: 'var(--color-surface-1)',
        boxShadow: 'var(--shadow-1)',
      }}
    >
      {/* LEFT: queue list */}
      <aside
        className="flex flex-col overflow-hidden"
        style={{ borderRight: '1px solid var(--color-border)', background: 'var(--color-surface-1)' }}
        aria-label="Inbox queue"
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 flex items-center gap-[10px]"
          style={{
            background: 'color-mix(in srgb, var(--color-surface-1) 90%, transparent)',
            backdropFilter: 'blur(6px)',
            borderBottom: '1px solid var(--rail)',
            padding: '12px 16px',
          }}
        >
          <span aria-hidden style={{
            width: 6, height: 6, borderRadius: 999,
            background: 'var(--color-sect-inbox)',
            boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-sect-inbox) 15%, transparent)',
          }} />
          <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-sect-inbox)' }}>
            {showAll ? 'All' : 'Queue'}
          </span>
          <span className="font-mono ml-1" style={{ fontSize: 11, color: 'var(--color-text-4)' }}>
            {showAll ? `${items.length} total` : `${pendingCount} pending`}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => { setShowAll(v => !v); setPage(0); setSelectedIdx(0); }}
            className="font-mono"
            style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-text-4)', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--color-border)' }}
          >
            {showAll ? 'Pending only' : `+${skippedCount} handled`}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          <AnimatePresence initial={false}>
            {pageItems.map((item, idx) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                style={{ borderBottom: '1px solid var(--rail)' }}
              >
                <ItemRow
                  item={item}
                  selected={idx === selectedIdx}
                  onClick={() => { setSelectedIdx(idx); setEditMode(false); }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{
              borderTop: '1px solid var(--rail)',
              padding: '10px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--color-surface-1)',
            }}
          >
            <button
              type="button"
              disabled={clampedPage === 0}
              onClick={() => { setPage(p => Math.max(0, p - 1)); setSelectedIdx(0); }}
              className="font-mono"
              style={{
                fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: clampedPage === 0 ? 'var(--color-text-4)' : 'var(--color-text-2)',
                padding: '4px 10px', borderRadius: 4, border: '1px solid var(--color-border)',
                cursor: clampedPage === 0 ? 'default' : 'pointer',
              }}
            >
              ← Prev
            </button>
            <span className="font-mono flex-1 text-center" style={{ fontSize: 10, color: 'var(--color-text-4)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              {clampedPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={clampedPage >= totalPages - 1}
              onClick={() => { setPage(p => Math.min(totalPages - 1, p + 1)); setSelectedIdx(0); }}
              className="font-mono"
              style={{
                fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: clampedPage >= totalPages - 1 ? 'var(--color-text-4)' : 'var(--color-text-2)',
                padding: '4px 10px', borderRadius: 4, border: '1px solid var(--color-border)',
                cursor: clampedPage >= totalPages - 1 ? 'default' : 'pointer',
              }}
            >
              Next →
            </button>
          </div>
        )}

        {/* Keyboard hint */}
        <div className="mono" style={{
          fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--color-text-4)', borderTop: '1px solid var(--rail)',
          padding: '10px 16px', background: 'var(--color-surface-1)',
        }}>
          J / K nav · ↵ approve · E edit · S skip
        </div>
      </aside>

      {/* RIGHT: detail pane */}
      <section className="overflow-auto">
        {selected ? (
          <ItemDetail
            item={selected}
            editMode={editMode}
            onEditRequest={() => setEditMode(true)}
            onEditDone={() => setEditMode(false)}
          />
        ) : (
          <div className="p-8" style={{ color: 'var(--color-text-3)' }}>
            Select an item
          </div>
        )}
      </section>
    </div>
  );
}
