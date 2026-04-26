'use client';

/**
 * InboxClient — the most keyboard-driven surface of Phase 3 (UI-04).
 * Two-pane Superhuman-style layout with:
 *
 *   - J / K     navigate queue (bounded)
 *   - Enter     approve focused item → approveInbox Server Action
 *   - E         toggle inline edit mode (textarea in the right pane)
 *   - S         skip focused item → skipInbox Server Action
 *   - Esc       leave edit mode (one level at a time)
 *   - D / A / R reserved (no binding, per 03-UI-SPEC line 373 — prevents
 *               destructive misfire if Kevin conflates them with
 *               destroy / archive / reject mental models)
 *
 * Optimistic updates use React 19 `useOptimistic` — approved/skipped rows
 * disappear instantly; on Server Action failure the toast surfaces
 * "Already handled elsewhere." (UI-SPEC line 559 verbatim) and the optimistic
 * state naturally re-syncs on next refresh. (useOptimistic only applies its
 * reducer for the duration of a transition; the post-catch commit reads
 * from the source-of-truth `items` state, so failed rows re-appear.)
 *
 * SSE integration:
 *   - `inbox_item`   — new row arrived; router.refresh() → RSC reloads
 *   - `draft_ready`  — ditto (drafts are a subset of inbox items per D-25)
 *   - `entity_merge` — re-render picks up new merge_resume items
 *
 * List insertion animation follows Motion rule 6: 4px slide-down + fade-in
 * via framer-motion `AnimatePresence`. Existing rows never reflow.
 * Selection change is INSTANT (Motion rule 8 extended to this surface —
 * `transition: none` on the selected row background).
 */
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

// Phase 11 D-05: terminal email statuses — rows in these states are
// read-only. Approve/Skip handlers no-op for them (defense-in-depth
// alongside the email-sender Lambda's idempotency on
// email_send_authorizations per Phase 4 D-24).
const TERMINAL_EMAIL_STATUSES: ReadonlySet<EmailDraftStatus> = new Set<
  EmailDraftStatus
>(['approved', 'sent', 'skipped', 'failed']);

