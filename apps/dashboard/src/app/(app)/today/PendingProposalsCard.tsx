'use client';

/**
 * Pending proposals card — renders Phase 11 Plan 11-05 review queue on
 * /today. Fetches from `/api/proposals?status=pending`, groups by
 * `batch_id`, renders each item with Accept / Reject / Replace buttons
 * wired to `/api/proposals/[id]/[action]`.
 *
 * Visual direction: matches v4 mockup conventions — dark surface, mono
 * uppercase heading, amber accent dot, per-item Accept/Reject/Replace
 * inline buttons. Intentionally compact so it slots below the Brief
 * without pushing below the fold.
 */
import { useCallback, useEffect, useState } from 'react';

interface Proposal {
  id: string;
  source_agent: string;
  kind: string;
  status: string;
  proposed_payload: Record<string, unknown>;
  batch_id: string | null;
  created_at: string;
}

interface Batch {
  batch_id: string | null;
  items: Proposal[];
}

interface ListResponse {
  total: number;
  items: Proposal[];
  batches: Batch[];
}

type PendingAction = 'accept' | 'reject' | 'replace' | null;

function titleOf(p: Proposal): string {
  const t = (p.proposed_payload as { title?: unknown }).title;
  return typeof t === 'string' && t.length > 0 ? t : `(${p.kind})`;
}

function urgencyOf(p: Proposal): string | null {
  const u = (p.proposed_payload as { urgency?: unknown }).urgency;
  return typeof u === 'string' ? u : null;
}

function sourceLabel(agent: string): string {
  const map: Record<string, string> = {
    'morning-brief': 'Morning Brief',
    'day-close': 'Day Close',
    'weekly-review': 'Weekly Review',
    'voice-capture': 'Voice',
    'transcript-extractor': 'Transcript',
    'email-triage': 'Email',
    'kevin-replace': 'You (replace)',
  };
  return map[agent] ?? agent;
}

export function PendingProposalsCard() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, PendingAction>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/proposals?status=pending', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as ListResponse;
      setData(json);
    } catch (err) {
      console.warn('[PendingProposalsCard] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = useCallback(
    async (id: string, action: 'accept' | 'reject' | 'replace', body?: unknown) => {
      setPending((p) => ({ ...p, [id]: action }));
      try {
        const res = await fetch(`/api/proposals/${id}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        await refresh();
      } catch (err) {
        console.warn(`[PendingProposalsCard] ${action} failed:`, err);
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
      }
    },
    [refresh],
  );

  const onReplace = useCallback(
    (p: Proposal) => {
      const current = titleOf(p);
      const replacement = window.prompt(
        `Replace with what? (you can type an alternative title)`,
        current,
      );
      if (!replacement || replacement.trim().length === 0) return;
      const note = window.prompt('Optional note (why replacing)?', '') ?? '';
      act(p.id, 'replace', {
        replacement_payload: {
          ...p.proposed_payload,
          title: replacement.trim(),
        },
        user_note: note.trim() || undefined,
      });
    },
    [act],
  );

  if (loading) {
    return (
      <section
        aria-label="Pending suggestions"
        className="rounded-lg p-4 text-[13px] text-[color:var(--color-text-3)]"
        style={{ background: 'var(--color-surface-2)' }}
      >
        Loading suggestions…
      </section>
    );
  }

  if (!data || data.total === 0) {
    return (
      <section
        aria-label="Pending suggestions"
        className="rounded-lg p-4"
        style={{ background: 'var(--color-surface-2)' }}
      >
        <header className="flex items-center gap-2 mb-2">
          <span
            className="block w-[6px] h-[6px] rounded-full"
            style={{ background: 'var(--color-sect-brief)' }}
            aria-hidden
          />
          <h2
            className="font-mono text-[11px] uppercase tracking-wider"
            style={{ color: 'var(--color-text-2)' }}
          >
            Suggestions
          </h2>
        </header>
        <p className="text-[12px]" style={{ color: 'var(--color-text-3)' }}>
          No pending suggestions. Morning brief + agent outputs will land here for
          your review.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Pending suggestions"
      className="rounded-lg p-4"
      style={{ background: 'var(--color-surface-2)' }}
    >
      <header className="flex items-center gap-2 mb-3">
        <span
          className="block w-[6px] h-[6px] rounded-full"
          style={{ background: 'var(--color-sect-brief)' }}
          aria-hidden
        />
        <h2
          className="font-mono text-[11px] uppercase tracking-wider"
          style={{ color: 'var(--color-text-2)' }}
        >
          Suggestions
        </h2>
        <span
          className="font-mono text-[11px]"
          style={{ color: 'var(--color-text-3)' }}
        >
          · {data.total} pending
        </span>
      </header>
      <ul className="space-y-2">
        {data.items.map((p) => {
          const urg = urgencyOf(p);
          const inflight = pending[p.id];
          return (
            <li
              key={p.id}
              className="rounded-md p-3 text-[13px]"
              style={{
                background: 'var(--color-surface-3)',
                borderLeft: `2px solid var(--color-sect-brief)`,
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div
                    className="font-mono text-[10px] uppercase mb-1"
                    style={{ color: 'var(--color-text-3)' }}
                  >
                    {sourceLabel(p.source_agent)} · {p.kind}
                    {urg ? ` · ${urg}` : ''}
                  </div>
                  <div style={{ color: 'var(--color-text-1)' }}>{titleOf(p)}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    className="px-2 py-1 rounded text-[11px] font-medium"
                    style={{
                      background: inflight === 'accept' ? 'var(--color-sect-schedule)' : 'transparent',
                      border: '1px solid var(--color-sect-schedule)',
                      color:
                        inflight === 'accept'
                          ? '#fff'
                          : 'var(--color-sect-schedule)',
                    }}
                    disabled={Boolean(inflight)}
                    onClick={() => act(p.id, 'accept')}
                  >
                    {inflight === 'accept' ? '…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 rounded text-[11px] font-medium"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--color-sect-inbox)',
                      color: 'var(--color-sect-inbox)',
                    }}
                    disabled={Boolean(inflight)}
                    onClick={() => act(p.id, 'reject')}
                  >
                    {inflight === 'reject' ? '…' : 'Reject'}
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 rounded text-[11px] font-medium"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--color-text-3)',
                      color: 'var(--color-text-2)',
                    }}
                    disabled={Boolean(inflight)}
                    onClick={() => onReplace(p)}
                  >
                    {inflight === 'replace' ? '…' : 'Replace'}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
