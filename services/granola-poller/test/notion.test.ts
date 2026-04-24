/**
 * notion.ts unit tests — pure functions only (no Lambda runtime needed).
 *
 * Coverage:
 *   1. readPageContent concatenates paragraph + heading block plain_text.
 *   2. queryTranskriptenSince paginates across has_more=true.
 *   3. getTranskriptenDbId throws actionable error when both env + file missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs.existsSync BEFORE the module-under-test imports node:fs.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
  };
});

import { getTranskriptenDbId, queryTranskriptenSince, readPageContent } from '../src/notion.js';
import type { Client } from '@notionhq/client';

beforeEach(() => {
  delete process.env.NOTION_TRANSKRIPTEN_DB_ID;
});

describe('readPageContent', () => {
  it('returns concatenated paragraph + heading blocks as transcript_text', async () => {
    const fakeNotion = {
      pages: {
        retrieve: vi.fn().mockResolvedValue({
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Möte med Damien' }] },
            Created: { type: 'date', date: { start: '2026-04-20T10:00:00.000Z' } },
            Attendees: {
              type: 'multi_select',
              multi_select: [{ name: 'Kevin' }, { name: 'Damien' }],
            },
          },
          created_time: '2026-04-20T10:00:00.000Z',
          url: 'https://notion.so/abc',
        }),
      },
      blocks: {
        children: {
          list: vi.fn().mockResolvedValue({
            results: [
              { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Sammanfattning' }] } },
              { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Damien förbereder term sheet.' }] } },
              { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Almi review nästa fredag.' }] } },
              { type: 'unsupported_block_type', foo: { bar: 'baz' } },
            ],
            has_more: false,
            next_cursor: null,
          }),
        },
      },
    };

    const out = await readPageContent(fakeNotion as unknown as Client, 'page-1');

    expect(out.title).toBe('Möte med Damien');
    expect(out.transcript_text).toContain('Sammanfattning');
    expect(out.transcript_text).toContain('Damien förbereder term sheet.');
    expect(out.transcript_text).toContain('Almi review nästa fredag.');
    expect(out.attendees).toEqual(['Kevin', 'Damien']);
    expect(out.recorded_at.toISOString()).toBe('2026-04-20T10:00:00.000Z');
    expect(out.notion_url).toBe('https://notion.so/abc');
    expect(out.raw_length).toBe(out.transcript_text.length);
  });
});

describe('queryTranskriptenSince', () => {
  it('paginates correctly across has_more=true → false', async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          { id: 'p1', last_edited_time: '2026-04-20T10:00:00.000Z' },
          { id: 'p2', last_edited_time: '2026-04-20T11:00:00.000Z' },
        ],
        has_more: true,
        next_cursor: 'cur-1',
      })
      .mockResolvedValueOnce({
        results: [{ id: 'p3', last_edited_time: '2026-04-20T12:00:00.000Z' }],
        has_more: false,
        next_cursor: null,
      });
    const fakeNotion = { databases: { query: queryMock } };

    const since = new Date('2026-04-19T00:00:00.000Z');
    const collected: string[] = [];
    for await (const p of queryTranskriptenSince(fakeNotion as unknown as Client, 'db-1', since)) {
      collected.push(p.id);
    }

    expect(collected).toEqual(['p1', 'p2', 'p3']);
    expect(queryMock).toHaveBeenCalledTimes(2);
    // Second call carries the start_cursor.
    const secondCallArg = queryMock.mock.calls[1]![0] as { start_cursor?: string };
    expect(secondCallArg.start_cursor).toBe('cur-1');
  });
});

describe('getTranskriptenDbId', () => {
  // fs.existsSync is mocked at module-load time above (returns false), and
  // the env var is cleared in the outer beforeEach.
  it('throws actionable error when neither env nor JSON file resolves', async () => {
    await expect(getTranskriptenDbId()).rejects.toThrow(/discover-notion-dbs\.mjs/);
    await expect(getTranskriptenDbId()).rejects.toThrow(/transkripten/i);
  });

  it('returns env override when set', async () => {
    process.env.NOTION_TRANSKRIPTEN_DB_ID = 'real-db-id';
    expect(await getTranskriptenDbId()).toBe('real-db-id');
  });

  it('treats empty + sentinel as not-set', async () => {
    process.env.NOTION_TRANSKRIPTEN_DB_ID = '';
    await expect(getTranskriptenDbId()).rejects.toThrow();
    process.env.NOTION_TRANSKRIPTEN_DB_ID = 'PLACEHOLDER_TRANSKRIPTEN_DB_ID';
    await expect(getTranskriptenDbId()).rejects.toThrow();
  });
});
