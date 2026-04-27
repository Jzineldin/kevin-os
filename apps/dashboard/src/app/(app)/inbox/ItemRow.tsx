'use client';

/**
 * ItemRow — a single row in the Inbox queue (left pane).
 *
 * v4 polish (2026-04-27):
 *   - Selected state uses --color-sect-inbox (pink) instead of the legacy
 *     --color-accent (priority blue), aligning the Inbox with the v4
 *     section palette. Left-rail grown from 2px → 3px for better
 *     readability at a glance down the queue.
 *   - Hover uses color-mix(surface-2) for calmer highlight than the raw
 *     surface-hover token.
 *   - Row padding tightened 12/14 → 12/16 for wider hit targets.
 *   - Title type-size remains 14 (matches .pri-title at the panel row).
 *   - Preview gains +1 line-height for better reading rhythm at 2-line
 *     clamp sizes.
 *   - Motion rule 8 preserved: selection toggle is INSTANT (no
 *     transition on the selected class).
 *   - Pill moved 4px below the preview (was 1mt); breathes better.
 *
 * Phase 11 D-05: when item.classification is present (email rows), render
 * a Pill below the preview showing classification × email_status. Adds
 * data-testid="inbox-row-pill" so the e2e suite can locate it.
 *
 * Reserved letters D / A / R do not bind anywhere in this module. See
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
        padding: '12px 16px 12px 14px',
        borderLeft: selected
          ? '3px solid var(--color-sect-inbox)'
          : '3px solid transparent',
        background: selected
          ? 'color-mix(in srgb, var(--color-sect-inbox) 10%, transparent)'
          : undefined,
        // §Motion rule 8 — active selection is INSTANT (no transition).
        // Hover still animates via the --transition-fast background below.
        transition: selected
          ? 'none'
          : 'background var(--transition-fast) var(--ease)',
      }}
    >
      <Icon
        size={14}
        strokeWidth={1.7}
        className="mt-[3px]"
        style={{
          color: selected
            ? 'var(--color-sect-inbox)'
            : 'var(--color-text-3)',
        }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex flex-col gap-1">
        <div
          className="text-[13px] font-medium truncate"
          style={{
            color: selected
              ? 'var(--color-text)'
              : 'var(--color-text)',
            letterSpacing: '-0.003em',
          }}
        >
          {item.title}
        </div>
        <div
          className="text-[12px] line-clamp-2"
          style={{
            color: 'var(--color-text-3)',
            lineHeight: 1.5,
          }}
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
