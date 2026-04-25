/**
 * Full transactional entity-merge handler + resume/cancel/revert.
 * Plan 03-11 Task 1 - replaces the Wave 0 stubs from Plan 03-02.
 *
 * State machine per migration 0007 (packages/db/drizzle/0007_entity_merge_audit.sql):
 *   initiated -> notion_relations_copied -> notion_archived -> rds_updated -> complete
 * Failure at any step -> failed_at_<lastOkState>. Partial failures emit a
 * merge_resume row in inbox_index so Plan 09's ResumeMergeCard surfaces it.
 *
 * ARCHIVE-NEVER-DELETE: see STATE.md #12; use pages.update({ archived: true }) only.
 * The Notion archive call lives in handlers/notion-merge.ts; THIS file never
 * calls the Notion page-deletion API. Grep assertion locks that in (the
 * assertion is documented in the plan + test files, not repeated as a
 * literal string here so the pattern stays greppable).
 *
 * Idempotency (T-3-11-01 Replay): merge_id is the PK of entity_merge_audit.
 * Duplicate POST with same merge_id hits the 23505 unique-violation and
 * returns 409 immediately - no side-effects re-run.
 *
 * Replay / cancel / revert (T-3-11-02): explicit ?action= query param on
 * resume. cancel = flip audit row to 'cancelled' (closes the Resume card
 * with no further work). revert = un-archive Notion + restore entity_index
 * status + flip mention_events back + 'reverted' state.
 */
import { and, eq } from 'drizzle-orm';
import {
  MergeRequestSchema,
  MergeResponseSchema,
  MergeResumeRequestSchema,
} from '@kos/contracts/dashboard';
import {
  agentRuns,
  entityIndex,
  entityMergeAudit,
  inboxIndex,
  mentionEvents,
} from '@kos/db/schema';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { getNotion } from '../notion.js';
import { OWNER_ID, ownerScoped } from '../owner-scoped.js';
import { publishOutput } from '../events.js';
import {
  archiveNotionPage,
  copyRelations,
  unarchiveNotionPage,
} from './notion-merge.js';

const STATE_ORDER = [
  'initiated',
  'notion_relations_copied',
  'notion_archived',
  'rds_updated',
  'complete',
] as const;
type State = (typeof STATE_ORDER)[number];

function isPastOrEqual(cur: State, target: State): boolean {
  return STATE_ORDER.indexOf(cur) >= STATE_ORDER.indexOf(target);
}

function normaliseState(raw: string): State {
  const stripped = raw.replace(/^failed_at_/, '');
  if ((STATE_ORDER as readonly string[]).includes(stripped)) {
    return stripped as State;
  }
  return 'initiated';
}

type Db = Awaited<ReturnType<typeof getDb>>;

async function updateAuditState(
  db: Db,
  merge_id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db
    .update(entityMergeAudit)
    .set(patch)
    .where(eq(entityMergeAudit.mergeId, merge_id));
}

async function markFailed(
  db: Db,
  merge_id: string,
  lastOkState: string,
  source_id: string,
  target_id: string,
  err: unknown,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  await updateAuditState(db, merge_id, {
    state: 'failed_at_' + lastOkState,
    errorMessage: errMsg,
  });
  try {
    await db.insert(inboxIndex).values({
      id: 'merge-' + merge_id,
      ownerId: OWNER_ID,
      kind: 'merge_resume',
      title: 'Resume merge (' + merge_id.slice(-6) + ')',
      preview: 'Merge paused at ' + lastOkState + ': ' + errMsg.slice(0, 140),
      mergeId: merge_id,
      payload: {
        failed_at: lastOkState,
        error: errMsg,
        source_id,
        target_id,
      },
      status: 'pending',
    });
  } catch (insertErr) {
    console.warn('[merge] inbox_index merge_resume insert failed', insertErr);
  }
}

