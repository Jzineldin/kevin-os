/**
 * Phase 8 Plan 08-05 Task 2 — entity-timeline extension for MEM-05
 * document_versions.
 *
 * `listEntityTimeline` is a function-level helper consumed by Plan 08-05
 * dashboard surfaces (and any caller wanting "what changed since v3 went
 * to Damien" answered in one query). It loads:
 *
 *   1. The entity row (id, name, primary_email) from `entity_index`.
 *   2. Recent `mention_events` for the entity (legacy timeline source).
 *   3. NEW: `document_versions` whose `recipient_email` matches the
 *      entity's primary_email (or any alias email). Each row is shaped
 *      as `{ kind: 'document_version', doc_name, version_n, diff_summary,
 *      sent_at, recipient_email }`.
 *
 * The handler in `src/handlers/timeline.ts` remains the canonical
 * `GET /entities/:id/timeline` route — the MV+overlay path is what the
 * dashboard reads on the hot path. This helper is the v1 hook for the
 * "documents I sent to this entity" answer; future plans may merge it
 * into the MV-overlay query directly.
 *
 * Scope (T-08-DIFF-06 mitigation):
 *   - owner_id filter on every query.
 *   - recipient_email match restricted to the entity's primary_email +
 *     explicit alias emails (no wildcard, no LIKE).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

export interface EntityTimelineDocumentVersion {
  kind: 'document_version';
  id: string;
  doc_name: string;
  version_n: number;
  sha256: string;
  parent_sha256: string | null;
  diff_summary: string | null;
  sent_at: string;
  recipient_email: string;
}

export interface EntityTimelineMention {
  kind: 'mention';
  id: string;
  occurred_at: string;
  source: string;
  context: string | null;
  capture_id: string | null;
}

export type EntityTimelineItem = EntityTimelineDocumentVersion | EntityTimelineMention;

export interface EntityTimelineResult {
  entity: { id: string; name: string; primary_email: string | null } | null;
  items: EntityTimelineItem[];
}

/**
 * Load the entity timeline merged with `document_versions` keyed on
 * recipient_email. Returns at most `limit` items (default 50) sorted
 * by their effective timestamp (occurred_at for mentions, sent_at for
 * document versions) descending.
 *
 * Returns `{ entity: null, items: [] }` when the entity id doesn't
 * resolve under the active owner.
 */
export async function listEntityTimeline(args: {
  entityId: string;
  ownerId?: string;
  limit?: number;
}): Promise<EntityTimelineResult> {
  const ownerId = args.ownerId ?? OWNER_ID;
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const db = await getDb();

  // 1. Load entity row. Phase 2 entity_index does NOT yet have a
  //    dedicated `primary_email` / `email text[]` column (services/
  //    email-triage/src/resolveEntities.ts documents this gap). For v1
  //    we extract email-shaped values from the existing `aliases`
  //    text[] column. When the dedicated column lands, this query
  //    picks up the new shape via the COALESCE branch below.
  const entityRes = (await db.execute(sql`
    SELECT id, name, COALESCE(aliases, ARRAY[]::text[]) AS aliases
      FROM entity_index
      WHERE id = ${args.entityId}
        AND owner_id = ${ownerId}
      LIMIT 1
  `)) as unknown as {
    rows: Array<{ id: string; name: string; aliases: string[] | null }>;
  };
  if (!entityRes.rows || entityRes.rows.length === 0) {
    return { entity: null, items: [] };
  }
  const entity = entityRes.rows[0]!;
  const aliasEmails = (entity.aliases ?? []).filter(
    (a) => typeof a === 'string' && a.includes('@'),
  );
  const primaryEmail = aliasEmails[0] ?? null;
  const emails: string[] = aliasEmails.map((e) => e.toLowerCase());

  // 2. Load recent mention_events (legacy timeline source).
  const mentionsRes = (await db.execute(sql`
    SELECT id::text AS id, occurred_at, source, context, capture_id
      FROM mention_events
      WHERE owner_id = ${ownerId}
        AND entity_id = ${args.entityId}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      occurred_at: Date | string;
      source: string;
      context: string | null;
      capture_id: string | null;
    }>;
  };

  // 3. NEW: Load document_versions whose recipient_email matches the
  //    entity's primary_email. Skipped when the entity has no email.
  let docRows: EntityTimelineDocumentVersion[] = [];
  if (emails.length > 0) {
    const docsRes = (await db.execute(sql`
      SELECT id::text AS id,
             recipient_email,
             doc_name,
             version_n,
             sha256,
             parent_sha256,
             diff_summary,
             sent_at
        FROM document_versions
        WHERE owner_id = ${ownerId}
          AND recipient_email = ANY(${emails}::text[])
        ORDER BY sent_at DESC
        LIMIT ${limit}
    `)) as unknown as {
      rows: Array<{
        id: string;
        recipient_email: string;
        doc_name: string;
        version_n: number;
        sha256: string;
        parent_sha256: string | null;
        diff_summary: string | null;
        sent_at: Date | string;
      }>;
    };
    docRows = docsRes.rows.map((d) => ({
      kind: 'document_version' as const,
      id: d.id,
      doc_name: d.doc_name,
      version_n: d.version_n,
      sha256: d.sha256,
      parent_sha256: d.parent_sha256,
      diff_summary: d.diff_summary,
      sent_at:
        d.sent_at instanceof Date ? d.sent_at.toISOString() : String(d.sent_at),
      recipient_email: d.recipient_email,
    }));
  }

  const mentionItems: EntityTimelineMention[] = mentionsRes.rows.map((m) => ({
    kind: 'mention',
    id: m.id,
    occurred_at:
      m.occurred_at instanceof Date
        ? m.occurred_at.toISOString()
        : String(m.occurred_at),
    source: m.source,
    context: m.context,
    capture_id: m.capture_id,
  }));

  // 4. Merge + sort by effective timestamp DESC.
  const merged: EntityTimelineItem[] = [...mentionItems, ...docRows];
  merged.sort((a, b) => {
    const aTs = a.kind === 'mention' ? a.occurred_at : a.sent_at;
    const bTs = b.kind === 'mention' ? b.occurred_at : b.sent_at;
    return new Date(bTs).getTime() - new Date(aTs).getTime();
  });

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      primary_email: primaryEmail,
    },
    items: merged.slice(0, limit),
  };
}
