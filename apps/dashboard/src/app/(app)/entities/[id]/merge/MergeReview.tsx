'use client';

/**
 * Two-column merge review (Plan 03-11 Task 2).
 *
 * Per UI-SPEC §View 3.5:
 *  - Left column: canonical (target) entity card.
 *  - Right column: source (to-be-archived) entity card with opacity 0.8 +
 *    "ARCHIVING" eyebrow in --text-3.
 *  - Diff panel below: fields that differ (name, aliases, org, role,
 *    relationship, status, seed_context, manual_notes) shown side-by-side.
 *    Phase 3 keeps target's value on each field — per-field radio toggle
 *    is planned but not load-bearing for the ENT-07 gate (the handler
 *    doesn't accept a field-override map yet).
 *  - Sticky action bar: "Confirm merge" (primary, opens Dialog) + "Cancel"
 *    (secondary, back to /entities/[target]).
 *
 * The destructive-confirm Dialog copy is pinned verbatim from the UI-SPEC
 * Copywriting table. Grep assertions in the plan file lock:
 *    - "archived, not deleted"  (body)
 *    - "Yes, merge"             (primary)
 */
import Link from 'next/link';
import { useState } from 'react';
import type { EntityResponse } from '@kos/contracts/dashboard';
import { Button } from '@/components/ui/button';
import { MergeConfirmDialog } from './MergeConfirmDialog';

type FieldKey =
  | 'name'
  | 'org'
  | 'role'
  | 'relationship'
  | 'status'
  | 'seed_context'
  | 'manual_notes';

const EDIT_FIELDS: FieldKey[] = [
  'name',
  'org',
  'role',
  'relationship',
  'status',
  'seed_context',
  'manual_notes',
];

function fieldDiffers(
  key: FieldKey,
  a: EntityResponse,
  b: EntityResponse,
): boolean {
  return (a[key] ?? null) !== (b[key] ?? null);
}

function renderVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function EntityCard({
  entity,
  archiving,
}: {
  entity: EntityResponse;
  archiving: boolean;
}) {
  return (
    <div
      className="rounded-[var(--radius-xl)] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 flex flex-col gap-3"
      style={{ opacity: archiving ? 0.8 : 1 }}
      data-testid={archiving ? 'merge-source-card' : 'merge-target-card'}
    >
      {archiving ? (
        <div
          className="uppercase"
          style={{
            fontSize: 11,
            letterSpacing: '0.1em',
            color: 'var(--color-text-3)',
          }}
        >
          ARCHIVING
        </div>
      ) : (
        <div
          className="uppercase"
          style={{
            fontSize: 11,
            letterSpacing: '0.1em',
            color: 'var(--color-accent)',
          }}
        >
          KEEP
        </div>
      )}
      <h2 className="h-page">{entity.name}</h2>
      <div className="h-page-meta" style={{ fontSize: 13 }}>
        {entity.type} · {entity.org ?? '—'} · {entity.status}
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        {EDIT_FIELDS.map((k) => (
          <div key={k} className="flex gap-2">
            <dt
              className="uppercase"
              style={{
                fontSize: 10,
                letterSpacing: '0.08em',
                color: 'var(--color-text-3)',
                minWidth: 96,
              }}
            >
              {k}
            </dt>
            <dd style={{ color: 'var(--color-text-1)' }}>
              {renderVal(entity[k])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function MergeReview({
  target,
  source,
}: {
  target: EntityResponse;
  source: EntityResponse;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const diffs = EDIT_FIELDS.filter((k) => fieldDiffers(k, target, source));

  return (
    <div
      className="main-narrow flex flex-col gap-6"
      style={{ padding: '32px 48px', maxWidth: 960, margin: '0 auto' }}
    >
      <header className="flex flex-col gap-2">
        <h1 className="h-page">Merge review</h1>
        <p className="h-page-meta">
          Review the merge of <strong>{source.name}</strong> into{' '}
          <strong>{target.name}</strong>. The source will be archived, not
          deleted, and relations will be rewritten to the canonical entity.
        </p>
      </header>

      <section
        className="grid gap-8"
        style={{ gridTemplateColumns: '1fr 1fr' }}
      >
        <EntityCard entity={target} archiving={false} />
        <EntityCard entity={source} archiving={true} />
      </section>

      <section
        className="rounded-[var(--radius-xl)] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 flex flex-col gap-3"
        data-testid="merge-diff-panel"
      >
        <h3
          className="uppercase"
          style={{
            fontSize: 11,
            letterSpacing: '0.1em',
            color: 'var(--color-text-3)',
          }}
        >
          Fields that differ ({diffs.length})
        </h3>
        {diffs.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            No field-level differences. Relations will still be rewritten.
          </p>
        ) : (
          <dl className="flex flex-col gap-2 text-sm">
            {diffs.map((k) => (
              <div
                key={k}
                className="grid gap-3"
                style={{ gridTemplateColumns: '120px 1fr 1fr' }}
              >
                <dt
                  className="uppercase"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    color: 'var(--color-text-3)',
                  }}
                >
                  {k}
                </dt>
                <dd style={{ color: 'var(--color-text-1)' }}>
                  {renderVal(target[k])}
                </dd>
                <dd
                  style={{
                    color: 'var(--color-text-3)',
                    textDecoration: 'line-through',
                  }}
                >
                  {renderVal(source[k])}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
          Plus: all <strong>mention_events</strong>, linked projects, and agent
          audit rows currently pointing at <strong>{source.name}</strong> will
          be re-pointed to <strong>{target.name}</strong>.
        </p>
      </section>

      <div
        className="sticky bottom-0 flex items-center gap-2 py-3"
        style={{
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-surface-0)',
        }}
      >
        <Button
          onClick={() => setDialogOpen(true)}
          data-testid="merge-confirm-button"
        >
          Confirm merge
        </Button>
        <Button variant="ghost" asChild>
          <Link href={`/entities/${target.id}` as never}>Cancel</Link>
        </Button>
      </div>

      <MergeConfirmDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={target}
        source={source}
      />
    </div>
  );
}
