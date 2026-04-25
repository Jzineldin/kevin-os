'use client';

/**
 * Confirm-merge Dialog (Plan 03-11 Task 2).
 *
 * Copy VERBATIM from UI-SPEC Copywriting table (lines 543-547). Any drift
 * in this file breaks the grep assertions in the plan's acceptance_criteria.
 *   Headline: "Merge {source.name} into {target.name}?"
 *   Body:    "The source entity will be archived, not deleted. All mentions,
 *             tasks, and projects will be re-pointed to {target.name}. This
 *             is logged to the audit table. You can revert this within 7
 *             days from the Inbox Resume card."
 *   Primary: "Yes, merge"
 *   Secondary: "Cancel"
 *
 * On confirm we generate a ULID client-side and POST to the Server Action
 * in ./actions.ts. On success the action redirects to /entities/<target>;
 * on failure it redirects to /inbox?focus=resume-<merge_id> where Plan 09's
 * ResumeMergeCard surfaces the partial-failure thread.
 */
import { useTransition } from 'react';
import { ulid } from 'ulid';
import type { EntityResponse } from '@kos/contracts/dashboard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { executeMerge } from './actions';

export function MergeConfirmDialog({
  open,
  onOpenChange,
  target,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EntityResponse;
  source: EntityResponse;
}) {
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      // ULID generated on the client so the Server Action can forward it to
      // dashboard-api with the replay-safe PK already set. The handler
      // rejects duplicates with 409 (T-3-11-01 Replay mitigation).
      const merge_id = ulid();
      await executeMerge(target.id, source.id, merge_id, {
        source: {
          name: source.name,
          org: source.org,
          role: source.role,
          status: source.status,
        },
        target: {
          name: target.name,
          org: target.org,
          role: target.role,
          status: target.status,
        },
      });
      // If the Server Action redirects, the following lines don't run.
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="merge-confirm-dialog">
        <DialogHeader>
          <DialogTitle>
            Merge {source.name} into {target.name}?
          </DialogTitle>
          <DialogDescription>
            The source entity will be archived, not deleted. All mentions,
            tasks, and projects will be re-pointed to {target.name}. This is
            logged to the audit table. You can revert this within 7 days from
            the Inbox Resume card.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={pending}
            data-testid="merge-confirm-yes"
          >
            Yes, merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
