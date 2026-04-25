/**
 * notion.test.ts — Command Center writer + transcript reader unit tests
 * (Plan 06-02 Task 1).
 *
 * Coverage:
 *   1. writeActionItemsToCommandCenter creates pages with EXACT Swedish
 *      property shape (Uppgift / Typ / Prioritet / Anteckningar / Status).
 *   2. Anteckningar is prefixed with [Granola: <title>] (provenance — D-07).
 *   3. Empty items list → no notion calls, returns empty array.
 *   4. Prioritet maps high/medium/low → emoji-prefixed Swedish labels.
 *   5. readTranscriptBody concatenates paragraph + heading_1 + bulleted_list_item
 *      and ignores unknown block types.
 *   6. readTranscriptBody paginates across has_more=true → false.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  writeActionItemsToCommandCenter,
  readTranscriptBody,
} from '../src/notion.js';
import type { TranscriptAvailable, TranscriptExtraction } from '@kos/contracts/context';

const baseDetail: TranscriptAvailable = {
  capture_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
  owner_id: '00000000-0000-0000-0000-000000000001',
  transcript_id: 'page-uuid-1',
  notion_page_id: 'page-uuid-1',
  title: 'Almi follow-up',
  source: 'granola',
  last_edited_time: '2026-04-22T10:00:00.000Z',
  raw_length: 12_000,
};

function makeNotion() {
  const create = vi.fn(async (args: unknown) => ({ id: 'notion-page-' + Math.random().toString(36).slice(2) }));
  return {
    notion: {
      pages: { create },
      blocks: { children: { list: vi.fn() } },
    } as unknown as Parameters<typeof writeActionItemsToCommandCenter>[0]['notion'],
    create,
  };
}

describe('writeActionItemsToCommandCenter', () => {
  it('creates pages with exact Swedish property shape', async () => {
    const { notion, create } = makeNotion();
    const items: TranscriptExtraction['action_items'] = [
      {
        title: 'Ping Damien om konvertibellånet',
        priority: 'high',
        due_hint: 'innan fredag',
        linked_entity_ids: [],
        source_excerpt: 'Kevin sa att han skulle pinga Damien.',
      },
    ];

    const created = await writeActionItemsToCommandCenter({
      notion,
      commandCenterDbId: 'cc-db-id',
      detail: baseDetail,
      transcriptNotionUrl: 'https://notion.so/page-uuid-1',
      items,
    });

    expect(created).toHaveLength(1);
    const callArgs = create.mock.calls[0]![0] as {
      parent: { database_id: string };
      properties: Record<string, unknown>;
    };
    expect(callArgs.parent.database_id).toBe('cc-db-id');
    expect(callArgs.properties).toHaveProperty('Uppgift');
    expect(callArgs.properties).toHaveProperty('Typ');
    expect(callArgs.properties).toHaveProperty('Prioritet');
    expect(callArgs.properties).toHaveProperty('Anteckningar');
    expect(callArgs.properties).toHaveProperty('Status');
    const props = callArgs.properties as {
      Uppgift: { title: Array<{ text: { content: string } }> };
      Typ: { select: { name: string } };
      Prioritet: { select: { name: string } };
      Anteckningar: { rich_text: Array<{ text: { content: string } }> };
      Status: { select: { name: string } };
    };
    expect(props.Uppgift.title[0]!.text.content).toBe('Ping Damien om konvertibellånet');
    expect(props.Typ.select.name).toBe('Task');
    expect(props.Status.select.name).toBe('📥 Inbox');
  });

  it('Anteckningar is prefixed with [Granola: <title>] for provenance', async () => {
    const { notion, create } = makeNotion();
    await writeActionItemsToCommandCenter({
      notion,
      commandCenterDbId: 'cc-db-id',
      detail: baseDetail,
      transcriptNotionUrl: 'https://notion.so/page-uuid-1',
      items: [
        {
          title: 'Send recap email',
          priority: 'medium',
          due_hint: null,
          linked_entity_ids: [],
          source_excerpt: 'Action: send recap.',
        },
      ],
    });
    const callArgs = create.mock.calls[0]![0] as {
      properties: { Anteckningar: { rich_text: Array<{ text: { content: string } }> } };
    };
    const note = callArgs.properties.Anteckningar.rich_text[0]!.text.content;
    expect(note).toMatch(/^\[Granola: Almi follow-up\]/);
    expect(note).toContain('Source: https://notion.so/page-uuid-1');
    expect(note).toContain('capture_id: 01HABCDEFGHJKMNPQRSTVWXYZ0');
  });

  it('empty items list returns empty array and makes no notion calls', async () => {
    const { notion, create } = makeNotion();
    const result = await writeActionItemsToCommandCenter({
      notion,
      commandCenterDbId: 'cc-db-id',
      detail: baseDetail,
      transcriptNotionUrl: 'https://notion.so/page-uuid-1',
      items: [],
    });
    expect(result).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('Prioritet maps {high,medium,low} → emoji-prefixed Swedish labels', async () => {
    const cases: Array<['high' | 'medium' | 'low', string]> = [
      ['high', '🔴 Hög'],
      ['medium', '🟡 Medel'],
      ['low', '🟢 Låg'],
    ];
    for (const [priority, expected] of cases) {
      const { notion, create } = makeNotion();
      await writeActionItemsToCommandCenter({
        notion,
        commandCenterDbId: 'cc-db-id',
        detail: baseDetail,
        transcriptNotionUrl: 'https://notion.so/page-uuid-1',
        items: [
          {
            title: 't',
            priority,
            due_hint: null,
            linked_entity_ids: [],
            source_excerpt: 's',
          },
        ],
      });
      const callArgs = create.mock.calls[0]![0] as {
        properties: { Prioritet: { select: { name: string } } };
      };
      expect(callArgs.properties.Prioritet.select.name).toBe(expected);
    }
  });
});

describe('readTranscriptBody', () => {
  it('concatenates paragraph + heading_1 + bulleted_list_item, ignores unknown blocks', async () => {
    const list = vi.fn().mockResolvedValueOnce({
      results: [
        { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Almi follow-up' }] } },
        { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Kevin and Damien' }] } },
        { type: 'image', image: {} }, // unknown — must be ignored
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ plain_text: 'Discussed konvertibellånet' }] },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    const notion = {
      blocks: { children: { list } },
    } as unknown as Parameters<typeof readTranscriptBody>[0];

    const body = await readTranscriptBody(notion, 'page-1');
    expect(body).toContain('Almi follow-up');
    expect(body).toContain('Kevin and Damien');
    expect(body).toContain('Discussed konvertibellånet');
    expect(body).not.toContain('image');
  });

  it('paginates across has_more=true → false', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'page1' }] } }],
        has_more: true,
        next_cursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'page2' }] } }],
        has_more: false,
        next_cursor: null,
      });
    const notion = {
      blocks: { children: { list } },
    } as unknown as Parameters<typeof readTranscriptBody>[0];

    const body = await readTranscriptBody(notion, 'page-1');
    expect(body).toContain('page1');
    expect(body).toContain('page2');
    expect(list).toHaveBeenCalledTimes(2);
    expect((list.mock.calls[1]![0] as { start_cursor?: string }).start_cursor).toBe('cursor-1');
  });
});
