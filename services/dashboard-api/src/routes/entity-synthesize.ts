/**
 * Phase 11 Plan 11-04 part C — on-demand dossier synthesis.
 *
 * The KOS-overview mockup shows each entity page topped with an
 * "AI synthesis: What you need to know" block — 3-5 sentences summarising
 * the relationship, recent state, and open threads. The plan assumed
 * Gemini 2.5 Pro + 1M-token dossier loads (Phase 6 AGT-04 future);
 * for now we do a pragmatic Sonnet 4.6 pass against ~5k tokens of
 * per-entity context:
 *
 *   - entity_index row (name, type, relationship, seed_context)
 *   - latest 15 mention_events contexts
 *   - latest 5 email_drafts from/to involving the entity name
 *   - latest 3 transcript-indexed summaries mentioning the entity
 *
 * Results cached in entity_dossiers_cached for 24h. Migration 0012's
 * trigger already invalidates the cache on new mention_events insert —
 * so the synthesis stays fresh as data flows in.
 *
 * Endpoint shape:
 *   POST /entities/:id/synthesize
 *   → { synthesis: string, cached_at: string }
 *
 * The existing GET /entities/:id now also prefers the cached synthesis
 * over raw seed_context when present (see entities.ts ai_block path).
 */
import { sql } from 'drizzle-orm';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

const SONNET_4_6_MODEL_ID = 'eu.anthropic.claude-sonnet-4-6';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let bedrock: AnthropicBedrock | null = null;
function getBedrock(): AnthropicBedrock {
  if (!bedrock) {
    bedrock = new AnthropicBedrock({
      awsRegion:
        process.env.AWS_REGION_DASHBOARD ?? process.env.AWS_REGION ?? 'eu-north-1',
    });
  }
  return bedrock;
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  relationship: string | null;
  org: string | null;
  role: string | null;
  seed_context: string | null;
  manual_notes: string | null;
  last_touch: string | null;
}

async function loadEntity(id: string): Promise<EntityRow | null> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT id::text AS id, name, type, relationship, org, role,
           seed_context, manual_notes, last_touch::text AS last_touch
    FROM entity_index
    WHERE owner_id = ${OWNER_ID} AND id = ${id}::uuid
    LIMIT 1
  `)) as unknown as { rows: EntityRow[] };
  return r.rows[0] ?? null;
}

interface MentionRow {
  context: string;
  source: string;
  occurred_at: string;
}

async function loadMentions(entityId: string): Promise<MentionRow[]> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT context, source, occurred_at::text AS occurred_at
    FROM mention_events
    WHERE owner_id = ${OWNER_ID} AND entity_id = ${entityId}::uuid
    ORDER BY occurred_at DESC
    LIMIT 15
  `)) as unknown as { rows: MentionRow[] };
  return r.rows;
}

interface EmailRow {
  from_email: string;
  subject: string;
  received_at: string;
  preview: string | null;
  classification: string | null;
}

async function loadRelatedEmails(entityName: string): Promise<EmailRow[]> {
  const db = await getDb();
  const q = `%${entityName.toLowerCase()}%`;
  const r = (await db.execute(sql`
    SELECT from_email,
           COALESCE(subject, '(no subject)') AS subject,
           received_at::text AS received_at,
           COALESCE(body_preview, LEFT(body_plain, 200)) AS preview,
           classification
    FROM email_drafts
    WHERE owner_id = ${OWNER_ID}
      AND (
        lower(from_email) LIKE ${q}
        OR lower(COALESCE(subject, '')) LIKE ${q}
        OR lower(COALESCE(body_preview, '')) LIKE ${q}
      )
    ORDER BY received_at DESC
    LIMIT 5
  `)) as unknown as { rows: EmailRow[] };
  return r.rows;
}