export function isTerminalInboxItem(
  item: InboxItem | null | undefined,
): boolean {
  if (!item) return false;
  // dead_letter rows are also read-only (no Approve/Skip applicable).
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

  // Source-of-truth list (RSC-refresh-driven + local removal on success).
  const [items, setItems] = useState<InboxItem[]>(initialItems);
  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  // Optimistic view — removes the row by id for the duration of the
  // transition so J/K/Enter feels instant.
  const [optimistic, removeOptimistic] = useOptimistic<InboxItem[], string>(
    items,
    (cur, removeId) => cur.filter((i) => i.id !== removeId),
  );

  const initialIndex = useMemo(() => {
    if (!focusId) return 0;
    // focusId from Merge flow may be "resume-<mergeId>"; strip the prefix.
    const stripped = focusId.startsWith('resume-')
      ? focusId.slice('resume-'.length)
      : focusId;
    const byId = initialItems.findIndex((i) => i.id === focusId);
    if (byId >= 0) return byId;
    const byMerge = initialItems.findIndex((i) => i.merge_id === stripped);
    return byMerge >= 0 ? byMerge : 0;
  }, [initialItems, focusId]);

  const [selectedIdx, setSelectedIdx] = useState(initialIndex);
  const [editMode, setEditMode] = useState(false);
  const [, startTransition] = useTransition();

  // Clamp selectedIdx when the list shrinks (e.g., after successful approve).
  useEffect(() => {
    if (optimistic.length === 0) return;
    if (selectedIdx >= optimistic.length) {
      setSelectedIdx(optimistic.length - 1);
    }
  }, [optimistic.length, selectedIdx]);

  const selected = optimistic[selectedIdx] ?? null;
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // --- SSE: new items / draft / merge → refresh RSC ---------------------

  const onSseRefresh = useCallback(
    (label: string) => () => {
      announce(label);
      router.refresh();
    },
    [announce, router],
  );

  useSseKind('inbox_item', onSseRefresh('New inbox item'));
  useSseKind('draft_ready', onSseRefresh('New draft ready'));
  useSseKind('entity_merge', onSseRefresh('Merge status updated'));

  // --- Keyboard contract ------------------------------------------------

  const doApprove = useCallback(() => {
    const cur = selectedRef.current;
    if (!cur) return;
    // Phase 11 D-05 — terminal-status guard: read-only items don't fire.
    if (isTerminalInboxItem(cur)) {
      announce('Read-only item — no action available');
      return;
    }
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
    // Phase 11 D-05 — terminal-status guard.
    if (isTerminalInboxItem(cur)) {
      announce('Read-only item — no action available');
      return;
    }
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
        setSelectedIdx((i) => Math.min(i + 1, optimistic.length - 1));
        setEditMode(false);
      },
      k: (e: KeyboardEvent) => {
        if (isTypingInField(e.target)) return;
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
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
        if (editMode) {
          e.preventDefault();
          setEditMode(false);
        }
      },
      // NOTE: D / A / R are RESERVED — NO binding, per UI-SPEC line 373.
    }),
    [doApprove, doSkip, editMode, optimistic.length],
  );

  useKeys(bindings);

  const editInboxBound = useCallback(
    async (id: string, fields: Record<string, unknown>) => {
      await editInbox(id, fields);
    },
    [],
  );
  // Referenced so the import is not tree-shaken when ItemDetail edits via
  // its own transition. (ItemDetail also imports editInbox directly; this
  // local handle is kept for symmetry with approve/skip + future keyboard
  // binding for direct save-on-Enter in edit mode.)
  void editInboxBound;

  // --- Empty state ------------------------------------------------------

  if (optimistic.length === 0) {
    return (
      <div className="h-full grid place-items-center">
        <div className="text-center flex flex-col gap-3 items-center">
          <div className="flex items-center gap-2">
            <PulseDot tone="success" />
            <span
              className="font-medium"
              style={{ color: 'var(--color-text)' }}
            >
              {EMPTY_HEADLINE}
            </span>
          </div>
          <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>
            {EMPTY_BODY}
          </p>
        </div>
      </div>
    );
  }

  // --- Two-pane layout --------------------------------------------------

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: '280px 1fr',
        minHeight: 'calc(100vh - 52px - 64px)',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <aside
        className="flex flex-col overflow-auto"
        style={{
          borderRight: '1px solid var(--color-border)',
          background: 'var(--color-surface-1)',
        }}
      >
        <div
          className="sticky top-0 z-10 p-3 text-xs flex items-center gap-2"
          style={{
            background: 'var(--color-surface-1)',
            borderBottom: '1px solid var(--color-border)',
            color: 'var(--color-text-3)',
          }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={optimistic.length}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              data-testid="inbox-count"
            >
              {optimistic.length} pending
            </motion.span>
          </AnimatePresence>
        </div>

        <div className="flex-1">
          <AnimatePresence initial={false}>
            {optimistic.map((item, idx) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.18,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                <ItemRow
                  item={item}
                  selected={idx === selectedIdx}
                  onClick={() => {
                    setSelectedIdx(idx);
                    setEditMode(false);
                  }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div
          className="p-3 mono"
          style={{
            fontSize: 11,
            color: 'var(--color-text-4)',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          J / K to nav · Enter approve · E edit · S skip
        </div>
      </aside>

      <section className="overflow-auto">
        {selected ? (
          <ItemDetail
            item={selected}
            editMode={editMode}
            onEditRequest={() => setEditMode(true)}
            onEditDone={() => setEditMode(false)}
          />
        ) : (
          <div
            className="p-8"
            style={{ color: 'var(--color-text-3)' }}
          >
            Select an item
          </div>
        )}
      </section>
    </div>
  );
}
