'use client';

/**
 * ResumeMergeCard — rendered when the focused Inbox item has
 * `kind: 'merge_resume'` (Plan 03-09 Task 2).
 *
 * Per 03-UI-SPEC §"View 3.5 — Merge Review" partial-failure state + D-28
 * (CONTEXT): when a merge fails mid-transaction, the router lands the user
 * on `/inbox?focus=resume-{merge_id}` and this card surfaces three
 * actions: Resume · Revert · Cancel.
 *
 * As of Plan 03-11 all three actions route through /api/merge-resume with
 * an ?action= query param that the dashboard-api resume handler consumes:
 *   - "Resume"  → POST /api/merge-resume?merge_id=…&action=resume
 *   - "Revert"  → POST /api/merge-resume?merge_id=…&action=revert
 *   - "Cancel"  → POST /api/merge-resume?merge_id=…&action=cancel
 *
 * No state is retained client-side — the SSE `entity_merge` event re-drives
 * the card's surfacing via the Inbox RSC refresh loop.
 */
import { useTransition } from 'react';
import { toast } from 'sonner';

import type { InboxItem } from '@kos/contracts/dashboard';
import { Button } from '@/components/ui/button';

export function ResumeMergeCard({ item }: { item: InboxItem }) {
  const [pending, startTransition] = useTransition();

  async function dispatch(
    action: 'resume' | 'revert' | 'cancel',
    successMsg: string,
  ) {
    if (!item.merge_id) {
      toast.error('merge_id missing — cannot ' + action + '.');
      return;
    }
    try {
      const qs = new URLSearchParams({
        merge_id: item.merge_id,
        action,
      });
      const r = await fetch(`/api/merge-resume?${qs.toString()}`, {
        method: 'POST',
      });
      if (!r.ok) {
        throw new Error(`${r.status}: ${await r.text().catch(() => '')}`);
      }
      toast.success(successMsg);
    } catch (err) {
      toast.error(
        (action === 'resume'
          ? 'Resume failed'
          : action === 'revert'
            ? 'Revert failed'
            : 'Cancel failed') +
          ': ' +
          String(err),
      );
    }
  }

  function onResume() {
    startTransition(() => dispatch('resume', 'Merge resumed'));
  }

  function onRevert() {
    startTransition(() => dispatch('revert', 'Merge reverted'));
  }

  function onCancel() {
    startTransition(() => dispatch('cancel', 'Cancelled'));
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-8 flex flex-col gap-6">
        <div>
          <h2 className="h-page">Resume merge?</h2>
          <p className="h-page-meta">
            A previous merge failed partway through. You can resume, revert,
            or cancel — all options are reversible within 7 days.
          </p>
        </div>

        <div
          className="flex items-center gap-3"
          style={{ color: 'var(--color-text-3)' }}
        >
          <span
            className="uppercase"
            style={{ fontSize: 11, letterSpacing: '0.1em' }}
          >
            merge_id
          </span>
          <code className="mono" style={{ fontSize: 12 }}>
            {item.merge_id ?? '—'}
          </code>
        </div>

        <div
          className="text-sm whitespace-pre-wrap"
          style={{ color: 'var(--color-text-2)' }}
        >
          {item.preview}
        </div>

        <div className="flex gap-2">
          <Button onClick={onResume} disabled={pending} size="sm">
            Resume
          </Button>
          <Button
            variant="ghost"
            onClick={onRevert}
            disabled={pending}
            size="sm"
            style={{ color: 'var(--color-text-2)' }}
          >
            Revert
          </Button>
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
            size="sm"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
