'use client';

/**
 * ItemRow — a single row in the Inbox queue (left pane).
 *
 * Per 03-UI-SPEC §"View 3 — Inbox" queue list rules:
 *   - Grid: `20px 1fr auto` with 10px gap, 12/14 padding
 *   - Kind icon (left) + title/preview (middle) + bolag chip (right)
 *   - Selected: `border-left: 2px solid --accent; background: --accent-bg;`
 *     `transition: none` — instant, snappy (§Motion rule 8 behaviour extended)
 *   - Hover: `background: --color-surface-hover;` via `--t-fast`
 *
 * Reserved letters D / A / R do not bind anywhere in this module — the
 * keyboard handler for those is explicitly absent in InboxClient. See
 * 03-UI-SPEC line 373.
 */
import type { InboxItem, InboxItemKind } from '@kos/contracts/dashboard';
import type { ElementType } from 'react';
import { AlertTriangle, GitMerge, Mail, UserPlus } from 'lucide-react';

import { BolagBadge } from '@/components/badge/BolagBadge';

const KIND_ICON: Record<InboxItemKind, ElementType> = {
  draft_reply: Mail,
  entity_routing: GitMerge,
  new_entity: UserPlus,
  merge_resume: AlertTriangle,
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-selected={selected || undefined}
      className="w-full text-left grid items-start"
      style={{
        gridTemplateColumns: '20px 1fr auto',
        gap: 10,
        padding: '12px 14px',
        borderLeft: selected
          ? '2px solid var(--color-accent)'
          : '2px solid transparent',
        background: selected ? 'var(--accent-bg)' : undefined,
        // §Motion rule 8 — active selection is INSTANT (no transition).
        // Hover still animates via the --t-fast background transition below.
        transition: selected
          ? 'none'
          : 'background var(--t-fast) var(--ease)',
      }}
    >
      <Icon
        size={14}
        className="mt-1"
        style={{ color: 'var(--color-text-3)' }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex flex-col gap-1">
        <div
          className="text-sm font-medium truncate"
          style={{ color: 'var(--color-text)' }}
        >
          {item.title}
        </div>
        <div
          className="text-xs line-clamp-2"
          style={{ color: 'var(--color-text-3)' }}
        >
          {item.preview}
        </div>
      </div>
      <BolagBadge org={item.bolag} />
    </button>
  );
}
