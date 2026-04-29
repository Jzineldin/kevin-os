'use client';

/**
 * ItemDetail — right-pane focused-item render.
 *
 * Phase 11 D-06: draft_reply now shows:
 *   1. Original email (from, subject, full body)
 *   2. AI-generated draft reply (full, editable)
 *   3. Approve / Edit / Skip actions
 *
 * All other kinds unchanged from D-05.
 */
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { InboxItem } from '@kos/contracts/dashboard';
import { BolagBadge } from '@/components/badge/BolagBadge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Pill } from '@/components/dashboard/Pill';
import { Textarea } from '@/components/ui/textarea';

import { approveInbox, editInbox, skipInbox, delegateInboxItem } from './actions';
import { isTerminalInboxItem } from './InboxClient';
import { ResumeMergeCard } from './ResumeMergeCard';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  draft_reply: 'Email draft',
  entity_routing: 'Ambiguous entity routing',
  new_entity: 'New entity confirmation',
  merge_resume: 'Resume merge',
  dead_letter: 'Failed agent task',
};

const CONFLICT_COPY = 'Already handled elsewhere.';
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'edited']);

// ── Shared text styles ──────────────────────────────────────────────────────
const bodyStyle: React.CSSProperties = {
  color: 'var(--color-text-2)',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  lineHeight: 1.65,
  letterSpacing: '-0.003em',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--color-text-4)',
  marginBottom: 8,
};

const dividerStyle: React.CSSProperties = {
  borderTop: '1px solid var(--rail)',
  margin: '20px 0',
};

