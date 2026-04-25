/**
 * Notion Transkripten DB query + page-content helpers (Plan 06-01 D-01..D-04).
 *
 * Reuses the discovery + reading pattern proven in
 * services/bulk-import-granola-gmail/src/granola.ts. Implementation kept local
 * (no cross-service runtime dep) — Granola was specifically excluded from
 * being a shared package per the Plan 06-00 _shared layout decision.
 *
 * Three responsibilities:
 *   1. `getTranskriptenDbId`        — operator-friendly resolution chain
 *      (env → scripts/.notion-db-ids.json → actionable error).
 *   2. `queryTranskriptenSince`     — async-iterable cursor-paginated query
 *      with `last_edited_time` filter (D-08 pattern).
 *   3. `readPageContent`            — title + recorded_at + attendees + body
 *      block walk; truncates to 64 000 chars per RESEARCH §6.
 */
import type { Client } from '@notionhq/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RAW_LENGTH_CAP = 64_000; // D-04 cap on transcript_text

export interface TranskriptenPage {
  id: string;
  last_edited_time: string;
  // Original Notion shape preserved through the iterator so callers can
  // optionally read additional properties without a second fetch.
  raw: unknown;
}

export interface PageContent {
  title: string;
  transcript_text: string;
  recorded_at: Date;
  attendees: string[];
  notion_url: string;
  raw_length: number;
}

/**
 * Resolve the Notion Transkripten DB id at runtime.
 *
 * Resolution order (operator-runbook compatible):
 *   1. NOTION_TRANSKRIPTEN_DB_ID env var (Lambda runtime override).
 *   2. scripts/.notion-db-ids.json `transkripten` key (committed bootstrap).
 *
 * Throws an actionable error pointing at the discovery runbook if neither
 * resolves. Empty string and the literal sentinel `PLACEHOLDER_TRANSKRIPTEN_DB_ID`
 * are treated as "not set".
 */
export async function getTranskriptenDbId(): Promise<string> {
  const fromEnv = process.env.NOTION_TRANSKRIPTEN_DB_ID;
  if (fromEnv && fromEnv !== '' && fromEnv !== 'PLACEHOLDER_TRANSKRIPTEN_DB_ID') {
    return fromEnv;
  }
  // Look up scripts/.notion-db-ids.json relative to repo root. We resolve via
  // process.cwd() walking up — Lambdas bundle the JSON via the discover script
  // commit; locally the file is at scripts/.notion-db-ids.json.
  const candidatePaths = [
    path.resolve(process.cwd(), 'scripts/.notion-db-ids.json'),
    path.resolve(process.cwd(), '../../scripts/.notion-db-ids.json'),
    path.resolve(process.cwd(), '../../../scripts/.notion-db-ids.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
        const id = parsed.transkripten ?? parsed.Transkripten;
        if (id && id !== 'PLACEHOLDER_TRANSKRIPTEN_DB_ID') return id;
      } catch {
        // fall through to next candidate
      }
    }
  }
  throw new Error(
    'getTranskriptenDbId: Transkripten DB id not configured. ' +
      'Run `node scripts/discover-notion-dbs.mjs --db transkripten` ' +
      'to populate scripts/.notion-db-ids.json, or set NOTION_TRANSKRIPTEN_DB_ID env var.',
  );
}

/**
 * Cursor-paginated `last_edited_time > since` query against the Transkripten DB.
 *
 * Sorts ascending so callers can advance the cursor by tracking
 * `max(last_edited_time)` over the batch. Page size 100 (Notion API max).
 */
