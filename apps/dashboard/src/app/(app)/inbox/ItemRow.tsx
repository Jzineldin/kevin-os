'use client';

import type { InboxItem, InboxItemKind } from '@kos/contracts/dashboard';
import type { ElementType } from 'react';
import { AlertTriangle, GitMerge, Mail, UserPlus, XOctagon } from 'lucide-react';
import { isTerminalInboxItem } from './InboxClient';

const KIND_ICON: Record<InboxItemKind, ElementType> = {
  draft_reply: Mail,
  entity_routing: GitMerge,
  new_entity: UserPlus,
  merge_resume: AlertTriangle,
  dead_letter: XOctagon,
};

const CLF_COLOR: Record<string, string> = {
  urgent: 'var(--color-error)',
  important: 'var(--color-warning)',
  informational: 'var(--color-text-4)',
  junk: 'var(--color-text-4)',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  edited: 'Edited',
  approved: 'Approved',
  sent: 'Sent',
  skipped: 'Skipped',
  failed: 'Failed',
  pending_triage: 'Pending',
};

export function ItemRow({
  item,
  selected,
  onClick,
}: {
  item: InboxItem;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = KIND_ICON[item.kind];
  const isTerminal = isTerminalInboxItem(item);
  const clfColor = item.classification ? CLF_COLOR[item.classification] ?? 'var(--color-text-4)' : undefined;
  const statusLabel = item.email_status ? STATUS_LABEL[item.email_status] ?? item.email_status : null;

  // Parse sender name from "Name <email>" format
  const rawFrom = (item as any).payload?.from ?? item.title ?? '';
  const senderMatch = rawFrom.match(/^(.+?)\s*<[^>]+>/);
  const senderName = senderMatch ? senderMatch[1].trim() : rawFrom.split('@')[0] ?? rawFrom;
  const subject = item.title;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-selected={selected || undefined}
      data-testid="inbox-row-click"
      className="w-full text-left"
      style={{
        display: 'block',
        padding: '12px 16px 12px 14px',
        borderLeft: selected
          ? '3px solid var(--color-sect-inbox)'
          : '3px solid transparent',
        background: selected
          ? 'color-mix(in srgb, var(--color-sect-inbox) 10%, transparent)'
          : undefined,
        transition: selected ? 'none' : 'background var(--transition-fast) var(--ease)',
        opacity: isTerminal && !selected ? 0.55 : 1,
      }}
    >
      {/* Row 1: icon + sender + status pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Icon
          size={13}
          strokeWidth={1.7}
          style={{ color: selected ? 'var(--color-sect-inbox)' : 'var(--color-text-3)', flexShrink: 0 }}
          aria-hidden="true"
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: selected ? 'var(--color-text)' : 'var(--color-text-2)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.003em',
          }}
        >
          {senderName}
        </span>
        {statusLabel && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: item.email_status === 'draft' || item.email_status === 'edited'
                ? 'var(--color-sect-inbox)'
                : 'var(--color-text-4)',
              flexShrink: 0,
            }}
          >
            {statusLabel}
          </span>
        )}
      </div>

      {/* Row 2: subject */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: item.preview ? 3 : 0,
          letterSpacing: '-0.003em',
        }}
      >
        {subject}
      </div>

      {/* Row 3: preview snippet */}
      {item.preview ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--color-text-3)',
            lineHeight: 1.45,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {item.preview}
        </div>
      ) : null}

      {/* Row 4: classification badge */}
      {item.classification && item.classification !== 'informational' && (
        <div style={{ marginTop: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: clfColor,
            }}
          >
            {item.classification}
          </span>
        </div>
      )}
    </button>
  );
}
