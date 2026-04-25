/**
 * Manual entity edit Dialog (D-29 — ENT-01 fields).
 *
 * Opens from StatsRail's "Edit entity" button. Submit fires the
 * `editEntity` Server Action which POSTs to dashboard-api; the indexer
 * propagates to RDS on its next cycle. On success we call
 * `router.refresh()` and close.
 *
 * Fields (per ENT-01): name, aliases (comma-separated in the UI), org,
 * role, relationship, status, seed_context, manual_notes. Type is
 * immutable in Phase 3 (would require re-embedding the vector).
 */
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { EntityResponse } from '@kos/contracts/dashboard';
import { editEntity } from './actions';

export function EditEntityDialog({
  entity,
  open,
  onOpenChange,
}: {
  entity: EntityResponse;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Local form state keyed by entity id so re-opening after edit pulls
  // fresh server values rather than stale local state.
  const [state, setState] = useState(() => ({
    name: entity.name,
    aliases: (entity.aliases ?? []).join(', '),
    org: entity.org ?? '',
    role: entity.role ?? '',
    relationship: entity.relationship ?? '',
    status: entity.status,
    seed_context: entity.seed_context ?? '',
    manual_notes: entity.manual_notes ?? '',
  }));

  function set<K extends keyof typeof state>(key: K, value: (typeof state)[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const aliases = state.aliases
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    const payload = {
      name: state.name.trim(),
      aliases,
      org: state.org.trim() || null,
      role: state.role.trim() || null,
      relationship: state.relationship.trim() || null,
      status: state.status.trim(),
      seed_context: state.seed_context.trim() || null,
      manual_notes: state.manual_notes.trim() || null,
    };

    startTransition(async () => {
      const res = await editEntity(entity.id, payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Edit {entity.name}</DialogTitle>
          <DialogDescription>
            Changes write to Notion; this dossier refreshes from the index on the next cycle
            (≤ 5 min).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
            Name
            <Input
              value={state.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
            Aliases (comma-separated)
            <Input
              value={state.aliases}
              onChange={(e) => set('aliases', e.target.value)}
              placeholder="Dam, D.R."
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
              Org
              <Input value={state.org} onChange={(e) => set('org', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
              Role
              <Input value={state.role} onChange={(e) => set('role', e.target.value)} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
              Relationship
              <Input
                value={state.relationship}
                onChange={(e) => set('relationship', e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
              Status
              <Input value={state.status} onChange={(e) => set('status', e.target.value)} />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
            Seed context
            <Textarea
              rows={3}
              value={state.seed_context}
              onChange={(e) => set('seed_context', e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-3)]">
            Manual notes
            <Textarea
              rows={3}
              value={state.manual_notes}
              onChange={(e) => set('manual_notes', e.target.value)}
            />
          </label>

          {error ? (
            <p role="alert" className="text-[12px] text-[color:var(--color-danger)]">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
