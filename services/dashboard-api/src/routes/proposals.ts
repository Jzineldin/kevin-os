/**
 * Phase 11 Plan 11-05 — proposal review queue API.
 *
 * Dashboard endpoints for the human-in-the-loop gate on AI-generated
 * artifacts. Kevin reviews each proposal (morning brief Top 3, extracted
 * action items, enriched entity metadata, etc.) via accept / reject /
 * edit+accept / replace actions. Only accepted proposals commit their
 * resolved_payload to downstream canonical state.
 *
 * Today's implementation is "proposal tracking only" — the commit
 * side-effect is still emitted by the original agent (dual-write era).
 * A future turn will flip agents to proposal-first (accept triggers
 * commit, no commit without accept). This lets Kevin experience the
 * review UX against real data without risking regression in the
 * already-working direct-write path.
 *
 * Routes:
 *   GET    /proposals                   list pending (with filters)
 *   GET    /proposals/:id               one proposal (full payload)
 *   POST   /proposals/:id/accept        accept as-is OR with edits
 *   POST   /proposals/:id/reject        archive, no commit
 *   POST   /proposals/:id/replace       reject + attach alternative
 *   POST   /proposals/batch/:batch_id   bulk action on a batch
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProposalRow {
  id: string;
  source_agent: string;
  capture_id: string | null;
  kind: string;
  proposed_payload: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected' | 'replaced' | 'superseded';
  resolved_payload: Record<string, unknown> | null;
  user_note: string | null;
  created_at: string;
  resolved_at: string | null;
  batch_id: string | null;
}

async function loadProposals(
  status: string | null,
  kind: string | null,
  limit: number,
): Promise<ProposalRow[]> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT id::text AS id,
           source_agent,
           capture_id,
           kind,
           proposed_payload,
           status,
           resolved_payload,
           user_note,
           created_at::text AS created_at,
           resolved_at::text AS resolved_at,
           batch_id::text AS batch_id
    FROM proposals
    WHERE owner_id = ${OWNER_ID}
      ${status ? sql`AND status = ${status}` : sql``}
      ${kind ? sql`AND kind = ${kind}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as { rows: ProposalRow[] };
  return r.rows;
}

async function loadProposal(id: string): Promise<ProposalRow | null> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT id::text AS id,
           source_agent,
           capture_id,
           kind,
           proposed_payload,
           status,
           resolved_payload,
           user_note,
           created_at::text AS created_at,
           resolved_at::text AS resolved_at,
           batch_id::text AS batch_id
    FROM proposals
    WHERE owner_id = ${OWNER_ID}
      AND id = ${id}::uuid
    LIMIT 1
  `)) as unknown as { rows: ProposalRow[] };
  return r.rows[0] ?? null;
}

async function updateStatus(
  id: string,
  newStatus: 'accepted' | 'rejected' | 'replaced',
  resolvedPayload: unknown,
  userNote: string | null,
): Promise<ProposalRow | null> {
  const db = await getDb();
  const r = (await db.execute(sql`
    UPDATE proposals
       SET status = ${newStatus},
           resolved_payload = ${resolvedPayload === undefined ? null : JSON.stringify(resolvedPayload)}::jsonb,
           user_note = ${userNote},
           resolved_at = now()
     WHERE owner_id = ${OWNER_ID}
       AND id = ${id}::uuid
       AND status = 'pending'
     RETURNING id::text AS id,
               source_agent,
               capture_id,
               kind,
               proposed_payload,
               status,
               resolved_payload,
               user_note,
               created_at::text AS created_at,
               resolved_at::text AS resolved_at,
               batch_id::text AS batch_id
  `)) as unknown as { rows: ProposalRow[] };
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /proposals — list
// ---------------------------------------------------------------------------

export async function listProposalsHandler(ctx: Ctx): Promise<RouteResponse> {
  const status = (ctx.query['status'] ?? 'pending').toString();
  const kind = (ctx.query['kind'] ?? '').toString() || null;
  const limitRaw = Number(ctx.query['limit'] ?? 50);
  const limit = Math.max(1, Math.min(200, isFinite(limitRaw) ? limitRaw : 50));

  const allowedStatuses = new Set([
    'pending',
    'accepted',
    'rejected',
    'replaced',
    'superseded',
    'all',
  ]);
  if (!allowedStatuses.has(status)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_status',
        allowed: [...allowedStatuses],
      }),
    };
  }
  const rows = await loadProposals(status === 'all' ? null : status, kind, limit);

  // Group by batch_id so the UI can render "Morning brief 2026-04-27
  // (3 items pending)" cards. Loose items (no batch_id) bucket under
  // a single null key.
  const batches = new Map<string, ProposalRow[]>();
  for (const r of rows) {
    const key = r.batch_id ?? `__solo_${r.id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key)!.push(r);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      total: rows.length,
      status_filter: status,
      kind_filter: kind,
      items: rows,
      batches: [...batches.entries()].map(([batchId, items]) => ({
        batch_id: batchId.startsWith('__solo_') ? null : batchId,
        items,
      })),
    }),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=30',
    },
  };
}

// ---------------------------------------------------------------------------
// GET /proposals/:id — detail
// ---------------------------------------------------------------------------

export async function getProposalHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!id || !UUID_RE.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  const row = await loadProposal(id);
  if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  return {
    statusCode: 200,
    body: JSON.stringify(row),
    headers: { 'cache-control': 'no-store' },
  };
}

// ---------------------------------------------------------------------------
// POST /proposals/:id/accept — accept as-is OR with edits.
// Body optional: { edited_payload?: unknown, user_note?: string }.
// When edited_payload is present, resolved_payload stores the edit;
// otherwise resolved_payload is set to proposed_payload verbatim.
// ---------------------------------------------------------------------------

const AcceptBodySchema = z
  .object({
    edited_payload: z.unknown().optional(),
    user_note: z.string().max(1000).optional(),
  })
  .default({});

export async function acceptProposalHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!id || !UUID_RE.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  let body: z.infer<typeof AcceptBodySchema>;
  try {
    body = AcceptBodySchema.parse(ctx.body ? JSON.parse(ctx.body) : {});
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_body' }) };
  }

  const existing = await loadProposal(id);
  if (!existing) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (existing.status !== 'pending') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: 'already_resolved', status: existing.status }),
    };
  }

  const resolvedPayload =
    body.edited_payload !== undefined ? body.edited_payload : existing.proposed_payload;
  const updated = await updateStatus(id, 'accepted', resolvedPayload, body.user_note ?? null);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, proposal: updated }),
    headers: { 'cache-control': 'no-store' },
  };
}

// ---------------------------------------------------------------------------
// POST /proposals/:id/reject — archive, no commit.
// ---------------------------------------------------------------------------

const RejectBodySchema = z
  .object({ user_note: z.string().max(1000).optional() })
  .default({});

export async function rejectProposalHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!id || !UUID_RE.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  let body: z.infer<typeof RejectBodySchema>;
  try {
    body = RejectBodySchema.parse(ctx.body ? JSON.parse(ctx.body) : {});
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_body' }) };
  }
  const existing = await loadProposal(id);
  if (!existing) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (existing.status !== 'pending') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: 'already_resolved', status: existing.status }),
    };
  }
  const updated = await updateStatus(id, 'rejected', null, body.user_note ?? null);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, proposal: updated }),
    headers: { 'cache-control': 'no-store' },
  };
}

// ---------------------------------------------------------------------------
// POST /proposals/:id/replace — reject this and propose something else.
// Required: replacement_payload (Kevin's alternative). A NEW proposal row
// is written in 'accepted' status with source_agent='kevin-replace' so the
// audit trail shows where the replacement came from.
// ---------------------------------------------------------------------------

const ReplaceBodySchema = z.object({
  replacement_payload: z.unknown(),
  user_note: z.string().max(1000).optional(),
});

export async function replaceProposalHandler(ctx: Ctx): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!id || !UUID_RE.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_id' }) };
  }
  let body: z.infer<typeof ReplaceBodySchema>;
  try {
    body = ReplaceBodySchema.parse(ctx.body ? JSON.parse(ctx.body) : {});
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'invalid_body',
        required: ['replacement_payload'],
      }),
    };
  }
  const existing = await loadProposal(id);
  if (!existing) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (existing.status !== 'pending') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: 'already_resolved', status: existing.status }),
    };
  }

  const db = await getDb();
  // Mark original as 'replaced'
  const originalUpdated = await updateStatus(
    id,
    'replaced',
    body.replacement_payload,
    body.user_note ?? null,
  );
  // Insert the replacement as an already-accepted proposal so audit + UI
  // stay consistent. Same batch_id as the original so batch views keep
  // the grouping.
  const { rows: insertedRows } = (await db.execute(sql`
    INSERT INTO proposals
      (owner_id, source_agent, capture_id, kind, proposed_payload,
       status, resolved_payload, resolved_at, batch_id, user_note)
    VALUES (
      ${OWNER_ID},
      'kevin-replace',
      ${existing.capture_id},
      ${existing.kind},
      ${JSON.stringify(body.replacement_payload)}::jsonb,
      'accepted',
      ${JSON.stringify(body.replacement_payload)}::jsonb,
      now(),
      ${existing.batch_id ? sql`${existing.batch_id}::uuid` : sql`NULL::uuid`},
      ${body.user_note ?? null}
    )
    RETURNING id::text AS id
  `)) as unknown as { rows: Array<{ id: string }> };

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      original: originalUpdated,
      replacement_id: insertedRows[0]?.id,
    }),
    headers: { 'cache-control': 'no-store' },
  };
}

register('GET', '/proposals', listProposalsHandler);
register('GET', '/proposals/:id', getProposalHandler);
register('POST', '/proposals/:id/accept', acceptProposalHandler);
register('POST', '/proposals/:id/reject', rejectProposalHandler);
register('POST', '/proposals/:id/replace', replaceProposalHandler);
