/**
 * Merged Inbox route handler.
 *
 * GET /inbox-merged — returns the union of:
 *   - email_drafts (ALL statuses since Phase 11 D-05; was previously
 *     'draft'/'edited' only). Mapped to `kind: 'draft_reply'` with the
 *     new `classification` + `email_status` fields populated for the
 *     Pill renderer.
 *   - agent_dead_letter rows where retried_at IS NULL (Phase 4 D-24;
 *     mapped to `kind: 'dead_letter'`).
 *   - inbox_index rows where status='pending' (Phase 3 entity routings;
 *     mapped to `kind: 'entity_routing' | 'new_entity' | 'merge_resume'`).
 *     Phase 11 D-05 closed the doc-vs-code gap — the original handler
 *     promised this UNION but the implementation only queried the first
 *     two sources.
 *
 * Mounted as a new path (`/inbox-merged` rather than overwriting
 * `/inbox`) so the existing Phase 3 inbox handler + tests stay green.
 * Dashboard switches its merged-inbox client to this path; the legacy
 * /inbox stays available for any integration that hasn't migrated.
 *
 * Response is shaped to InboxListSchema from `@kos/contracts/dashboard`
 * — a single discriminated union over kind. The dashboard parses with
 * the same schema; old vs new clients differ only in whether they
 * read the optional `classification` + `email_status` fields.
 */
import { eq, sql } from 'drizzle-orm';
import { getNotion } from '../notion.js';
import {
  InboxListSchema,
  type InboxItem,
  type EmailClassification,
  type EmailDraftStatus,
  type InboxItemKind,
} from '@kos/contracts/dashboard';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';
import {
  listInboxDrafts,
  listInboxDeadLetters,
} from '../email-drafts-persist.js';

const KNOWN_CLASSIFICATIONS = new Set<EmailClassification>([
  'urgent',
  'important',
  'informational',
  'junk',
]);

const KNOWN_EMAIL_STATUSES = new Set<EmailDraftStatus>([
  'pending_triage',
  'draft',
  'edited',
  'approved',
  'skipped',
  'sent',
  'failed',
]);

const KNOWN_INDEX_KINDS = new Set<InboxItemKind>([
  'draft_reply',
  'entity_routing',
  'new_entity',
  'merge_resume',
]);

function toClassification(raw: string): EmailClassification | null {
  return KNOWN_CLASSIFICATIONS.has(raw as EmailClassification)
    ? (raw as EmailClassification)
    : null;
}

function toEmailStatus(raw: string): EmailDraftStatus | null {
  return KNOWN_EMAIL_STATUSES.has(raw as EmailDraftStatus)
    ? (raw as EmailDraftStatus)
    : null;
}

function toIndexKind(
  raw: string,
): 'entity_routing' | 'new_entity' | 'merge_resume' {
  // Defensive — inbox_index.kind is free-form text. Restrict to the
  // 3 non-email kinds; unknown values fall back to entity_routing
  // (contract-safe default mirrored from handlers/inbox.ts:toInboxKind).
  if (
    raw === 'entity_routing' ||
    raw === 'new_entity' ||
    raw === 'merge_resume'
  ) {
    return raw;
  }
  // 'draft_reply' rows in inbox_index are demo seeds — surface as
  // entity_routing so the renderer doesn't show approve/skip controls
  // tied to a non-existent email_drafts row.
  return 'entity_routing';
}

function toBolag(
  raw: unknown,
): 'tale-forge' | 'outbehaving' | 'personal' | null {
  if (raw === 'tale-forge' || raw === 'outbehaving' || raw === 'personal')
    return raw;
  return null;
}

