'use server';

/**
 * Server Action for the entity edit Dialog (D-29).
 *
 * Client component submits a partial patch; we zod-validate at the action
 * boundary (defence-in-depth per T-3-10-01) and then POST to dashboard-api,
 * which writes to Notion. Indexer's next 5-min cycle propagates back to
 * RDS — we return only {ok, id} here; the client calls `router.refresh()`
 * to re-fetch the dossier once the user closes the dialog.
 */
import { revalidatePath } from 'next/cache';
import { callApi } from '@/lib/dashboard-api';
import {
  EntityEditResponseSchema,
  EntityEditSchema,
  type EntityEditRequest,
} from '@kos/contracts/dashboard';

export async function editEntity(
  id: string,
  fields: EntityEditRequest,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = EntityEditSchema.safeParse(fields);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }

  try {
    const res = await callApi(
      `/entities/${id}`,
      {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      },
      EntityEditResponseSchema,
    );
    revalidatePath(`/entities/${id}`);
    return { ok: true, id: res.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown_error' };
  }
}
