/**
 * transcript-extractor Notion module — read the transcript page body +
 * write action items into Kevin's Command Center.
 *
 * Read side: walks block children of a Granola Transkripten page and
 * concatenates plain text from paragraph / heading / list / toggle / quote /
 * callout blocks. Mirrors services/granola-poller/src/notion.ts shape.
 *
 * Write side: implements D-07 — Kevin's Swedish Command Center schema
 * (Uppgift / Typ / Prioritet / Anteckningar / Status), prefixing the
 * Anteckningar with `[Granola: <transcript title>]` for provenance. Property
 * shapes mirror services/voice-capture/src/notion.ts exactly so dashboard
 * filters / sorting work the same regardless of which agent wrote the row.
 */
import type { Client as NotionClient } from '@notionhq/client';
import type {
  TranscriptAvailable,
  TranscriptExtraction,
} from '@kos/contracts/context';

// ---------------------------------------------------------------------------
// Read side — transcript body extraction
// ---------------------------------------------------------------------------

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
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
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
  return candidate
    .map((t) => t.plain_text ?? '')
    .join('')
    .trim();
}

// ---------------------------------------------------------------------------
// Write side — Command Center row creation (Kevin's Swedish schema)
// ---------------------------------------------------------------------------

// Map LLM 'high'/'medium'/'low' priority → Kevin's emoji-prefixed Prioritet
// values. Same select-option names voice-capture/src/notion.ts uses, so the
// dashboard sees a single source-agnostic vocabulary.
const PRIORITET_MAP: Record<TranscriptExtraction['action_items'][number]['priority'], string> = {
  high: '🔴 Hög',
  medium: '🟡 Medel',
  low: '🟢 Låg',
};

// Granola action items are Tasks by definition (Kevin agreed to follow up).
// voice-capture maps {task,note,meeting,question}→'Task'/'Notering';
// transcript-extractor always emits 'Task' so dashboard groups Granola
// follow-ups together cleanly.
const TYP_FOR_GRANOLA = 'Task';

export interface WriteActionItemsInput {
  notion: NotionClient;
  commandCenterDbId: string;
  detail: TranscriptAvailable;
  /** Notion page URL for the source transcript (used in Anteckningar). */
  transcriptNotionUrl: string;
  items: TranscriptExtraction['action_items'];
}

export async function writeActionItemsToCommandCenter(
  input: WriteActionItemsInput,
): Promise<string[]> {
  const { notion, commandCenterDbId, detail, transcriptNotionUrl, items } = input;
  const created: string[] = [];
  const titleForProvenance = (detail.title ?? '').trim() || 'untitled';

  for (const item of items) {
    const noteSegments: string[] = [
      `[Granola: ${titleForProvenance}] ${item.title}`,
      ``,
      `Källa-utdrag: "${item.source_excerpt.slice(0, 400)}"`,
    ];
    if (item.due_hint) noteSegments.push(`Deadline-hint: ${item.due_hint}`);
    noteSegments.push(`Source: ${transcriptNotionUrl}`);
    noteSegments.push(`capture_id: ${detail.capture_id}`);
    const anteckningar = noteSegments.join('\n').slice(0, 2000);

    const page = await notion.pages.create({
      parent: { database_id: commandCenterDbId },
      properties: {
        Uppgift: {
          title: [{ type: 'text', text: { content: item.title.slice(0, 200) } }],
        },
        Typ: { select: { name: TYP_FOR_GRANOLA } },
        Prioritet: {
          select: { name: PRIORITET_MAP[item.priority] ?? PRIORITET_MAP.medium },
        },
        Status: { select: { name: '📥 Inbox' } },
        Anteckningar: {
          rich_text: [{ type: 'text', text: { content: anteckningar } }],
        },
      },
    });
    created.push(page.id);
  }
  return created;
}