interface InboxIndexRow {
  id: string;
  kind: string;
  title: string | null;
  preview: string | null;
  bolag: string | null;
  status: string;
  entity_id: string | null;
  merge_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

async function loadInboxIndexPending(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<InboxIndexRow[]> {
  const r = (await db.execute(sql`
    SELECT
      id::text          AS id,
      kind              AS kind,
      title             AS title,
      preview           AS preview,
      bolag             AS bolag,
      status            AS status,
      entity_id::text   AS entity_id,
      merge_id          AS merge_id,
      payload           AS payload,
      created_at::text  AS created_at
    FROM inbox_index
    WHERE owner_id = ${OWNER_ID}
      AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 100
  `)) as unknown as { rows: InboxIndexRow[] };
  return r.rows;
}

export async function mergedInboxHandler(_ctx: Ctx): Promise<RouteResponse> {
  const db = await getDb();
  let drafts;
  let deadLetters;
  let indexRows;
  try {
    [drafts, deadLetters, indexRows] = await Promise.all([
      listInboxDrafts(db, 100),
      listInboxDeadLetters(db, 50),
      loadInboxIndexPending(db),
    ]);
  } catch (err) {
    // Pre-Phase-4 deploy (tables not migrated) OR transient DB error →
    // degrade to [] rather than 500. The dashboard RSC then falls back
    // to /inbox per its existing try/catch chain.
    // eslint-disable-next-line no-console
    console.warn(
      '[dashboard-api] /inbox-merged degraded — table unavailable',
      err,
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ items: [] }),
      headers: {
        'cache-control': 'private, max-age=0, stale-while-revalidate=5',
      },
    };
  }

  // -- email_drafts → kind: 'draft_reply' with D-05 fields populated -----

  const draftItems: Array<InboxItem & { _sortAt: string }> = drafts.map(
    (d) => ({
      id: d.draft_id,
      kind: 'draft_reply' as const,
      title: d.draft_subject ?? d.subject ?? '(no subject)',
      preview: (d.body_plain ?? d.draft_body ?? '').slice(0, 200),
      bolag: null,
      entity_id: null,
      merge_id: null,
      from_email:      d.from_email ?? null,
      from_name:       null,  // column not in schema yet
      subject:         d.subject ?? null,
      original_body:   d.body_plain ?? null,
      draft_body_full: d.draft_body ?? null,
      payload: {
        capture_id: d.capture_id,
        from: d.from_email,
      },
      created_at: d.received_at,
      classification: toClassification(d.classification),
      email_status: toEmailStatus(d.status),
      _sortAt: d.received_at,
    }),
  );

  // -- agent_dead_letter → kind: 'dead_letter' ---------------------------

  const deadLetterItems: Array<InboxItem & { _sortAt: string }> =
    deadLetters.map((x) => ({
      id: x.id,
      kind: 'dead_letter' as const,
      title: `${x.tool_name} — ${x.error_class}`,
      preview: x.error_message.slice(0, 400),
      bolag: null,
      entity_id: null,
      merge_id: null,
      payload: { capture_id: x.capture_id },
      created_at: x.occurred_at,
      classification: null,
      email_status: null,
      _sortAt: x.occurred_at,
    }));

  // -- inbox_index → kind: 'entity_routing' / 'new_entity' / 'merge_resume'
  // Phase 11 D-05: this UNION was promised by the doc-comment but the
  // original handler omitted it; closing that gap here.

  const indexItems: Array<InboxItem & { _sortAt: string }> = indexRows.map(
    (r) => {
      const kind = toIndexKind(r.kind);
      // Only kinds known to the contract are emitted; unknown values
      // already coerced by toIndexKind above.
      void KNOWN_INDEX_KINDS;
      return {
        id: r.id,
        kind,
        title: r.title ?? '',
        preview: r.preview ?? '',
        bolag: toBolag(r.bolag),
        entity_id: r.entity_id ?? null,
        merge_id: r.merge_id ?? null,
        payload: r.payload ?? {},
        created_at: r.created_at,
        classification: null,
        email_status: null,
        _sortAt: r.created_at,
      };
    },
  );

