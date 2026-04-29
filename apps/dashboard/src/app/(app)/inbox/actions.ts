'use server';

/**
 * Inbox Server Actions (Plan 03-09 Task 1). Invoked from <InboxClient />'s
 * keyboard handlers (Enter = approve, E = edit, S = skip) and the detail
 * pane's on-screen Action Bar.
 *
 * Mirrors the pattern established in Plan 03-08 `today/actions.ts` — the
 * 'use server' directive is route-scoped and Next 15 rejects Server Actions
 * authored across file boundaries, so this module lives next to the client
 * view rather than in a shared /lib.
 *
 * Every mutation `revalidatePath('/inbox')` to drop the RSC cache; the
 * `useOptimistic` pair on the client keeps the UI snappy while this round
 * trips.
 *
 * Validation: request shapes are parsed with the shared zod schemas from
 * `@kos/contracts/dashboard` at the boundary — a bad payload throws here
 * before the SigV4 call (T-3-09-01 mitigation).
 */
import { revalidatePath } from 'next/cache';

import { callApi } from '@/lib/dashboard-api';
import {
  InboxActionResponseSchema,
  InboxApproveSchema,
  InboxEditSchema,
} from '@kos/contracts/dashboard';

export async function approveInbox(
  id: string,
  edits?: Record<string, unknown>,
): Promise<void> {
  const body = InboxApproveSchema.parse({ edits });
  await callApi(
    `/inbox/${id}/approve`,
    { method: 'POST', body: JSON.stringify(body) },
    InboxActionResponseSchema,
  );
  revalidatePath('/inbox');
}

export async function editInbox(
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const body = InboxEditSchema.parse({ fields });
  await callApi(
    `/inbox/${id}/edit`,
    { method: 'POST', body: JSON.stringify(body) },
    InboxActionResponseSchema,
  );
  revalidatePath('/inbox');
}

export async function skipInbox(id: string): Promise<void> {
  await callApi(
    `/inbox/${id}/skip`,
    { method: 'POST' },
    InboxActionResponseSchema,
  );
  revalidatePath('/inbox');
}

export async function delegateInboxItem(params: {
  kind: string;
  id: string;
  title: string;
  context?: string;
}): Promise<void> {
  const { callApi } = await import('@/lib/dashboard-api');
  const { z } = await import('zod');
  const OkSchema = z.object({ ok: z.boolean() });
  await callApi('/delegate', {
    method: 'POST',
    body: JSON.stringify(params),
  }, OkSchema);
}