async function readCachedSynthesis(
  entityId: string,
): Promise<{ body: string; cached_at: string } | null> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT bundle, created_at::text AS created_at
    FROM entity_dossiers_cached
    WHERE owner_id = ${OWNER_ID}
      AND entity_id = ${entityId}::uuid
      AND expires_at > now()
    LIMIT 1
  `)) as unknown as {
    rows: Array<{ bundle: Record<string, unknown>; created_at: string }>;
  };
  const row = r.rows[0];
  if (!row) return null;
  const body = typeof row.bundle?.synthesis === 'string'
    ? (row.bundle.synthesis as string)
    : null;
  if (!body) return null;
  return { body, cached_at: row.created_at };
}

async function writeCachedSynthesis(
  entityId: string,
  synthesis: string,
  sourceCount: { mentions: number; emails: number },
): Promise<string> {
  const db = await getDb();
  const r = (await db.execute(sql`
    INSERT INTO entity_dossiers_cached
      (entity_id, owner_id, last_touch_hash, bundle, created_at, expires_at)
    VALUES (
      ${entityId}::uuid,
      ${OWNER_ID},
      ${'chat-sonnet-4-6:' + new Date().toISOString()},
      ${JSON.stringify({
        source: 'chat-synthesis-v1',
        synthesis,
        counts: sourceCount,
      })}::jsonb,
      now(),
      now() + interval '24 hours'
    )
    ON CONFLICT (entity_id, owner_id) DO UPDATE
      SET bundle = EXCLUDED.bundle,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          last_touch_hash = EXCLUDED.last_touch_hash
    RETURNING created_at::text AS created_at
  `)) as unknown as { rows: Array<{ created_at: string }> };
  return r.rows[0]?.created_at ?? new Date().toISOString();
}

function formatCorpus(
  entity: EntityRow,
  mentions: MentionRow[],
  emails: EmailRow[],
): string {
  const parts: string[] = [];
  parts.push(`<entity>`);
  parts.push(`Name: ${entity.name}`);
  parts.push(`Type: ${entity.type}`);
  if (entity.relationship && entity.relationship !== 'unknown')
    parts.push(`Relationship: ${entity.relationship}`);
  if (entity.org) parts.push(`Org: ${entity.org}`);
  if (entity.role) parts.push(`Role: ${entity.role}`);
  if (entity.seed_context) parts.push(`Seed context: ${entity.seed_context}`);
  if (entity.manual_notes) parts.push(`Manual notes: ${entity.manual_notes}`);
  if (entity.last_touch) parts.push(`Last touched: ${entity.last_touch}`);
  parts.push(`</entity>`);
  if (mentions.length) {
    parts.push(`\n<mentions count=${mentions.length}>`);
    for (const m of mentions) {
      parts.push(`[${m.source} ${m.occurred_at.slice(0, 10)}] ${m.context.slice(0, 300)}`);
    }
    parts.push(`</mentions>`);
  }
  if (emails.length) {
    parts.push(`\n<emails count=${emails.length}>`);
    for (const e of emails) {
      parts.push(
        `[${e.received_at.slice(0, 10)} from=${e.from_email}] ${e.subject} — ${(e.preview ?? '').slice(0, 200)}`,
      );
    }
    parts.push(`</emails>`);
  }
  return parts.join('\n');
}

const SYNTHESIS_SYSTEM_PROMPT = `You are KOS Dossier Synthesiser. Given a corpus of raw signal about one entity in Kevin's world (mention_events from voice memos, granola transcripts, and emails), produce a concise 3-5 sentence prose block titled "What you need to know."

# Style
- Match the dominant language of the corpus (Swedish if Swedish dominates, English otherwise).
- Prose, not bullet points.
- State-of-the-relationship-first: who they are relative to Kevin, what the current status is, what's the next open thread.
- Include a specific detail from a recent mention when it grounds the summary (e.g. "offered 6 months volunteer on 2026-04-20").
- Do NOT repeat the entity's name in every sentence.
- Do NOT speculate beyond the corpus. If the corpus is thin, say so in one sentence.
- Max ~600 characters total.

# Hard rules
- Output prose only. No headings, no bullets, no markdown.
- Do not include meta-commentary ("based on the corpus...").
- Do not quote the corpus tags verbatim.
- If the corpus is empty (no mentions, no emails), say "Not enough signal yet — only an index-level entry exists." and stop.`;

export async function synthesizeDossierHandler(
  ctx: Ctx,
): Promise<RouteResponse> {
  const id = ctx.params['id'];
  if (!id || !UUID_RE.test(id)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'invalid_entity_id' }),
    };
  }
  const entity = await loadEntity(id);
  if (!entity) {
    return { statusCode: 404, body: JSON.stringify({ error: 'entity_not_found' }) };
  }

  // Check cache unless ?force=1 is set
  const force = (ctx.query?.['force'] ?? '') === '1';
  if (!force) {
    const cached = await readCachedSynthesis(id);
    if (cached) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          synthesis: cached.body,
          cached_at: cached.cached_at,
          from_cache: true,
        }),
        headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=60' },
      };
    }
  }

  const [mentions, emails] = await Promise.all([
    loadMentions(id),
    loadRelatedEmails(entity.name),
  ]);

  if (mentions.length === 0 && emails.length === 0 && !entity.seed_context) {
    const synthesis = 'Not enough signal yet — only an index-level entry exists.';
    const cached_at = await writeCachedSynthesis(id, synthesis, {
      mentions: 0,
      emails: 0,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ synthesis, cached_at, from_cache: false }),
      headers: { 'cache-control': 'no-store' },
    };
  }

  const corpus = formatCorpus(entity, mentions, emails);

  let synthesis = '';
  try {
    const res = await getBedrock().messages.create({
      model: SONNET_4_6_MODEL_ID,
      max_tokens: 600,
      system: SYNTHESIS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Synthesize "What you need to know" for this entity:\n\n${corpus}`,
        },
      ],
    });
    for (const block of res.content) {
      if (block.type === 'text') synthesis += block.text;
    }
  } catch (err) {
    console.error('[dashboard-api:synthesize] bedrock failed', err);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: 'model_unavailable',
        detail: String((err as Error).message).slice(0, 200),
      }),
    };
  }
  synthesis = synthesis.trim().slice(0, 2000);
  if (!synthesis) {
    synthesis = 'Synthesis returned empty — retry shortly.';
  }

  const cached_at = await writeCachedSynthesis(id, synthesis, {
    mentions: mentions.length,
    emails: emails.length,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ synthesis, cached_at, from_cache: false }),
    headers: { 'cache-control': 'no-store' },
  };
}

register('POST', '/entities/:id/synthesize', synthesizeDossierHandler);
// GET is accepted too so a dashboard can lazy-load on entity-page open
// without needing to POST (idempotent — respects the cache).
register('GET', '/entities/:id/synthesize', synthesizeDossierHandler);