export async function* queryTranskriptenSince(
  notion: Client,
  dbId: string,
  since: Date,
): AsyncIterable<TranskriptenPage> {
  let cursor: string | undefined;
  do {
    // The Notion typed query insists on a property timestamp; cast through
    // `as never` for the system `last_edited_time` filter (same workaround
    // used by services/bulk-import-granola-gmail/src/granola.ts).
    const res = (await notion.databases.query({
      database_id: dbId,
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { after: since.toISOString() },
      } as never,
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 100,
      start_cursor: cursor,
    })) as {
      results: Array<{ id: string; last_edited_time?: string }>;
      has_more: boolean;
      next_cursor?: string | null;
    };
    for (const row of res.results ?? []) {
      if (!('last_edited_time' in row) || !row.last_edited_time) continue;
      yield { id: row.id, last_edited_time: row.last_edited_time, raw: row };
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
}

/**
 * Read a Notion page's title + body. Walks block children once (paragraph +
 * heading_1/2/3 + bulleted/numbered list_item) and concatenates plain_text;
 * falls back to the page-level Transcript / Body rich_text properties if the
 * body lives on the page row instead of its children. Truncates to 64 000
 * chars per D-04.
 *
 * `recorded_at` resolution: tries `Created` / `Date` rich_text-or-date
 * properties first, falls back to the page's `created_time` system field.
 */
export async function readPageContent(notion: Client, pageId: string): Promise<PageContent> {
  // 1. Read page properties (including title + created_time).
  const page = (await notion.pages.retrieve({ page_id: pageId })) as {
    properties: Record<string, unknown>;
    created_time: string;
    url: string;
  };
  const title = extractTitle(page.properties) ?? '(untitled)';
  const recorded_at = extractRecordedAt(page.properties) ?? new Date(page.created_time);
  const attendees = extractAttendees(page.properties);

  // 2. Try to read body from rich_text properties first.
  let bodyText =
    readRichText(page.properties['Transcript']) ||
    readRichText(page.properties['Body']);

  // 3. Fallback: walk first 100 block children (paragraph/heading/list).
  if (!bodyText) {
    let cursor: string | undefined;
    const parts: string[] = [];
    let total = 0;
    do {
      const res = (await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      })) as {
        results: unknown[];
        has_more: boolean;
        next_cursor?: string | null;
      };
      for (const b of res.results ?? []) {
        const txt = extractBlockText(b);
        if (!txt) continue;
        parts.push(txt);
        total += txt.length + 1;
        if (total >= RAW_LENGTH_CAP) break;
      }
      cursor = total < RAW_LENGTH_CAP && res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    bodyText = parts.join('\n');
  }

  if (bodyText.length > RAW_LENGTH_CAP) {
    bodyText = bodyText.slice(0, RAW_LENGTH_CAP);
  }

  return {
    title,
    transcript_text: bodyText,
    recorded_at,
    attendees,
    notion_url: page.url,
    raw_length: bodyText.length,
  };
}

// ---------------------------------------------------------------------------
// Property extractors — best-effort, schema-tolerant.
// ---------------------------------------------------------------------------

function extractTitle(props: Record<string, unknown>): string | null {
  for (const val of Object.values(props)) {
    const v = val as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v?.type === 'title' && Array.isArray(v.title)) {
      const txt = v.title
        .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
        .join('')
        .trim();
      if (txt) return txt;
    }
  }
  return null;
}

function extractRecordedAt(props: Record<string, unknown>): Date | null {
  // Try common Granola/Notion date property names; fall back to null.
  const keys = ['Created', 'Date', 'Recorded', 'Recorded At', 'Datum'];
  for (const k of keys) {
    const v = props[k] as { type?: string; date?: { start?: string }; created_time?: string } | undefined;
    if (!v) continue;
    if (v.type === 'date' && v.date?.start) return new Date(v.date.start);
    if (v.type === 'created_time' && v.created_time) return new Date(v.created_time);
  }
  return null;
}

function extractAttendees(props: Record<string, unknown>): string[] {
  // Multi-select labelled "Attendees" / "Deltagare" / "Participants".
  const keys = ['Attendees', 'Deltagare', 'Participants'];
  for (const k of keys) {
    const v = props[k] as { type?: string; multi_select?: Array<{ name?: string }> } | undefined;
    if (v?.type === 'multi_select' && Array.isArray(v.multi_select)) {
      return v.multi_select
        .map((m) => (typeof m?.name === 'string' ? m.name : ''))
        .filter((s) => s.length > 0);
    }
  }
  return [];
}

function readRichText(prop: unknown): string {
  const p = prop as { type?: string; rich_text?: Array<{ plain_text?: string }> };
  if (p?.type === 'rich_text' && Array.isArray(p.rich_text)) {
    return p.rich_text
      .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
      .join('')
      .trim();
  }
  return '';
}

function extractBlockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as { type?: string } & Record<string, unknown>;
  const t = b.type;
  if (!t) return '';
  // Most plain-text-bearing block types share the `<type>.rich_text[]` shape.
  if (
    t === 'paragraph' ||
    t === 'heading_1' ||
    t === 'heading_2' ||
    t === 'heading_3' ||
    t === 'bulleted_list_item' ||
    t === 'numbered_list_item' ||
    t === 'quote' ||
    t === 'callout' ||
    t === 'toggle'
  ) {
    const inner = b[t] as { rich_text?: Array<{ plain_text?: string }> };
    if (inner?.rich_text && Array.isArray(inner.rich_text)) {
      return inner.rich_text
        .map((r) => (typeof r?.plain_text === 'string' ? r.plain_text : ''))
        .join('');
    }
  }
  return '';
}
