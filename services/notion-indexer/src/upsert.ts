/**
 * Idempotent upsert helpers for entity_index / project_index / kevin_context.
 *
 * D-09 guarantees (enforced here):
 *  - Composite idempotency key = (notion_page_id, notion_last_edited_time)
 *  - ON CONFLICT (notion_page_id) DO UPDATE ... WHERE stored < incoming
 *  - Archive-not-delete: object_not_found (Notion hard-delete) writes to
 *    event_log but NEVER mutates or soft-deletes the stored row.
 *  - Status='Archived' is just a property value — flows through normal upsert.
 *
 * All functions accept a `pg.PoolClient | pg.Pool` for flexibility in tests.
 */

import {
  getTitlePlainText,
  getRichTextPlainText,
  getSelectName,
  getMultiSelectNames,
  getDateISO,
  getNumber,
  getRelationIds,
} from './notion-shapes.js';

export type DbExec = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

export type UpsertResult = {
  action: 'inserted' | 'updated' | 'skipped' | 'hard-delete-logged';
};

function pagePropsArray(page: any, key: string): unknown {
  return page?.properties?.[key];
}

// --- entity_index -----------------------------------------------------------

export async function upsertEntity(db: DbExec, page: any): Promise<UpsertResult> {
  const notionPageId: string = page.id;
  const lastEditedTime: string = page.last_edited_time;

  const existing = await db.query(
    'SELECT notion_last_edited_time FROM entity_index WHERE notion_page_id = $1',
    [notionPageId],
  );
  if (existing.rows.length > 0) {
    const stored = new Date(existing.rows[0].notion_last_edited_time);
    const incoming = new Date(lastEditedTime);
    if (stored.getTime() >= incoming.getTime()) {
      return { action: 'skipped' };
    }
  }

  const p = page.properties ?? {};
  const name = getTitlePlainText(p.Name);
  const aliases = getRichTextPlainText(p.Aliases)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const type = getSelectName(p.Type) ?? 'Person';
  const org = getRichTextPlainText(p.Org) || null;
  const role = getRichTextPlainText(p.Role) || null;
  const relationship = getSelectName(p.Relationship);
  const status = getSelectName(p.Status);
  const linkedProjects = getRelationIds(p.LinkedProjects);
  const seedContext = getRichTextPlainText(p.SeedContext) || null;
  const lastTouch = getDateISO(p.LastTouch);
  const manualNotes = getRichTextPlainText(p.ManualNotes) || null;
  const confidenceRaw = getNumber(p.Confidence);
  // Notion `number.format: percent` returns 0.0-1.0; store as 0-100 integer.
  const confidence =
    confidenceRaw === null ? null : Math.round(confidenceRaw * (confidenceRaw <= 1 ? 100 : 1));
  const source = getMultiSelectNames(p.Source);

  const res = await db.query(
    `INSERT INTO entity_index
        (notion_page_id, name, aliases, type, org, role, relationship, status,
         linked_projects, seed_context, last_touch, manual_notes, confidence, source,
         notion_last_edited_time, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
      ON CONFLICT (notion_page_id) DO UPDATE SET
        name = EXCLUDED.name,
        aliases = EXCLUDED.aliases,
        type = EXCLUDED.type,
        org = EXCLUDED.org,
        role = EXCLUDED.role,
        relationship = EXCLUDED.relationship,
        status = EXCLUDED.status,
        linked_projects = EXCLUDED.linked_projects,
        seed_context = EXCLUDED.seed_context,
        last_touch = EXCLUDED.last_touch,
        manual_notes = EXCLUDED.manual_notes,
        confidence = EXCLUDED.confidence,
        source = EXCLUDED.source,
        notion_last_edited_time = EXCLUDED.notion_last_edited_time,
        updated_at = now()
      WHERE entity_index.notion_last_edited_time < EXCLUDED.notion_last_edited_time
      RETURNING (xmax = 0) AS inserted`,
    [
      notionPageId,
      name,
      aliases,
      type,
      org,
      role,
      relationship,
      status,
      linkedProjects,
      seedContext,
      lastTouch,
      manualNotes,
      confidence,
      source,
      lastEditedTime,
    ],
  );
  if (res.rows.length === 0) return { action: 'skipped' };
  return { action: res.rows[0].inserted ? 'inserted' : 'updated' };
}

// --- project_index ----------------------------------------------------------

