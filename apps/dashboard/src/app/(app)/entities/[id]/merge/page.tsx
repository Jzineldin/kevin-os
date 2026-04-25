/**
 * Merge review page — `/entities/[targetId]/merge?source=<sourceId>` (Plan 03-11 Task 2).
 *
 * Server Component. Fetches target + source entities in parallel via SigV4
 * callApi and hands off to <MergeReview />. Two-column diff + shadcn Dialog
 * confirm per UI-SPEC §View 3.5. Copy bindings (verbatim from UI-SPEC
 * Copywriting table):
 *   Headline: "Merge {source.name} into {target.name}?"
 *   Body:    "The source entity will be archived, not deleted. All mentions,
 *             tasks, and projects will be re-pointed to {target.name}. This is
 *             logged to the audit table. You can revert this within 7 days from
 *             the Inbox Resume card."
 *   Primary: "Yes, merge"
 *   Secondary: "Cancel"
 *
 * On successful merge → redirect to /entities/<target>; on failure →
 * redirect to /inbox?focus=resume-<merge_id> so Plan 09's ResumeMergeCard
 * picks up the partial-failure thread.
 */
import { notFound, redirect } from 'next/navigation';
import {
  EntityResponseSchema,
  type EntityResponse,
} from '@kos/contracts/dashboard';
import { callApi } from '@/lib/dashboard-api';
import { MergeReview } from './MergeReview';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MergePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { id: targetId } = await params;
  const { source } = await searchParams;

  if (!UUID_RE.test(targetId)) notFound();
  if (!source || !UUID_RE.test(source)) {
    // No source param -> nothing to merge. Route back to the entity dossier.
    redirect(`/entities/${targetId}`);
  }

  let target: EntityResponse;
  let sourceEntity: EntityResponse;
  try {
    [target, sourceEntity] = await Promise.all([
      callApi(`/entities/${targetId}`, { method: 'GET' }, EntityResponseSchema),
      callApi(`/entities/${source}`, { method: 'GET' }, EntityResponseSchema),
    ]);
  } catch (err) {
    if (err instanceof Error && /→ 404/.test(err.message)) notFound();
    throw err;
  }

  return <MergeReview target={target} source={sourceEntity} />;
}
