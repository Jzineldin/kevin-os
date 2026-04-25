/**
 * Phase 7 Plan 07-02 Task 2 — replaceActiveThreadsSection unit tests.
 *
 * Covers T-07-WEEKLY-01 (over-archive risk) by verifying the heading_2
 * detection logic against three fixtures:
 *   1. Existing "Active threads" heading_2 followed by bullets and another
 *      heading_2 — only the section between the two headings (inclusive of
 *      the "Active threads" heading itself) gets archived.
 *   2. No existing "Active threads" heading — append-at-end fallback (no
 *      destructive archive).
 *   3. Multiple heading_2 blocks where "Active threads" is the LAST one —
 *      everything after gets archived.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @notionhq/client.
const blocksList = vi.fn();
const blocksUpdate = vi.fn();
const blocksAppend = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class {
    blocks = {
      children: { list: blocksList, append: blocksAppend },
      update: blocksUpdate,
    };
  },
}));

// Mock Secrets Manager (unused; NOTION_TOKEN env fallback covers tests).
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = vi.fn();
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

import {
  replaceActiveThreadsSection,
  __resetNotionCacheForTests,
} from '../src/notion.js';

beforeEach(() => {
  vi.clearAllMocks();
  __resetNotionCacheForTests();
  process.env.NOTION_TOKEN = 'secret_test_token';
  blocksUpdate.mockResolvedValue({});
  blocksAppend.mockResolvedValue({});
});

const SNAPSHOT = [
  { thread: 'Almi convertible', where: 'almi' as const, status: 'signed' },
  { thread: 'TaleForge release', where: 'tale-forge' as const, status: 'in-review' },
];

describe('replaceActiveThreadsSection', () => {
  it('archives the existing Active Threads heading + bullets up to next heading_2; appends new section at end', async () => {
    blocksList.mockResolvedValueOnce({
      results: [
        // Other section (must NOT be archived).
        { id: 'h2-priorities', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Current priorities' }] } },
        { id: 'p-priorities', type: 'paragraph' },
        // Active threads section (MUST be archived).
        { id: 'h2-active', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Active threads' }] } },
        { id: 'b-1', type: 'bulleted_list_item' },
        { id: 'b-2', type: 'bulleted_list_item' },
        // Next section (must NOT be archived).
        { id: 'h2-decisions', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Recent decisions' }] } },
        { id: 'p-decisions', type: 'paragraph' },
      ],
    });

    await replaceActiveThreadsSection('kevin-page', SNAPSHOT);

    // Expect 3 archive calls: h2-active, b-1, b-2 — NOT h2-priorities,
    // p-priorities, h2-decisions, or p-decisions.
    const archivedIds = blocksUpdate.mock.calls.map((c) => (c[0] as { block_id: string }).block_id);
    expect(archivedIds).toEqual(expect.arrayContaining(['h2-active', 'b-1', 'b-2']));
    expect(archivedIds).not.toContain('h2-priorities');
    expect(archivedIds).not.toContain('p-priorities');
    expect(archivedIds).not.toContain('h2-decisions');
    expect(archivedIds).not.toContain('p-decisions');

    expect(blocksAppend).toHaveBeenCalledTimes(1);
    const appendArgs = blocksAppend.mock.calls[0]![0];
    expect(appendArgs.block_id).toBe('kevin-page');
    // First child is the heading_2 "Active threads".
    const children = appendArgs.children as Array<{ type: string; heading_2?: any; bulleted_list_item?: any }>;
    expect(children[0]!.type).toBe('heading_2');
    // 2 snapshot items → 2 bulleted_list_items.
    expect(children.filter((c) => c.type === 'bulleted_list_item')).toHaveLength(2);
  });

  it('append-at-end fallback when no Active Threads heading exists (non-destructive)', async () => {
    blocksList.mockResolvedValueOnce({
      results: [
        { id: 'h2-priorities', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Current priorities' }] } },
        { id: 'p-priorities', type: 'paragraph' },
      ],
    });

    await replaceActiveThreadsSection('kevin-page', SNAPSHOT);

    // No archives — fallback is non-destructive.
    expect(blocksUpdate).not.toHaveBeenCalled();
    // Still appends the new section.
    expect(blocksAppend).toHaveBeenCalledTimes(1);
  });

  it('archives Active Threads section when it is the LAST heading_2 in the page', async () => {
    blocksList.mockResolvedValueOnce({
      results: [
        { id: 'h2-priorities', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Current priorities' }] } },
        { id: 'p-priorities', type: 'paragraph' },
        { id: 'h2-active', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Active threads' }] } },
        { id: 'b-1', type: 'bulleted_list_item' },
        { id: 'b-2', type: 'bulleted_list_item' },
      ],
    });

    await replaceActiveThreadsSection('kevin-page', SNAPSHOT);

    const archivedIds = blocksUpdate.mock.calls.map((c) => (c[0] as { block_id: string }).block_id);
    expect(archivedIds).toEqual(expect.arrayContaining(['h2-active', 'b-1', 'b-2']));
    expect(archivedIds).not.toContain('h2-priorities');
    expect(blocksAppend).toHaveBeenCalledTimes(1);
  });
});