// ── Main component ──────────────────────────────────────────────────────────
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
  if (item.kind === 'merge_resume') {
    return <ResumeMergeCard item={item} />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <header className="p-6" style={{ borderBottom: '1px solid var(--rail)' }}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-[10px]" style={{ marginBottom: 10 }}>
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--color-sect-inbox)',
                  boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-sect-inbox) 15%, transparent)',
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
              style={{ fontSize: 22, lineHeight: 1.25, letterSpacing: '-0.015em' }}
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

        {/* Email metadata (from, subject) — only for draft_reply */}
        {item.kind === 'draft_reply' && (item.from_name ?? item.from_email) ? (
          <div
            className="mt-4 rounded-md px-4 py-3"
            style={{
              background: 'var(--color-surface-2)',
              fontSize: 13,
              color: 'var(--color-text-3)',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 12px',
            }}
          >
            <span style={{ color: 'var(--color-text-4)', fontWeight: 600 }}>From</span>
            <span>{item.from_name ? `${item.from_name} <${item.from_email}>` : item.from_email}</span>
            {item.subject ? (
              <>
                <span style={{ color: 'var(--color-text-4)', fontWeight: 600 }}>Subject</span>
                <span>{item.subject}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* ── Body ── */}
      <div className="flex-1 overflow-auto p-6">
        {item.kind === 'draft_reply' ? (
          editMode ? (
            <Editor item={item} onDone={onEditDone} />
          ) : (
            <EmailDraftDetail item={item} />
          )
        ) : (
          <pre style={bodyStyle}>{item.preview}</pre>
        )}
      </div>

      {/* ── Footer ── */}
      <footer
        className="sticky bottom-0 flex items-center gap-3"
        style={{
          borderTop: '1px solid var(--rail)',
          background: 'color-mix(in srgb, var(--color-surface-1) 92%, transparent)',
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

// ── EmailDraftDetail — original email + AI draft (read view) ────────────────
function EmailDraftDetail({ item }: { item: InboxItem }) {
  const [showOriginal, setShowOriginal] = useState(false);

  const draftBody = item.draft_body_full ?? item.preview;
  const originalBody = item.original_body;

  return (
    <div>
      {/* AI Draft Reply */}
      <div>
        <p style={sectionLabelStyle}>✨ AI draft reply</p>
        <pre style={bodyStyle}>{draftBody || '(no draft generated)'}</pre>
      </div>

      {/* Original email (collapsible) */}
      {originalBody ? (
        <>
          <div style={dividerStyle} />
          <button
            onClick={() => setShowOriginal((v) => !v)}
            style={{
              ...sectionLabelStyle,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>{showOriginal ? '▾' : '▸'}</span>
            Original email
          </button>
          {showOriginal ? (
            <div
              className="mt-3 rounded-md px-4 py-4"
              style={{ background: 'var(--color-surface-2)' }}
            >
              <pre style={{ ...bodyStyle, fontSize: 13, color: 'var(--color-text-3)' }}>
                {originalBody}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ── Editor — full draft editable ────────────────────────────────────────────
function Editor({ item, onDone }: { item: InboxItem; onDone: () => void }) {
  const initial = item.draft_body_full ?? item.preview;
  const [text, setText] = useState(initial);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      try {
        await editInbox(item.id, { body: text });
        onDone();
      } catch {
        toast.error('Already handled elsewhere.', { duration: 4_000 });
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Original context above the edit box */}
      {item.original_body ? (
        <div
          className="rounded-md px-4 py-3"
          style={{ background: 'var(--color-surface-2)' }}
        >
          <p style={sectionLabelStyle}>Original email</p>
          <pre style={{ ...bodyStyle, fontSize: 13, color: 'var(--color-text-3)' }}>
            {item.original_body.slice(0, 800)}{item.original_body.length > 800 ? '\n…' : ''}
          </pre>
        </div>
      ) : null}

      <div>
        <p style={sectionLabelStyle}>Your reply</p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={16}
          aria-label="Edit draft reply"
          autoFocus
          style={{ fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.65 }}
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={onSave} disabled={pending} size="sm" data-testid="inbox-edit-save">
          Save &amp; approve
        </Button>
        <Button variant="ghost" onClick={onDone} size="sm" data-testid="inbox-edit-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── ActionBar ───────────────────────────────────────────────────────────────
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
      try { await approveInbox(item.id); }
      catch { toast.error(CONFLICT_COPY, { duration: 4_000 }); }
    });
  }

  function onSkip() {
    startTransition(async () => {
      try { await skipInbox(item.id); }
      catch { toast.error(CONFLICT_COPY, { duration: 4_000 }); }
    });
  }

  const isTerminal = isTerminalInboxItem(item);
  const canEdit =
    !isTerminal &&
    (!item.email_status || EDITABLE_STATUSES.has(item.email_status));

  const [delegating, setDelegating] = useState(false);
  function onDelegate() {
    setDelegating(true);
    delegateInboxItem({
      kind: item.kind,
      id: item.id,
      title: item.title,
      context: item.preview ?? undefined,
    }).then(() => toast.success('💬 Sent to Zinclaw — check Discord DM'))
      .catch(() => toast.error('Could not reach Zinclaw'))
      .finally(() => setDelegating(false));
  }

  if (isTerminal) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }} data-testid="inbox-readonly-label">
          Read-only
        </span>
        <Button variant="ghost" size="sm" onClick={onDelegate} disabled={delegating}>
          {delegating ? '...' : '💬 Ask Zinclaw'}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button onClick={onApprove} disabled={pending} size="sm" data-testid="inbox-approve-btn">
        Approve &amp; send
      </Button>
      {canEdit ? (
        <Button variant="outline" onClick={onEditRequest} disabled={pending} size="sm" data-testid="inbox-edit-btn">
          Edit reply
        </Button>
      ) : null}
      <Button variant="ghost" onClick={onSkip} disabled={pending} size="sm" data-testid="inbox-skip-btn">
        Skip
      </Button>
      <Button variant="ghost" onClick={onDelegate} disabled={delegating || pending} size="sm" data-testid="inbox-delegate-btn"
        style={{ color: 'var(--color-sect-drafts)', marginLeft: 'auto' }}>
        {delegating ? '...' : '💬 Ask Zinclaw'}
      </Button>
    </>
  );
}
