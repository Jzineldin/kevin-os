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

// WR-07: mirror granola-poller's 64 000-char cap so pathologically large
// Granola pages (Kevin's longer planning meetings) cannot exhaust the
// 1 GB Lambda heap. Sonnet's 200k-token input cap already clips useful
// payload downstream, so keeping the whole block tree in memory before
// slicing wastes both heap and runtime.
const RAW_LENGTH_CAP = 64_000;

export async function readTranscriptBody(
  notion: NotionClient,
  pageId: string,
): Promise<string> {
  // Recursive walk: Granola's `transcription` block has children blocks
  // that hold the actual transcript text. The current implementation flat-
  // listed top-level page children only and missed every transcript line.
  const parts: string[] = [];
  let total = 0;
  await walkBlocks(notion, pageId, 0, parts, () => total, (n) => { total = n; });
  const out = parts.join('\n').trim();
  return out.length > RAW_LENGTH_CAP ? out.slice(0, RAW_LENGTH_CAP) : out;
}

/**
 * Walk a block subtree, depth-first, accumulating plain text from every
 * supported block type. Bounded by `RAW_LENGTH_CAP` so a pathological page
 * cannot exhaust heap. Bounded by depth=4 so we don't recurse infinitely
 * on cyclic refs (Notion does not produce them in practice but cheap guard).
 */
async function walkBlocks(
  notion: NotionClient,
  blockId: string,
  depth: number,
  parts: string[],
  getTotal: () => number,
  setTotal: (n: number) => void,
): Promise<void> {
  if (depth > 4) return;
  let cursor: string | undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results) {
      const block = b as { type?: string; has_children?: boolean; id?: string };
      const text = extractBlockText(b);
      if (text) {
        parts.push(text);
        setTotal(getTotal() + text.length + 1);
        if (getTotal() >= RAW_LENGTH_CAP) return;
      }
      if (block.has_children && block.id && getTotal() < RAW_LENGTH_CAP) {
        await walkBlocks(notion, block.id, depth + 1, parts, getTotal, setTotal);
      }
    }
    cursor =
      getTotal() < RAW_LENGTH_CAP && res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
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
    // Granola-injected block: holds the meeting title in `title` and the
    // transcript lines as child blocks (recursed via walkBlocks).
    transcription?: { title?: Array<{ plain_text?: string }> };
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
    b.callout?.rich_text ??
    b.transcription?.title;
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
