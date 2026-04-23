/**
 * GET /entities/list  — sidebar counts + command palette root data.
 * GET /entities/:id   — entity dossier (RESEARCH §10).
 *
 * Phase 3 MUST NOT invoke an LLM. The `ai_block` field returns the last
 * known `seed_context` + `cached_at: null`; Phase 6 AGT-04 will replace
 * this with a live Gemini 2.5 Pro call.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { EntityResponseSchema } from '@kos/contracts/dashboard';
import { entityIndex, mentionEvents, projectIndex } from '@kos/db/schema';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { ownerScoped, OWNER_ID } from '../owner-scoped.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBolag(org: string | null): 'tale-forge' | 'outbehaving' | 'personal' | null {
  const o = (org ?? '').toLowerCase();
  if (o === 'tale forge' || o === 'tale-forge') return 'tale-forge';
  if (o === 'outbehaving') return 'outbehaving';
  if (o === 'personal') return 'personal';
  return null;
}

async function entitiesListHandler(ctx: Ctx): Promise<RouteResponse> {
  const db = await getDb();
  const typeFilter = ctx.query['type'];

  const rows = await db
    .select({
      id: entityIndex.id,
      name: entityIndex.name,
      type: entityIndex.type,
      org: entityIndex.org,
      lastTouch: entityIndex.lastTouch,
    })
    .from(entityIndex)
    .where(
      typeFilter
        ? ownerScoped(entityIndex, eq(entityIndex.type, typeFilter))
        : ownerScoped(entityIndex),
    )
    .orderBy(desc(entityIndex.lastTouch))
    .limit(500);

  const entities = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    bolag: toBolag(r.org),
    last_touch: r.lastTouch?.toISOString() ?? null,
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ entities }),
    headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=300' },
  };
}

async function entitiesGetHandler(ctx: Ctx): Promise<RouteResponse> {
  const idParam = ctx.params['id'];
  if (!idParam || !UUID_RE.test(idParam)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_entity_id' }) };
  }

  const db = await getDb();

  // Base entity row.
  const rows = await db
    .select()
    .from(entityIndex)
    .where(ownerScoped(entityIndex, eq(entityIndex.id, idParam)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { statusCode: 404, body: JSON.stringify({ error: 'entity_not_found' }) };
  }

  // Linked projects — join via entityIndex.linkedProjects array → projectIndex.notionPageId.
  const linkedIds = row.linkedProjects ?? [];
  let linked: Array<{
    id: string;
    name: string;
    bolag: 'tale-forge' | 'outbehaving' | 'personal' | null;
  }> = [];
  if (linkedIds.length > 0) {
    const projs = (await db.execute(sql`
      SELECT id::text AS id, name, bolag
      FROM project_index
      WHERE owner_id = ${OWNER_ID}
        AND notion_page_id = ANY(${linkedIds})
    `)) as unknown as { rows: Array<{ id: string; name: string; bolag: string | null }> };
    linked = projs.rows.map((p) => ({
      id: p.id,
      name: p.name,
      bolag: toBolag(p.bolag),
    }));
  }

  // Stats — aggregate from mention_events.
  const statsQ = (await db.execute(sql`
    SELECT
      MIN(occurred_at) AS first_contact,
      COUNT(*)::int AS total_mentions
    FROM mention_events
    WHERE owner_id = ${OWNER_ID} AND entity_id = ${idParam}
  `)) as unknown as {
    rows: Array<{ first_contact: Date | string | null; total_mentions: number }>;
  };
  const stats0 = statsQ.rows[0];

  // Active threads = mentions in last 14 days (simple heuristic).
  const activeQ = (await db.execute(sql`
    SELECT COUNT(DISTINCT source)::int AS n
    FROM mention_events
    WHERE owner_id = ${OWNER_ID}
      AND entity_id = ${idParam}
      AND occurred_at > now() - interval '14 days'
  `)) as unknown as { rows: Array<{ n: number }> };
  const active0 = activeQ.rows[0];

  const firstContactRaw = stats0?.first_contact ?? null;
  const firstContact =
    firstContactRaw instanceof Date
      ? firstContactRaw.toISOString()
      : typeof firstContactRaw === 'string'
        ? firstContactRaw
        : null;

  const aiBody =
    row.seedContext && row.seedContext.trim().length > 0
      ? row.seedContext.trim()
      : 'Based on last known summary · Full AI context coming soon';

  // Phase 3 entity type is loose; coerce to contract enum or fall through.
  const allowedTypes = new Set(['Person', 'Project', 'Company', 'Document']);
  const entityType = allowedTypes.has(row.type) ? row.type : 'Person';

  const payload = EntityResponseSchema.parse({
    id: row.id,
    name: row.name,
    type: entityType,
    aliases: row.aliases ?? [],
    org: row.org,
    role: row.role,
    relationship: row.relationship,
    status: row.status ?? 'active',
    seed_context: row.seedContext,
    manual_notes: row.manualNotes,
    last_touch: row.lastTouch?.toISOString() ?? null,
    confidence: row.confidence,
    linked_projects: linked,
    stats: {
      first_contact: firstContact,
      total_mentions: stats0?.total_mentions ?? 0,
      active_threads: active0?.n ?? 0,
    },
    ai_block: { body: aiBody, cached_at: null },
  });

  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=60' },
  };
}

register('GET', '/entities/list', entitiesListHandler);
register('GET', '/entities/:id', entitiesGetHandler);

// Silence unused-import warnings; projectIndex + mentionEvents referenced in raw sql.
void projectIndex;
void mentionEvents;

export { entitiesListHandler, entitiesGetHandler };
