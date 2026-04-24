/**
 * Notion transcript body reader — walks block children of a Granola
 * Transkripten page and concatenates all paragraph / heading / bullet /
 * toggle text into plain-text for Bedrock input.
 */
import type { Client as NotionClient } from '@notionhq/client';

export async function readTranscriptBody(
  notion: NotionClient,
  pageId: string,
): Promise<string> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results) {
      const text = extractBlockText(b);
      if (text) parts.push(text);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  return parts.join('\n').trim();
}

function extractBlockText(block: unknown): string | null {
  const b = block as {
    type?: string;
    paragraph?: { rich_text?: Array<{ plain_text?: string }> };
    heading_1?: { rich_text?: Array<{ plain_text?: string }> };
    heading_2?: { rich_text?: Array<{ plain_text?: string }> };
    heading_3?: { rich_text?: Array<{ plain_text?: string }> };
    bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
    numbered_list_item?: { rich_text?: Array<{ plain_text?: string }> };
    toggle?: { rich_text?: Array<{ plain_text?: string }> };
    quote?: { rich_text?: Array<{ plain_text?: string }> };
    callout?: { rich_text?: Array<{ plain_text?: string }> };
  };
  const candidate =
    b.paragraph?.rich_text ??
    b.heading_1?.rich_text ??
    b.heading_2?.rich_text ??
    b.heading_3?.rich_text ??
    b.bulleted_list_item?.rich_text ??
    b.numbered_list_item?.rich_text ??
    b.toggle?.rich_text ??
    b.quote?.rich_text ??
    b.callout?.rich_text;
  if (!candidate || candidate.length === 0) return null;
  return candidate.map((t) => t.plain_text ?? '').join('').trim();
}
