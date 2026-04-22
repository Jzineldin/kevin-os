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

import { createHash } from 'node:crypto';
import {
  embedBatch,
  buildEntityEmbedText,
  EMBED_MODEL_ID,
} from '@kos/resolver';

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
  const action: 'inserted' | 'updated' = res.rows[0].inserted ? 'inserted' : 'updated';

  // Plan 02-08 Task 2: embed D-08 entity text on insert + on field changes.
  // Wrapped in try/catch so an embed failure NEVER fails the upsert (the
  // resolver still works on trigram-only when embedding is NULL).
  await embedEntityIfNeeded(db, notionPageId, {
    name,
    aliases: aliases ?? [],
    seedContext,
    role,
    org,
    relationship,
  });
  return { action };
}

/**
 * Embed the D-08 entity text and persist {embedding, embedding_model, embed_hash}
 * iff the text hash differs from the cached embed_hash on the row. No-op when
 * the row is already up to date with the current text. Best-effort: failures
 * log a warning + continue (entity_index.embedding stays NULL until the next
 * successful tick).
 */
export async function embedEntityIfNeeded(
  db: DbExec,
  notionPageId: string,
  entity: {
    name: string;
    aliases: string[];
    seedContext: string | null;
    role: string | null;
    org: string | null;
    relationship: string | null;
  },
): Promise<void> {
  try {
    const text = buildEntityEmbedText(entity);
    if (!text || text.length === 0) return;
    const newHash = createHash('sha256').update(text).digest('hex');
    const existing = await db.query(
      'SELECT embed_hash FROM entity_index WHERE notion_page_id = $1',
      [notionPageId],
    );
    const storedHash =
      (existing.rows?.[0]?.embed_hash as string | null | undefined) ?? null;
    if (storedHash === newHash) return; // identical text — skip embed

    const [vec] = await embedBatch([text], 'search_document');
    if (!vec || vec.length === 0) {
      console.warn(`[indexer-embed] empty embedding for ${notionPageId}; skipping update`);
      return;
    }

    // Format vector for pgvector text input: '[1.0,2.0,...]'
    const vecLiteral = '[' + vec.join(',') + ']';
    await db.query(
      `UPDATE entity_index
          SET embedding = $1::vector,
              embedding_model = $2,
              embed_hash = $3
        WHERE notion_page_id = $4`,
      [vecLiteral, EMBED_MODEL_ID, newHash, notionPageId],
    );
  } catch (err) {
    console.warn(
      `[indexer-embed] failed for ${notionPageId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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

// --- Plan 02-07: KOS Inbox processor ---------------------------------------

/**
 * Normalise a proposed entity name for dedup lookup.
 * Mirrors `services/entity-resolver/src/inbox.ts` `normaliseName` exactly so
 * the resolver's Pitfall 7 dedup and the indexer's Approve-time dedup agree.
 */
export function normaliseName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface KosInboxBatchInput {
  client: {
    pages: {
      create: (input: any) => Promise<any>;
      update: (input: any) => Promise<any>;
    };
  };
  db: DbExec;
  rows: any[];
  ownerId: string;
  entitiesDbId: string;
}

export interface KosInboxBatchCounters {
  approved: number;
  rejected: number;
  skipped: number;
}

/**
 * Process a batch of KOS Inbox rows fetched from the Notion DB.
 *
 * Per row, dispatch on Status:
 *  - Pending  → skip (Kevin hasn't acted)
 *  - Merged   → skip (already processed)
 *  - Approved → dedup by normalised name in entity_index. If existing entity
 *               (Pitfall 7), reuse its notion_page_id; else create a new
 *               Entities-DB page with {Name, Type, SeedContext, Source:[kos-inbox],
 *               Status:Active}. Then flip Inbox row to Merged with MergedInto
 *               relation pointing at the target entity page.
 *  - Rejected → archive the Notion page (archived: true, archive-not-delete);
 *               write event_log kind='kos-inbox-rejected'.
 *
 * Idempotency: every Approved/Rejected transition writes an event_log row of
 * kind='kos-inbox-transition' with detail.{inbox_page_id, to_status,
 * capture_id}. Before processing, we SELECT 1 from event_log on
 * (inbox_page_id, to_status); if found → skip (already done in a prior tick).
 *
 * The new Entities page created here triggers the existing entities upsert
 * path on the next 5-min poll — entity_index population is indirect via that
 * normal flow (keeps Plan 02-07 thin).
 */
export async function processKosInboxBatch(
  input: KosInboxBatchInput,
): Promise<KosInboxBatchCounters> {
  const { client, db, rows, ownerId: _ownerId, entitiesDbId } = input;
  void _ownerId; // owner_id reserved for future per-owner dedup scoping
  const counters: KosInboxBatchCounters = { approved: 0, rejected: 0, skipped: 0 };

  for (const row of rows) {
    const inboxPageId: string = row.id;
    const status = (row.properties?.Status?.select?.name ?? null) as
      | 'Pending'
      | 'Approved'
      | 'Merged'
      | 'Rejected'
      | null;

    if (status === 'Pending' || status === 'Merged' || status === null) {
      counters.skipped += 1;
      continue;
    }

    // Dedup against event_log — were we already here?
    // Approved rows transition Inbox.Status → Merged; Rejected rows archive
    // and write to_status='Rejected'. The dedup key is the *destination*
    // status, not the inbound select value.
    const expectedToStatus = status === 'Approved' ? 'Merged' : 'Rejected';
    const dedup = await db.query(
      `SELECT 1 FROM event_log
        WHERE kind IN ('kos-inbox-transition', 'kos-inbox-rejected')
          AND detail->>'inbox_page_id' = $1
          AND detail->>'to_status' = $2
        LIMIT 1`,
      [inboxPageId, expectedToStatus],
    );
    if ((dedup.rows?.length ?? 0) > 0) {
      counters.skipped += 1;
      continue;
    }

    if (status === 'Rejected') {
      // Archive-not-delete (D-09 / archive-never-delete policy)
      await client.pages.update({ page_id: inboxPageId, archived: true });
      await db.query(
        `INSERT INTO event_log (kind, detail)
         VALUES ($1, jsonb_build_object(
                       'inbox_page_id', $2::text,
                       'to_status', $3::text,
                       'capture_id', $4::text,
                       'archived_at', now()))`,
        [
          'kos-inbox-rejected',
          inboxPageId,
          status,
          getInboxCaptureId(row),
        ],
      );
      counters.rejected += 1;
      continue;
    }

    // status === 'Approved'
    const proposedName = (
      row.properties?.['Proposed Entity Name']?.title?.[0]?.plain_text ?? ''
    ).toString();
    const norm = normaliseName(proposedName);
    const type = (row.properties?.Type?.select?.name ?? 'Person') as string;
    const rawContext = (
      row.properties?.['Raw Context']?.rich_text?.[0]?.plain_text ?? ''
    ).toString();
    const captureId = getInboxCaptureId(row);

    // Pitfall 7 dedup: check entity_index for existing match by name OR alias.
    const existing = await db.query(
      `SELECT id, notion_page_id, name FROM entity_index
        WHERE LOWER(name) = $1
           OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = $1)
        LIMIT 1`,
      [norm],
    );

    let targetPageId: string;
    if ((existing.rows?.length ?? 0) > 0) {
      // Reuse existing entity — no new Entities page
      targetPageId = existing.rows[0].notion_page_id as string;
    } else {
      // Create a new Entities-DB page; the next entities poll will upsert into entity_index.
      const created = await client.pages.create({
        parent: { database_id: entitiesDbId },
        properties: {
          Name: { title: [{ type: 'text', text: { content: proposedName } }] },
          Type: { select: { name: type } },
          SeedContext: {
            rich_text: [{ type: 'text', text: { content: rawContext.slice(0, 2000) } }],
          },
          Source: { multi_select: [{ name: 'kos-inbox' }] },
          Status: { select: { name: 'Active' } },
        },
      });
      targetPageId = created.id as string;
    }

    // Flip Inbox row to Merged with MergedInto pointing at the target entity page.
    await client.pages.update({
      page_id: inboxPageId,
      properties: {
        Status: { select: { name: 'Merged' } },
        MergedInto: { relation: [{ id: targetPageId }] },
      },
    });
    await db.query(
      `INSERT INTO event_log (kind, detail)
       VALUES ($1, jsonb_build_object(
                     'inbox_page_id', $2::text,
                     'to_status', $3::text,
                     'target_entity_page_id', $4::text,
                     'capture_id', $5::text,
                     'merged_at', now()))`,
      ['kos-inbox-transition', inboxPageId, 'Merged', targetPageId, captureId],
    );
    counters.approved += 1;
  }

  return counters;
}

function getInboxCaptureId(row: any): string {
  return (
    row?.properties?.['Source Capture ID']?.rich_text?.[0]?.plain_text ?? ''
  ).toString();
}
