/**
 * Per-entity timeline — react-window v2 virtualization + cursor
 * pagination + SSE-driven new-row fade-in.
 *
 * Phase 3 invariants (UI-SPEC §View 2 + RESEARCH §10):
 *   - First 50 rows SSR'd via the RSC parent.
 *   - `react-window@2` `<List rowComponent={...} rowProps={{rows}} />`
 *     shape (NOT v1's render-prop API; see RESEARCH §17 P-13).
 *   - Cursor-paginated loadMore triggered when `stopIndex` lands within
 *     10 rows of the current tail (instant feel — no animation per
 *     UI-SPEC motion rule 6: "only on new rows arriving via SSE").
 *   - SSE `timeline_event` for a matching `entity_id` re-fetches the
 *     first page and prepends new rows with an AnimatePresence fade +
 *     4 px slide-down; existing rows DO NOT reflow.
 *   - Row rendering: `grid-template-columns: 20px 88px 1fr` per
 *     UI-SPEC timeline row spec; 2-line clamped italic snippet for
 *     quoted content (`line-clamp-2`).
 *   - Row href sanitised at runtime (T-3-10-05) — only `/...`,
 *     `https://`, `http://` accepted; any other scheme (incl. `javascript:`)
 *     drops to `#`.
 */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { AnimatePresence, motion } from 'framer-motion';
import type {
  TimelinePage,
  TimelineRow,
  TimelineRowKind,
} from '@kos/contracts/dashboard';
import { useSseKind } from '@/components/system/SseProvider';

const KIND_ICON: Record<TimelineRowKind, string> = {
  email: '✉', // ✉
  transcript: '🎙', // 🎙
  doc: '📄', // 📄
  task: '✓', // ✓
  decision: '⚡', // ⚡
  merge: '⟲', // ⟲
  mention: '·', // ·
  agent_run: '·', // ·
};

function safeHref(raw: string | null): string {
  if (!raw) return '#';
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://')
  ) {
    return trimmed;
  }
  return '#';
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('sv-SE', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type RowProps = { rows: TimelineRow[]; newIds: Set<string> };

function Row({ index, style, rows, newIds }: RowComponentProps<RowProps>) {
  const r = rows[index];
  if (!r) return null;
  const icon = KIND_ICON[r.kind] ?? '·';
  const href = safeHref(r.href);
  const isNew = newIds.has(r.id);

  const content = (
    <div
      className="timeline-row grid items-start"
      style={{
        gridTemplateColumns: '20px 88px 1fr',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px dashed var(--color-border)',
      }}
      data-testid="timeline-row"
      data-kind={r.kind}
    >
      <div
        aria-hidden
        className="mono text-[11px] text-[color:var(--color-text-3)] leading-5"
      >
        {icon}
      </div>
      <time
        className="mono text-[11px] text-[color:var(--color-text-3)] leading-5"
        dateTime={r.occurred_at}
      >
        {formatTimestamp(r.occurred_at)}
      </time>
      <div className="min-w-0">
        <div className="text-[13px] text-[color:var(--color-text)]">{r.source}</div>
        <div className="tl-snippet text-[12px] text-[color:var(--color-text-2)] italic line-clamp-2">
          {r.context}
        </div>
      </div>
    </div>
  );

  const inner = isNew ? (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
    >
      {content}
    </motion.div>
  ) : (
    content
  );

  return (
    <a
      href={href}
      style={style}
      role="listitem"
      className="block px-0"
      aria-posinset={index + 1}
    >
      {inner}
    </a>
  );
}

export function Timeline({
  entityId,
  initial,
}: {
  entityId: string;
  initial: TimelinePage;
}) {
  const [rows, setRows] = useState<TimelineRow[]>(initial.rows);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  const [loading, setLoading] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());

  // Dedup set for SSE replay (Plan 07 contract — handlers must be idempotent).
  const seenRef = useRef<Set<string>>(new Set(initial.rows.map((r) => r.id)));

  const loadMore = useCallback(async () => {
    if (loading || !cursor) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/entities/${entityId}/timeline?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) return;
      const page = (await res.json()) as TimelinePage;
      setRows((prev) => {
        const existing = new Set(prev.map((r) => r.id));
        const next = page.rows.filter((r) => !existing.has(r.id));
        for (const r of next) seenRef.current.add(r.id);
        return [...prev, ...next];
      });
      setCursor(page.next_cursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, entityId, loading]);

  const onSseTimeline = useCallback(
    (ev: { entity_id?: string }) => {
      // Scope filter — only refresh when the event belongs to this entity.
      if (ev.entity_id !== entityId) return;
      void fetch(`/api/entities/${entityId}/timeline`)
        .then((r) => (r.ok ? (r.json() as Promise<TimelinePage>) : null))
        .then((p) => {
          if (!p) return;
          const incomingNewIds = new Set<string>();
          const prepended: TimelineRow[] = [];
          for (const r of p.rows) {
            if (seenRef.current.has(r.id)) continue;
            seenRef.current.add(r.id);
            incomingNewIds.add(r.id);
            prepended.push(r);
          }
          if (prepended.length === 0) return;
          setNewIds((prev) => {
            const merged = new Set(prev);
            for (const id of incomingNewIds) merged.add(id);
            return merged;
          });
          setRows((prev) => [...prepended, ...prev]);
          // Clear the "new" flag after the animation window so the row
          // doesn't re-animate on subsequent list re-renders.
          setTimeout(() => {
            setNewIds((prev) => {
              const next = new Set(prev);
              for (const id of incomingNewIds) next.delete(id);
              return next;
            });
          }, 600);
        })
        .catch(() => {
          /* silent — UI-SPEC §Copywriting: no user-facing error */
        });
    },
    [entityId],
  );
  useSseKind('timeline_event', onSseTimeline);

  const rowProps = useMemo<RowProps>(() => ({ rows, newIds }), [rows, newIds]);

  if (rows.length === 0) {
    return (
      <p
        className="text-[13px] text-[color:var(--color-text-3)]"
        data-testid="timeline-empty"
      >
        No activity yet. New mentions appear here in real-time.
      </p>
    );
  }

  return (
    <AnimatePresence initial={false}>
      <div style={{ height: 600 }} role="list" data-testid="timeline-list">
        <List
          rowCount={rows.length}
          rowHeight={72}
          rowComponent={Row}
          rowProps={rowProps}
          onRowsRendered={({ stopIndex }: { stopIndex: number }) => {
            if (stopIndex >= rows.length - 10) void loadMore();
          }}
        />
      </div>
    </AnimatePresence>
  );
}
