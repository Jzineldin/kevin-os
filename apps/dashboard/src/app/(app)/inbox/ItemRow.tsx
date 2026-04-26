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
 * Phase 11 D-05: when item.classification is present (email rows), render
 * a Pill below the preview showing classification × email_status. Adds
 * data-testid="inbox-row-pill" so the e2e suite can locate it.
 *
 * Reserved letters D / A / R do not bind anywhere in this module — the
 * keyboard handler for those is explicitly absent in InboxClient. See
 * 03-UI-SPEC line 373.
 */
import type { InboxItem, InboxItemKind } from '@kos/contracts/dashboard';
import type { ElementType } from 'react';
import {
  AlertTriangle,
  GitMerge,
  Mail,
  UserPlus,
  XOctagon,
} from 'lucide-react';

import { BolagBadge } from '@/components/badge/BolagBadge';
import { Pill } from '@/components/dashboard/Pill';

const KIND_ICON: Record<InboxItemKind, ElementType> = {
  draft_reply: Mail,
  entity_routing: GitMerge,
  new_entity: UserPlus,
  merge_resume: AlertTriangle,
  // Phase 11 D-05 — `dead_letter` items now flow through /inbox-merged.
  dead_letter: XOctagon,
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
      data-testid="inbox-row-click"
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
        {item.classification ? (
          <div data-testid="inbox-row-pill" className="mt-1">
            <Pill
              classification={item.classification}
              status={item.email_status ?? 'pending_triage'}
            />
          </div>
        ) : null}
      </div>
      <BolagBadge org={item.bolag} />
    </button>
  );
}