async function runMergeSteps(
  db: Db,
  merge_id: string,
  source_id: string,
  target_id: string,
  startFrom: State,
): Promise<State> {
  const notion = getNotion();
  let lastOk: State = startFrom;

  if (!isPastOrEqual(startFrom, 'notion_relations_copied')) {
    await copyRelations(notion, source_id, target_id);
    await updateAuditState(db, merge_id, { state: 'notion_relations_copied' });
    lastOk = 'notion_relations_copied';
    // P-06 Notion rate limit (3 req/s): inter-call sleep.
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!isPastOrEqual(lastOk, 'notion_archived')) {
    await archiveNotionPage(notion, source_id);
    await updateAuditState(db, merge_id, {
      state: 'notion_archived',
      notionArchivedAt: new Date(),
    });
    lastOk = 'notion_archived';
  }

  if (!isPastOrEqual(lastOk, 'rds_updated')) {
    await db.transaction(async (tx) => {
      await tx
        .update(mentionEvents)
        .set({ entityId: target_id })
        .where(
          ownerScoped(
            mentionEvents,
            eq(mentionEvents.entityId, source_id),
          ),
        );
      await tx
        .update(entityIndex)
        .set({ status: 'merged_into' })
        .where(ownerScoped(entityIndex, eq(entityIndex.id, source_id)));
    });
    await updateAuditState(db, merge_id, {
      state: 'rds_updated',
      rdsUpdatedAt: new Date(),
    });
    lastOk = 'rds_updated';
  }

  if (!isPastOrEqual(lastOk, 'complete')) {
    await db.insert(agentRuns).values({
      ownerId: OWNER_ID,
      agentName: 'entity_merge_manual',
      captureId: null,
      outputJson: {
        source_id,
        target_id,
        merge_id,
        initiated_by: 'kevin',
      },
      status: 'ok',
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await updateAuditState(db, merge_id, {
      state: 'complete',
      completedAt: new Date(),
    });
    lastOk = 'complete';
    try {
      await publishOutput('entity_merge', {
        id: merge_id,
        entity_id: target_id,
        ts: new Date().toISOString(),
      });
    } catch (sseErr) {
      console.warn('[merge] publishOutput failed', sseErr);
    }
  }

  return lastOk;
}

async function mergeExecute(ctx: Ctx): Promise<RouteResponse> {
  const target_id = ctx.params['id'];
  if (!target_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_id' }) };
  }
  let parsed;
  try {
    parsed = MergeRequestSchema.parse(JSON.parse(ctx.body ?? '{}'));
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'invalid_body', detail: (e as Error).message }),
    };
  }
  const db = await getDb();
  const merge_id = parsed.merge_id;

  try {
    await db.insert(entityMergeAudit).values({
      mergeId: merge_id,
      ownerId: OWNER_ID,
      sourceEntityId: parsed.source_id,
      targetEntityId: target_id,
      initiatedBy: 'kevin',
      state: 'initiated',
      diff: parsed.diff,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return {
        statusCode: 409,
        body: JSON.stringify(
          MergeResponseSchema.parse({ ok: false, merge_id, resumable: true }),
        ),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'audit_insert_failed', detail: String(err) }),
    };
  }

  try {
    await runMergeSteps(db, merge_id, parsed.source_id, target_id, 'initiated');
    return {
      statusCode: 200,
      body: JSON.stringify(MergeResponseSchema.parse({ ok: true, merge_id })),
    };
  } catch (err) {
    const rows = await db
      .select()
      .from(entityMergeAudit)
      .where(eq(entityMergeAudit.mergeId, merge_id))
      .limit(1);
    const lastOk = normaliseState(rows[0]?.state ?? 'initiated');
    await markFailed(db, merge_id, lastOk, parsed.source_id, target_id, err);
    return {
      statusCode: 500,
      body: JSON.stringify(
        MergeResponseSchema.parse({ ok: false, merge_id, resumable: true }),
      ),
    };
  }
}

async function mergeResume(ctx: Ctx): Promise<RouteResponse> {
  let parsed;
  try {
    parsed = MergeResumeRequestSchema.parse(JSON.parse(ctx.body ?? '{}'));
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'invalid_body', detail: (e as Error).message }),
    };
  }
  const action = ctx.query['action'] ?? 'resume';
  const db = await getDb();
  const rows = await db
    .select()
    .from(entityMergeAudit)
    .where(eq(entityMergeAudit.mergeId, parsed.merge_id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { statusCode: 404, body: JSON.stringify({ error: 'merge_not_found' }) };
  }
  const merge_id = parsed.merge_id;

  if (action === 'cancel') {
    await updateAuditState(db, merge_id, { state: 'cancelled' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, merge_id }) };
  }

  if (action === 'revert') {
    const notion = getNotion();
    if (
      row.state === 'notion_archived' ||
      row.state === 'rds_updated' ||
      row.state === 'complete' ||
      row.state === 'failed_at_notion_archived' ||
      row.state === 'failed_at_rds_updated'
    ) {
      await unarchiveNotionPage(notion, row.sourceEntityId);
    }
    if (row.state === 'rds_updated' || row.state === 'complete') {
      await db.transaction(async (tx) => {
        await tx
          .update(mentionEvents)
          .set({ entityId: row.sourceEntityId })
          .where(
            ownerScoped(
              mentionEvents,
              and(eq(mentionEvents.entityId, row.targetEntityId))!,
            ),
          );
        await tx
          .update(entityIndex)
          .set({ status: 'active' })
          .where(ownerScoped(entityIndex, eq(entityIndex.id, row.sourceEntityId)));
      });
    }
    await updateAuditState(db, merge_id, { state: 'reverted' });
    return { statusCode: 200, body: JSON.stringify({ ok: true, merge_id }) };
  }

  if (row.state === 'complete') {
    return {
      statusCode: 200,
      body: JSON.stringify(MergeResponseSchema.parse({ ok: true, merge_id })),
    };
  }
  if (row.state === 'cancelled' || row.state === 'reverted') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: 'merge_not_resumable', state: row.state }),
    };
  }

  const startFrom = normaliseState(row.state);
  try {
    await runMergeSteps(
      db,
      merge_id,
      row.sourceEntityId,
      row.targetEntityId,
      startFrom,
    );
    return {
      statusCode: 200,
      body: JSON.stringify(MergeResponseSchema.parse({ ok: true, merge_id })),
    };
  } catch (err) {
    const rows2 = await db
      .select()
      .from(entityMergeAudit)
      .where(eq(entityMergeAudit.mergeId, merge_id))
      .limit(1);
    const lastOk = normaliseState(rows2[0]?.state ?? row.state);
    await markFailed(
      db,
      merge_id,
      lastOk,
      row.sourceEntityId,
      row.targetEntityId,
      err,
    );
    return {
      statusCode: 500,
      body: JSON.stringify(
        MergeResponseSchema.parse({ ok: false, merge_id, resumable: true }),
      ),
    };
  }
}

register('POST', '/entities/:id/merge', mergeExecute);
register('POST', '/entities/:id/merge/resume', mergeResume);

export { mergeExecute, mergeResume };
