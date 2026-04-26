/**
 * Plan 08-05 Task 2 — listEntityTimeline tests (4 tests).
 *
 *   1. Entity without email-shaped aliases → no document_versions section
 *   2. Entity with an email alias → document_versions rows included
 *   3. Items sorted by effective timestamp DESC across mentions + documents
 *   4. Limit applied after merge
 *
 * The entity-timeline helper queries entity_index + mention_events +
 * document_versions through a Drizzle `db.execute(sql`...``)` interface.
 * We mock `getDb()` with a stub that returns canned rows for each SQL
 * query in sequence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbExecuteMock = vi.fn();
vi.mock('../src/db.js', () => ({
  getDb: vi.fn(async () => ({ execute: dbExecuteMock })),
  __setDbForTest: vi.fn(),
}));
vi.mock('@kos/db', () => ({
  KEVIN_OWNER_ID: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
}));

import { listEntityTimeline } from '../src/routes/entity-timeline.js';

const ownerId = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const entityId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  dbExecuteMock.mockReset();
});

describe('listEntityTimeline', () => {
  it('1. entity without email-shaped aliases → no document_versions section', async () => {
    // Entity row: aliases is ['Dam'] (no @)
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: entityId,
          name: 'Damien',
          aliases: ['Dam'],
        },
      ],
    });
    // mention_events query
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'm1',
          occurred_at: new Date('2026-04-23T12:00:00Z'),
          source: 'email',
          context: 'Met Damien',
          capture_id: '01HK000000000000000000000A',
        },
      ],
    });
    // document_versions query MUST NOT be called (no emails).
    const r = await listEntityTimeline({ entityId, ownerId });
    expect(r.entity).toMatchObject({ id: entityId, name: 'Damien', primary_email: null });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.kind).toBe('mention');
    // Only 2 db.execute calls — entity + mention. No document_versions read.
    expect(dbExecuteMock).toHaveBeenCalledTimes(2);
  });

  it('2. entity with an email alias → document_versions rows included', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: entityId,
          name: 'Damien',
          aliases: ['Dam', 'damien@almi.se'],
        },
      ],
    });
    dbExecuteMock.mockResolvedValueOnce({
      rows: [],
    });
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'd1',
          recipient_email: 'damien@almi.se',
          doc_name: 'avtal.pdf',
          version_n: 4,
          sha256: 'a'.repeat(64),
          parent_sha256: 'b'.repeat(64),
          diff_summary: '4.2 ESOP-allokering tillagd.',
          sent_at: new Date('2026-04-23T12:00:00Z'),
        },
      ],
    });

    const r = await listEntityTimeline({ entityId, ownerId });
    expect(r.entity?.primary_email).toBe('damien@almi.se');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      kind: 'document_version',
      doc_name: 'avtal.pdf',
      version_n: 4,
      recipient_email: 'damien@almi.se',
    });
    expect(dbExecuteMock).toHaveBeenCalledTimes(3);
  });

  it('3. items sorted by effective timestamp DESC across mentions + documents', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        { id: entityId, name: 'Damien', aliases: ['damien@almi.se'] },
      ],
    });
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'm-old',
          occurred_at: new Date('2026-04-20T10:00:00Z'),
          source: 'email',
          context: 'old mention',
          capture_id: 'cap-1',
        },
        {
          id: 'm-new',
          occurred_at: new Date('2026-04-25T10:00:00Z'),
          source: 'granola',
          context: 'recent mention',
          capture_id: 'cap-2',
        },
      ],
    });
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'd1',
          recipient_email: 'damien@almi.se',
          doc_name: 'avtal.pdf',
          version_n: 3,
          sha256: 'a'.repeat(64),
          parent_sha256: null,
          diff_summary: null,
          sent_at: new Date('2026-04-22T12:00:00Z'),
        },
      ],
    });

    const r = await listEntityTimeline({ entityId, ownerId });
    expect(r.items.map((i) => i.id)).toEqual(['m-new', 'd1', 'm-old']);
  });

  it('4. limit applied after merge', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        { id: entityId, name: 'Damien', aliases: ['damien@almi.se'] },
      ],
    });
    // 5 mentions + 5 docs → 10 total; limit=3 keeps top 3.
    dbExecuteMock.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, n) => ({
        id: `m-${n}`,
        occurred_at: new Date(`2026-04-2${n}T10:00:00Z`),
        source: 'email',
        context: 'mention',
        capture_id: `cap-${n}`,
      })),
    });
    dbExecuteMock.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, n) => ({
        id: `d-${n}`,
        recipient_email: 'damien@almi.se',
        doc_name: 'avtal.pdf',
        version_n: n + 1,
        sha256: 'a'.repeat(64),
        parent_sha256: null,
        diff_summary: null,
        sent_at: new Date(`2026-04-2${n}T11:00:00Z`),
      })),
    });

    const r = await listEntityTimeline({ entityId, ownerId, limit: 3 });
    expect(r.items).toHaveLength(3);
  });
});