export async function upsertProject(db: DbExec, page: any): Promise<UpsertResult> {
  const notionPageId: string = page.id;
  const lastEditedTime: string = page.last_edited_time;

  const existing = await db.query(
    'SELECT notion_last_edited_time FROM project_index WHERE notion_page_id = $1',
    [notionPageId],
  );
  if (existing.rows.length > 0) {
    const stored = new Date(existing.rows[0].notion_last_edited_time);
    const incoming = new Date(lastEditedTime);
    if (stored.getTime() >= incoming.getTime()) {
      return { action: 'skipped' };
    }
  }

  const p = page.properties ?? {};
  const name = getTitlePlainText(p.Name);
  const bolag = getSelectName(p.Bolag);
  const status = getSelectName(p.Status);
  const description = getRichTextPlainText(p.Description) || null;
  const linkedPeople = getRelationIds(p.LinkedPeople);
  const seedContext = getRichTextPlainText(p.SeedContext) || null;

  const res = await db.query(
    `INSERT INTO project_index
        (notion_page_id, name, bolag, status, description, linked_people, seed_context,
         notion_last_edited_time, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      ON CONFLICT (notion_page_id) DO UPDATE SET
        name = EXCLUDED.name,
        bolag = EXCLUDED.bolag,
        status = EXCLUDED.status,
        description = EXCLUDED.description,
        linked_people = EXCLUDED.linked_people,
        seed_context = EXCLUDED.seed_context,
        notion_last_edited_time = EXCLUDED.notion_last_edited_time,
        updated_at = now()
      WHERE project_index.notion_last_edited_time < EXCLUDED.notion_last_edited_time
      RETURNING (xmax = 0) AS inserted`,
    [notionPageId, name, bolag, status, description, linkedPeople, seedContext, lastEditedTime],
  );
  if (res.rows.length === 0) return { action: 'skipped' };
  return { action: res.rows[0].inserted ? 'inserted' : 'updated' };
}

// --- kevin_context (MEM-02) -------------------------------------------------

/**
 * Upsert a single Kevin Context section — keyed on notion_block_id so edits
 * in-place flow through cleanly. `sectionHeading` and `sectionBody` are the
 * adjacent heading_2 + paragraph pair extracted by the handler.
 */
export async function upsertKevinContextSection(
  db: DbExec,
  notionBlockId: string,
  sectionHeading: string,
  sectionBody: string,
  notionLastEditedTime: string,
): Promise<UpsertResult> {
  const existing = await db.query(
    'SELECT notion_last_edited_time FROM kevin_context WHERE notion_block_id = $1',
    [notionBlockId],
  );
  if (existing.rows.length > 0) {
    const stored = new Date(existing.rows[0].notion_last_edited_time);
    const incoming = new Date(notionLastEditedTime);
    if (stored.getTime() >= incoming.getTime()) return { action: 'skipped' };
  }

  const res = await db.query(
    `INSERT INTO kevin_context
       (notion_block_id, section_heading, section_body, notion_last_edited_time, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (notion_block_id) DO UPDATE SET
        section_heading = EXCLUDED.section_heading,
        section_body = EXCLUDED.section_body,
        notion_last_edited_time = EXCLUDED.notion_last_edited_time,
        updated_at = now()
      WHERE kevin_context.notion_last_edited_time < EXCLUDED.notion_last_edited_time
      RETURNING (xmax = 0) AS inserted`,
    [notionBlockId, sectionHeading, sectionBody, notionLastEditedTime],
  );
  if (res.rows.length === 0) return { action: 'skipped' };
  return { action: res.rows[0].inserted ? 'inserted' : 'updated' };
}

// --- archive-not-delete -----------------------------------------------------

/**
 * Called when a Notion page referenced in our indexes has been hard-deleted
 * (object_not_found). Writes event_log but NEVER mutates entity_index /
 * project_index — archive-not-delete per D-09.
 *
 * The steady-state 5-min poller will rarely (if ever) hit this path, because
 * databases.query does not return hard-deleted pages. The notion-reconcile
 * weekly Lambda is the canonical detector (T-01-INDEX-02). This helper
 * exists so any hard-delete observed via a retrieve() call still lands in
 * event_log for parity.
 */
export async function handleArchivedOrMissing(
  db: DbExec,
  pageId: string,
  notionKind: 'entities' | 'projects' | 'kevin_context' | 'command_center',
  error: unknown,
): Promise<UpsertResult> {
  const isHardDelete =
    typeof error === 'object' &&
    error !== null &&
    ('code' in error ? (error as { code?: unknown }).code === 'object_not_found' : false);

  if (!isHardDelete) {
    // Unknown error — rethrow so caller can decide retry policy.
    throw error;
  }

  await db.query(
    `INSERT INTO event_log (kind, detail)
     VALUES ('notion-hard-delete',
             jsonb_build_object('notion_page_id', $1::text, 'kind', $2::text, 'detected_at', now()))`,
    [pageId, notionKind],
  );

  return { action: 'hard-delete-logged' };
}
