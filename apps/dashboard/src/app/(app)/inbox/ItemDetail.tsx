'use client';

/**
 * ItemDetail — right-pane focused-item render (Plan 03-09 Task 1).
 *
 * Dispatches by `item.kind` per 03-UI-SPEC §"View 3 — Inbox" Item kinds
 * list:
 *   - `draft_reply`       → email draft preview + Approve/Edit/Skip
 *   - `entity_routing`    → two candidate entities with a "Merge & continue"
 *                           deep-link (Plan 11 implements the merge route)
 *   - `new_entity`        → proposed profile + Confirm/Reject
 *   - `merge_resume`      → delegates to <ResumeMergeCard /> (Plan 11)
 *
 * The sticky bottom bar shows the <Kbd> shortcut legend verbatim per
 * UI-SPEC line 363. An on-screen Action Bar (Approve / Edit / Skip)
 * duplicates the keyboard contract for click-driven use.
 */
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { InboxItem } from '@kos/contracts/dashboard';
import { BolagBadge } from '@/components/badge/BolagBadge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Textarea } from '@/components/ui/textarea';

import { approveInbox, editInbox, skipInbox } from './actions';
import { ResumeMergeCard } from './ResumeMergeCard';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  draft_reply: 'Draft reply',
  entity_routing: 'Ambiguous entity routing',
  new_entity: 'New entity confirmation',
  merge_resume: 'Resume merge',
};

const CONFLICT_COPY = 'Already handled elsewhere.';

export function ItemDetail({
  item,
  editMode,
  onEditRequest,
  onEditDone,
}: {
  item: InboxItem;
  editMode: boolean;
  onEditRequest: () => void;
  onEditDone: () => void;
}) {
  // Merge-resume card owns its own layout.
  if (item.kind === 'merge_resume') {
    return <ResumeMergeCard item={item} />;
  }

  return (
    <div className="flex flex-col h-full">
      <header
        className="p-6"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="h-page">{item.title}</h2>
            <p className="h-page-meta">{KIND_LABEL[item.kind]}</p>
          </div>
          <BolagBadge org={item.bolag} />
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {editMode ? (
          <Editor item={item} onDone={onEditDone} />
        ) : (
          <pre
            className="text-sm whitespace-pre-wrap break-words"
            style={{
              color: 'var(--color-text-2)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {renderPreview(item)}
          </pre>
        )}
      </div>

      <footer
        className="sticky bottom-0 p-4 flex items-center gap-3"
        style={{
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-surface-1)',
        }}
      >
        <ActionBar item={item} onEditRequest={onEditRequest} />
        <div
          className="ml-auto flex items-center gap-3 mono"
          style={{ fontSize: 11, color: 'var(--color-text-4)' }}
        >
          <span className="flex items-center gap-1"><Kbd>J</Kbd> next</span>
          <span className="flex items-center gap-1"><Kbd>K</Kbd> prev</span>
          <span className="flex items-center gap-1"><Kbd>Enter</Kbd> approve</span>
          <span className="flex items-center gap-1"><Kbd>E</Kbd> edit</span>
          <span className="flex items-center gap-1"><Kbd>S</Kbd> skip</span>
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> close</span>
        </div>
      </footer>
    </div>
  );
}

function renderPreview(item: InboxItem): string {
  if (item.kind === 'draft_reply') {
    const body = (item.payload as { body?: unknown })?.body;
    return typeof body === 'string' && body.length > 0 ? body : item.preview;
  }
  return item.preview;
}

function ActionBar({
  item,
  onEditRequest,
}: {
  item: InboxItem;
  onEditRequest: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function onApprove() {
    startTransition(async () => {
      try {
        await approveInbox(item.id);
      } catch {
        toast.error(CONFLICT_COPY, { duration: 4_000 });
      }
    });
  }

  function onSkip() {
    startTransition(async () => {
      try {
        await skipInbox(item.id);
      } catch {
        toast.error(CONFLICT_COPY, { duration: 4_000 });
      }
    });
  }

  return (
    <>
      <Button onClick={onApprove} disabled={pending} size="sm">
        Approve
      </Button>
      <Button
        variant="outline"
        onClick={onEditRequest}
        disabled={pending}
        size="sm"
      >
        Edit
      </Button>
      <Button
        variant="ghost"
        onClick={onSkip}
        disabled={pending}
        size="sm"
      >
        Skip
      </Button>
    </>
  );
}

function Editor({
  item,
  onDone,
}: {
  item: InboxItem;
  onDone: () => void;
}) {
  const initial = (() => {
    const body = (item.payload as { body?: unknown })?.body;
    return typeof body === 'string' ? body : item.preview;
  })();
  const [text, setText] = useState(initial);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      try {
        await editInbox(item.id, { body: text });
        onDone();
      } catch {
        toast.error(CONFLICT_COPY, { duration: 4_000 });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        aria-label="Edit draft body"
        autoFocus
      />
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={pending} size="sm">
          Save edit
        </Button>
        <Button variant="ghost" onClick={onDone} size="sm">
          Cancel
        </Button>
      </div>
    </div>
  );
}
