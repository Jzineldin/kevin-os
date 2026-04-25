'use server';

/**
 * Server Actions for the merge review page (Plan 03-11 Task 2).
 *
 * `executeMerge`:
 *   - Validates payload with MergeRequestSchema at the action boundary.
 *   - Forwards to dashboard-api POST /entities/:target_id/merge via SigV4.
 *   - On success (`{ ok: true }`) redirects to /entities/<target_id>.
 *   - On failure (500 resumable) OR any thrown error, redirects to
 *     /inbox?focus=resume-<merge_id> so Plan 09's ResumeMergeCard surfaces
 *     the partial-failure thread.
 *
 * The merge_id is generated client-side (in MergeConfirmDialog.tsx) so we
 * can use it for the fallback redirect even when dashboard-api fails
 * before it writes the audit row. The handler rejects duplicate merge_ids
 * with 409 (T-3-11-01 Replay mitigation).
 */
import { redirect } from 'next/navigation';
import {
  MergeRequestSchema,
  MergeResponseSchema,
} from '@kos/contracts/dashboard';
import { callApi } from '@/lib/dashboard-api';

export async function executeMerge(
  target_id: string,
  source_id: string,
  merge_id: string,
  diff: Record<string, unknown>,
): Promise<void> {
  const parsed = MergeRequestSchema.safeParse({ source_id, merge_id, diff });
  if (!parsed.success) {
    // Validation failure before we even try: route back to the Inbox
    // resume card keyed to this merge_id so at least the audit trail
    // (if the row was ever written) is reachable.
    redirect(`/inbox?focus=resume-${merge_id}`);
  }

  let result;
  try {
    result = await callApi(
      `/entities/${target_id}/merge`,
      { method: 'POST', body: JSON.stringify(parsed.data) },
      MergeResponseSchema,
    );
  } catch {
    // Network or 5xx from dashboard-api -> surface to Inbox Resume card.
    redirect(`/inbox?focus=resume-${merge_id}`);
  }

  if (!result.ok) {
    redirect(`/inbox?focus=resume-${result.merge_id}`);
  }
  redirect(`/entities/${target_id}`);
}

export async function resumeMergeAction(merge_id: string): Promise<void> {
  try {
    await callApi(
      `/entities/-/merge/resume`,
      { method: 'POST', body: JSON.stringify({ merge_id }) },
      MergeResponseSchema,
    );
  } catch {
    redirect(`/inbox?focus=resume-${merge_id}`);
  }
}
