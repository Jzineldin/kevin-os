/**
 * GET /today — composes the morning-briefing aggregate.
 *
 * Data sources (RESEARCH §9, composed in parallel via Promise.all):
 *   1. Notion 🏠 Today page  → `brief` (null on Plan 03 — wired in Phase 7).
 *   2. Notion Command Center → top 3 priorities.
 *   3. RDS inbox_index       → pending drafts (top 5).
 *   4. RDS entity_index      → dropped threads (last_touch > 7 days, active).
 *   5. Notion Today Meetings → meetings today (Phase 7 extension; Phase 3 returns []).
 *
 * Response shape MUST parse against TodayResponseSchema before returning
 * (zod at exit catches accidental shape drift).
 *
 * Caching: `Cache-Control: private, max-age=0, stale-while-revalidate=86400`
 * honours the 24h SWR rule from D-31.
 *
 * Phase 3 MUST NOT invoke an LLM (per RESEARCH §10 + D-02). The brief is
 * a simple Notion page property read.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { TodayResponseSchema } from '@kos/contracts/dashboard';
import { entityIndex, inboxIndex } from '@kos/db/schema';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { getNotion } from '../notion.js';
import { ownerScoped, OWNER_ID } from '../owner-scoped.js';

type TodayBrief = { body: string; generated_at: string } | null;

async function loadBrief(): Promise<TodayBrief> {
  const pageId = process.env.NOTION_TODAY_PAGE_ID;
  if (!pageId) return null;
  try {
    const page = (await getNotion().pages.retrieve({ page_id: pageId })) as {
      last_edited_time?: string;
      properties?: Record<string, unknown>;
    };
    const props = page.properties ?? {};
    const briefProp = (props as Record<string, { rich_text?: Array<{ plain_text?: string }> }>)[
      'Brief'
    ];
    const body = (briefProp?.rich_text ?? [])
      .map((r) => r.plain_text ?? '')
      .join('')
      .trim();
    if (!body) return null;
    return { body, generated_at: page.last_edited_time ?? new Date().toISOString() };
  } catch {
    // Pre-Phase-7 or Notion unavailable — UI renders D-05 placeholder.
    return null;
  }
}

async function loadPriorities(): Promise<
  Array<{
    id: string;
    title: string;
    bolag: 'tale-forge' | 'outbehaving' | 'personal' | null;
    entity_id: string | null;
    entity_name: string | null;
  }>
> {
  const cmdCenterDb = process.env.NOTION_COMMAND_CENTER_DB_ID;
  if (!cmdCenterDb) return [];
  try {
    const res = await getNotion().databases.query({
      database_id: cmdCenterDb,
      filter: {
        and: [
          {
            property: 'Prio',
            select: { does_not_equal: '' },
          },
          { property: 'Status', status: { does_not_equal: 'Done' } },
        ],
      },
      sorts: [{ property: 'Prio', direction: 'ascending' }],
      page_size: 3,
    });
    return (res.results as Array<{ id: string; properties: Record<string, unknown> }>)
      .map((p) => {
        const props = p.properties as Record<string, unknown>;
        const titleProp = props['Name'] as
          | { title?: Array<{ plain_text?: string }> }
          | undefined;
        const bolagProp = props['Bolag'] as { select?: { name?: string } } | undefined;
        const title = (titleProp?.title ?? [])
          .map((t) => t.plain_text ?? '')
          .join('')
          .trim();
        const rawBolag = bolagProp?.select?.name?.toLowerCase() ?? null;
        const bolag =
          rawBolag === 'tale forge' || rawBolag === 'tale-forge'
            ? ('tale-forge' as const)
            : rawBolag === 'outbehaving'
              ? ('outbehaving' as const)
              : rawBolag === 'personal'
                ? ('personal' as const)
                : null;
        return { id: p.id, title, bolag, entity_id: null, entity_name: null };
      })
      .filter((r) => r.title.length > 0);
  } catch {
    return [];
  }
}

async function loadDrafts(): Promise<
  Array<{
    id: string;
    entity: string;
    preview: string;
    from: string | null;
    subject: string | null;
    received_at: string;
  }>
> {
  const db = await getDb();
  const rows = await db
    .select({
      id: inboxIndex.id,
      title: inboxIndex.title,
      preview: inboxIndex.preview,
      payload: inboxIndex.payload,
      createdAt: inboxIndex.createdAt,
    })
    .from(inboxIndex)
    .where(ownerScoped(inboxIndex, and(eq(inboxIndex.status, 'pending'), eq(inboxIndex.kind, 'draft_reply'))!))
    .orderBy(desc(inboxIndex.createdAt))
    .limit(5);

  return rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const from = typeof payload['from'] === 'string' ? (payload['from'] as string) : null;
    const subject = typeof payload['subject'] === 'string' ? (payload['subject'] as string) : null;
    return {
      id: r.id,
      entity: r.title,
      preview: r.preview,
      from,
      subject,
      received_at: r.createdAt.toISOString(),
    };
  });
}

async function loadDropped(): Promise<
  Array<{
    id: string;
    entity_id: string;
    entity: string;
    age_days: number;
    bolag: 'tale-forge' | 'outbehaving' | 'personal' | null;
  }>
> {
  const db = await getDb();
  const rows = (await db.execute(sql`
    SELECT
      id::text AS id,
      id::text AS entity_id,
      name AS entity,
      EXTRACT(EPOCH FROM (now() - last_touch)) / 86400.0 AS age_days,
      CASE
        WHEN lower(org) IN ('tale forge','tale-forge') THEN 'tale-forge'
        WHEN lower(org) = 'outbehaving' THEN 'outbehaving'
        WHEN lower(org) = 'personal' THEN 'personal'
        ELSE NULL
      END AS bolag
    FROM entity_index
    WHERE owner_id = ${OWNER_ID}
      AND last_touch IS NOT NULL
      AND last_touch < now() - interval '7 days'
      AND status = 'active'
    ORDER BY last_touch DESC
    LIMIT 10
  `)) as unknown as {
    rows: Array<{
      id: string;
      entity_id: string;
      entity: string;
      age_days: string | number;
      bolag: string | null;
    }>;
  };

  return rows.rows.map((r) => ({
    id: r.id,
    entity_id: r.entity_id,
    entity: r.entity,
    age_days: typeof r.age_days === 'string' ? Number(r.age_days) : r.age_days,
    bolag: (r.bolag as 'tale-forge' | 'outbehaving' | 'personal' | null) ?? null,
  }));
}

async function todayHandler(_ctx: Ctx): Promise<RouteResponse> {
  const [brief, priorities, drafts, dropped] = await Promise.all([
    loadBrief(),
    loadPriorities(),
    loadDrafts(),
    loadDropped(),
  ]);

  const payload = TodayResponseSchema.parse({
    brief,
    priorities,
    drafts,
    dropped,
    meetings: [],
  });

  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=86400',
    },
  };
}

register('GET', '/today', todayHandler);

export { todayHandler };