  // Sort all three sources together by their respective time fields DESC.
  // ISO-8601 strings allow lexicographic compare without parsing.
  const merged = [...draftItems, ...deadLetterItems, ...indexItems].sort(
    (a, b) => {
      if (a._sortAt === b._sortAt) return 0;
      return a._sortAt > b._sortAt ? -1 : 1;
    },
  );

  // Strip the internal _sortAt key before zod-parse.
  const items: InboxItem[] = merged.map(({ _sortAt, ...rest }) => {
    void _sortAt;
    return rest;
  });

  // zod-at-exit: catches any drift before the response leaves the Lambda.
  const payload = InboxListSchema.parse({ items });

  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: {
      'cache-control': 'private, max-age=0, stale-while-revalidate=5',
    },
  };
}

register('GET', '/inbox-merged', mergedInboxHandler);

// ─────────────────────────────────────────────────────────────────────────────
// Priority actions — PATCH /priorities/:id/status
// Updates Notion Command Center task status directly.
// ─────────────────────────────────────────────────────────────────────────────

register('PATCH', '/priorities/:id/status', async (ctx: Ctx): Promise<RouteResponse> => {
  const pageId = ctx.params?.id;
  const body = ctx.body ? (JSON.parse(ctx.body) as { status: string }) : null;
  if (!pageId || !body?.status) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing id or status' }) };
  }

  const STATUS_MAP: Record<string, string> = {
    done: '✅ Klart',
    skip: '❌ Skippat',
    defer: '⏳ Väntar',
    today: '🔥 Idag',
    active: '🔨 Pågår',
  };

  const notionStatus = STATUS_MAP[body.status.toLowerCase()];
  if (!notionStatus) {
    return { statusCode: 400, body: JSON.stringify({ error: `Unknown status '${body.status}'` }) };
  }

  try {
    const notion = getNotion();
    await notion.pages.update({
      page_id: pageId,
      properties: {
        Status: { select: { name: notionStatus } },
      },
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, id: pageId, status: notionStatus }) };
  } catch (err) {
    console.error('[dashboard-api] priority status update failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'notion_update_failed', detail: String(err) }) };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// "Ask Zinclaw" — POST /delegate
// Sends a Discord DM to Kevin with item context, opening a conversation with Zinclaw.
// ─────────────────────────────────────────────────────────────────────────────

register('POST', '/delegate', async (ctx: Ctx): Promise<RouteResponse> => {
  const body = ctx.body ? JSON.parse(ctx.body) as {
    kind: string;       // 'priority' | 'draft' | 'inbox_item' | 'capture'
    id: string;
    title: string;
    context?: string;   // extra text to include
  } : null;

  if (!body?.kind || !body?.title) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing kind or title' }) };
  }

  const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  const DISCORD_USER_ID = process.env.DISCORD_OWNER_USER_ID ?? '165422223669067780';

  if (!DISCORD_BOT_TOKEN) {
    return { statusCode: 503, body: JSON.stringify({ error: 'discord_not_configured' }) };
  }

  // Build a rich message with context
  const kindLabel: Record<string, string> = {
    priority: '🎯 Priority',
    draft: '📧 Email Draft',
    inbox_item: '📬 Inbox Item',
    capture: '📝 Capture',
  };
  const label = kindLabel[body.kind] ?? body.kind;

  const message = [
    `**${label}** delegated from dashboard:`,
    `> **${body.title}**`,
    body.context ? `> ${body.context.slice(0, 400)}` : '',
    ``,
    `What would you like me to do with this? I have full context and can update status, draft a reply, research it, or take any action.`,
  ].filter(Boolean).join('\n');

  try {
    // Create DM channel with Kevin
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: DISCORD_USER_ID }),
    });
    const dmChannel = await dmRes.json() as { id: string };

    // Send the message
    await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message }),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, channel_id: dmChannel.id }) };
  } catch (err) {
    console.error('[dashboard-api] delegate discord DM failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'discord_send_failed' }) };
  }
});
