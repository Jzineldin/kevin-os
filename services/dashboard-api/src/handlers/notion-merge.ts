/**
 * Notion-side merge helpers (Plan 03-11 Task 1).
 *
 * STATE.md #12 archive-never-delete is enforced HERE - archiveNotionPage
 * ONLY calls notion.pages.update({ page_id, archived: true }) and this
 * file contains NO page-deletion call anywhere. The grep assertion in
 * acceptance_criteria locks this down (no literal banned-string in the
 * code so the grep regex stays a pure negative match).
 *
 * Functions:
 *  - sourceNotionPageId(entityId) - look up entity_index.notion_page_id
 *    for a given UUID. Throws if not found.
 *  - copyRelations(notion, source, target) - step 1 of the merge. Per
 *    RESEARCH section 14: reads the source page's relation-typed
 *    properties and adds any missing relations to target. Idempotent
 *    via set-diff on existing target relation ids (RESEARCH dedup key).
 *    For Phase 3 we wire the Notion-native relation properties that
 *    actually exist on Entities rows; additional relations are
 *    forward-compatible (same merge semantics).
 *  - archiveNotionPage(notion, entityId) - step 2.
 *    pages.update({ archived: true }). The NEVER-delete rule is enforced
 *    by the absence of any deletion call in this file.
 *  - unarchiveNotionPage(notion, entityId) - Revert flow only.
 *    pages.update({ archived: false }). Same rule: this file never calls
 *    the Notion page-deletion API.
 */
// ARCHIVE-NEVER-DELETE: see STATE.md #12; use pages.update({ archived: true }) only.
import type { Client } from '@notionhq/client';
import { eq } from 'drizzle-orm';
import { entityIndex } from '@kos/db/schema';
import { getDb } from '../db.js';
import { ownerScoped } from '../owner-scoped.js';

export async function sourceNotionPageId(entity_id: string): Promise<string> {
  const db = await getDb();
  const rows = await db
    .select({ notionPageId: entityIndex.notionPageId })
    .from(entityIndex)
    .where(ownerScoped(entityIndex, eq(entityIndex.id, entity_id)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error('entity_index lookup failed: ' + entity_id);
  }
  return row.notionPageId;
}

/**
 * Copy relations from source Notion page to target.
 *
 * Per RESEARCH section 14: reads the source page's relation-typed
 * properties, and for each, appends any entries to the target that
 * are not already present. Idempotency is achieved via the natural
 * set-diff on existing target relation ids - copying twice is a no-op.
 *
 * Phase-3 scope: we handle the generic relation-typed property set (any
 * property whose type === 'relation' on the source Entities page).
 * Extending to further relations is additive - no code change needed as
 * long as Notion's property shape stays relation-typed.
 */
export async function copyRelations(
  notion: Client,
  source_entity_id: string,
  target_entity_id: string,
): Promise<void> {
  const sourcePageId = await sourceNotionPageId(source_entity_id);
  const targetPageId = await sourceNotionPageId(target_entity_id);

  const source = await notion.pages.retrieve({ page_id: sourcePageId });
  const target = await notion.pages.retrieve({ page_id: targetPageId });

  type PageWithProps = {
    properties?: Record<string, { type?: string; relation?: Array<{ id: string }> }>;
  };
  const srcProps = (source as PageWithProps).properties ?? {};
  const tgtProps = (target as PageWithProps).properties ?? {};

  const merged: Record<string, { relation: Array<{ id: string }> }> = {};
  for (const [key, prop] of Object.entries(srcProps)) {
    if (prop?.type !== 'relation' || !Array.isArray(prop.relation)) continue;
    const existing = tgtProps[key]?.relation ?? [];
    const existingIds = new Set(existing.map((r) => r.id));
    const toAdd = prop.relation.filter((r) => !existingIds.has(r.id));
    if (toAdd.length === 0) continue;
    merged[key] = { relation: [...existing, ...toAdd] };
  }

  if (Object.keys(merged).length === 0) return;

  await notion.pages.update({
    page_id: targetPageId,
    properties: merged as unknown as Parameters<
      typeof notion.pages.update
    >[0]['properties'],
  });
}

// ARCHIVE-NEVER-DELETE: see STATE.md #12; use pages.update({ archived: true }) only.
export async function archiveNotionPage(
  notion: Client,
  source_entity_id: string,
): Promise<void> {
  const page_id = await sourceNotionPageId(source_entity_id);
  await notion.pages.update({ page_id, archived: true });
}

// Revert path - un-archive (for the ?action=revert resume case).
export async function unarchiveNotionPage(
  notion: Client,
  source_entity_id: string,
): Promise<void> {
  const page_id = await sourceNotionPageId(source_entity_id);
  await notion.pages.update({ page_id, archived: false });
}
