/**
 * Granola path = Notion **Transkripten** DB reader (Resolved Open Question 1).
 *
 * Per Plan 02 RESEARCH §"Open Question 1 RESOLVED": Granola has no stable
 * REST API; Kevin's Granola → Notion sync is the canonical source. We bulk-
 * read the Transkripten DB instead of calling Granola.
 *
 * Three responsibilities:
 *   1. discoverTranskriptenDbId — first-run resolution via `notion.search`,
 *      throws actionable error on 0 / >1 hits with override instructions.
 *   2. readTranskripten — async-generator cursor-paginated reader filtered
 *      by `last_edited_time on_or_after now-90d`. Yields `{id, title, bodyText}`
 *      one row at a time so the handler can dedup + write incrementally.
 *   3. Tolerates property-shape drift: tries Transcript / Body rich_text first,
 *      falls back to fetching first 100 block-children of the page (Granola
 *      sync may put the transcript in body blocks rather than a property).
 */

import type { Client } from '@notionhq/client';

export interface TranskriptenRow {
  id: string;
  title: string;
  bodyText: string;
}

export async function discoverTranskriptenDbId(notion: Client): Promise<string> {
  const res = await notion.search({
    query: 'Transkripten',
    filter: { property: 'object', value: 'database' },
    page_size: 25,
  });
  const dbs = ((res.results ?? []) as any[]).filter(
    (r) => r?.object === 'database',
  );
  // Exact-title narrowing (case-insensitive) — guards against partial matches.
  const exact = dbs.filter((d: any) => {
    const titleArr: Array<{ plain_text?: string }> = Array.isArray(d.title)
      ? d.title
      : [];
    const title = titleArr
      .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
      .join('')
      .trim()
      .toLowerCase();
    return title === 'transkripten';
  });
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length === 0) {
    throw new Error(
      'discoverTranskriptenDbId: no database titled exactly "Transkripten" found. ' +
        'Set TRANSKRIPTEN_DB_ID in Lambda env explicitly via ' +
        '`aws lambda update-function-configuration --function-name KosAgents-BulkImportGranolaGmail --environment Variables={TRANSKRIPTEN_DB_ID=<uuid>}` ' +
        'or persist it to scripts/.notion-db-ids.json under key "transkripten".',
    );
  }
  // exact.length > 1
  throw new Error(
    `discoverTranskriptenDbId: ${exact.length} databases titled "Transkripten" found (ambiguous). ` +
      'Set TRANSKRIPTEN_DB_ID in Lambda env explicitly to the correct UUID. ' +
      `Candidates: ${exact.map((d: any) => d.id).join(', ')}`,
  );
}

/**
 * Yield Transkripten rows last-edited within the last `daysBack` days.
 *
 * Body-text resolution tries (in order):
 *   1. `Transcript` rich_text property (.rich_text[].plain_text concatenated)
 *   2. `Body` rich_text property (alternate label)
 *   3. First 100 block children of the page (paragraph blocks have a
 *      .paragraph.rich_text[].plain_text we extract; falls back to
 *      JSON.stringify on unknown block types so name regex still has
 *      something to chew on).
 */
export async function* readTranskripten(
  notion: Client,
  dbId: string,
  daysBack = 90,
): AsyncGenerator<TranskriptenRow> {
  const cutoffIso = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const cutoffDate = cutoffIso.slice(0, 10);

  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: dbId,
      // The Notion SDK's typed query wants a property timestamp; we use the
      // `last_edited_time` system filter (typed as `timestamp` filter, not
      // `property`). Cast through `as never` to bypass the strict shape.
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: cutoffDate },
      } as never,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const row of (res.results ?? []) as any[]) {
      const props = row?.properties ?? {};
      const title = extractTitle(props) ?? '(untitled)';

      let bodyText = readRichText(props['Transcript']) || readRichText(props['Body']);

      if (!bodyText) {
        // Fall back to block-children fetch.
        try {
          const children: any = await notion.blocks.children.list({
            block_id: row.id,
            page_size: 100,
          });
          bodyText = (children.results ?? [])
            .map((b: any) => extractBlockText(b))
            .filter(Boolean)
            .join('\n')
            .slice(0, 50_000);
        } catch (err) {
          console.warn(
            `[bulk-granola] block-children fetch failed for page ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          bodyText = '';
        }
      }

      yield { id: String(row.id), title, bodyText };
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
}

function extractTitle(props: Record<string, any>): string | null {
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === 'title' && Array.isArray(p.title)) {
      const txt = p.title
        .map((t: any) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
        .join('')
        .trim();
      if (txt) return txt;
    }
  }
  return null;
}

function readRichText(prop: any): string {
  if (!prop) return '';
  if (prop.type === 'rich_text' && Array.isArray(prop.rich_text)) {
    return prop.rich_text
      .map((t: any) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
      .join('')
      .trim();
  }
  return '';
}

function extractBlockText(block: any): string {
  if (!block || typeof block !== 'object') return '';
  const t = block.type;
  if (!t) return '';
  const inner = block[t];
  if (inner && Array.isArray(inner.rich_text)) {
    return inner.rich_text
      .map((r: any) => (typeof r?.plain_text === 'string' ? r.plain_text : ''))
      .join('');
  }
  // Unknown block — JSON-stringify so 2-word capitalised regex can still
  // chew on participant lists, etc.
  return JSON.stringify(block).slice(0, 2000);
}
