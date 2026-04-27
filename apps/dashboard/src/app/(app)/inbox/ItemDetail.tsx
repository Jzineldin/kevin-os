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
 *   - `dead_letter`       → Phase 4 D-24 surface (Phase 11 D-05 routed
 *                           into the merged inbox): read-only display.
 *
 * Phase 11 D-05: Approve / Skip buttons hide for terminal statuses
 * (sent/failed/approved/skipped) AND for dead_letter rows. Edit is also
 * hidden when email_status is anything other than 'draft' or 'edited'.
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
import { Pill } from '@/components/dashboard/Pill';
import { Textarea } from '@/components/ui/textarea';

import { approveInbox, editInbox, skipInbox } from './actions';
import { isTerminalInboxItem } from './InboxClient';
import { ResumeMergeCard } from './ResumeMergeCard';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  draft_reply: 'Draft reply',
  entity_routing: 'Ambiguous entity routing',
  new_entity: 'New entity confirmation',
  merge_resume: 'Resume merge',
  // Phase 11 D-05 — `dead_letter` items now flow through /inbox-merged.
  dead_letter: 'Failed agent task',
};

const CONFLICT_COPY = 'Already handled elsewhere.';

const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'edited']);

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
        style={{ borderBottom: '1px solid var(--rail)' }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="flex items-center gap-[10px]"
              style={{ marginBottom: 10 }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--color-sect-inbox)',
                  boxShadow:
                    '0 0 0 3px color-mix(in srgb, var(--color-sect-inbox) 15%, transparent)',
                }}
              />
              <span
                className="font-mono"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--color-sect-inbox)',
                }}
              >
                {KIND_LABEL[item.kind]}
              </span>
            </div>
            <h2
              className="h-page"
              style={{
                fontSize: 22,
                lineHeight: 1.25,
                letterSpacing: '-0.015em',
              }}
            >
              {item.title}
            </h2>
            {item.classification ? (
              <div className="mt-3">
                <Pill
                  classification={item.classification}
                  status={item.email_status ?? 'pending_triage'}
                />
              </div>
            ) : null}
          </div>
          <BolagBadge org={item.bolag} />
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {editMode ? (
          <Editor item={item} onDone={onEditDone} />
        ) : (
          <pre
            className="whitespace-pre-wrap break-words"
            style={{
              color: 'var(--color-text-2)',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              lineHeight: 1.65,
              letterSpacing: '-0.003em',
              margin: 0,
            }}
          >
            {renderPreview(item)}
          </pre>
        )}
      </div>

      <footer
        className="sticky bottom-0 flex items-center gap-3"
        style={{
          borderTop: '1px solid var(--rail)',
          background:
            'color-mix(in srgb, var(--color-surface-1) 92%, transparent)',
          backdropFilter: 'blur(6px)',
          padding: '14px 20px',
        }}
      >
        <ActionBar item={item} onEditRequest={onEditRequest} />
        <div
          className="ml-auto flex items-center gap-[14px] mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-text-4)',
          }}
        >
          <span className="flex items-center gap-[6px]"><Kbd>J</Kbd> next</span>
          <span className="flex items-center gap-[6px]"><Kbd>K</Kbd> prev</span>
          <span className="flex items-center gap-[6px]"><Kbd>↵</Kbd> approve</span>
          <span className="flex items-center gap-[6px]"><Kbd>E</Kbd> edit</span>
          <span className="flex items-center gap-[6px]"><Kbd>S</Kbd> skip</span>
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

  const isTerminal = isTerminalInboxItem(item);
  // Edit is only relevant when there's a draft body to edit — restrict
  // to draft/edited or to the legacy Phase-3 inbox_index kinds that
  // never carry email_status (pre-D-05 behavior preserved).
  const canEdit =
    !isTerminal &&
    (!item.email_status || EDITABLE_STATUSES.has(item.email_status));

  if (isTerminal) {
    return (
      <span
        className="text-xs"
        style={{ color: 'var(--color-text-3)' }}
        data-testid="inbox-readonly-label"
      >
        Read-only
      </span>
    );
  }

  return (
    <>
      <Button
        onClick={onApprove}
        disabled={pending}
        size="sm"
        data-testid="inbox-approve-btn"
      >
        Approve
      </Button>
      {canEdit ? (
        <Button
          variant="outline"
          onClick={onEditRequest}
          disabled={pending}
          size="sm"
          data-testid="inbox-edit-btn"
        >
          Edit
        </Button>
      ) : null}
      <Button
        variant="ghost"
        onClick={onSkip}
        disabled={pending}
        size="sm"
        data-testid="inbox-skip-btn"
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
        <Button
          onClick={onSave}
          disabled={pending}
          size="sm"
          data-testid="inbox-edit-save"
        >
          Save edit
        </Button>
        <Button
          variant="ghost"
          onClick={onDone}
          size="sm"
          data-testid="inbox-edit-cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
