/**
 * Target-resolver tests (Plan 08-04 Task 1).
 *
 * Each query branch is exercised against a mocked pg.Pool. The resolver
 * uses Promise.allSettled so a single source-table failure cannot
 * cascade-fail the others.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatherTargetCandidates } from '../src/target-resolver.js';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(rowsByQuery: Record<string, unknown[]>): MockPool {
  return {
    query: vi.fn(async (sql: string) => {
      for (const [needle, rows] of Object.entries(rowsByQuery)) {
        if (sql.includes(needle)) return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    }),
  };
}

const ownerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('gatherTargetCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancel_meeting → loads from calendar_events_cache', async () => {
    const pool = makePool({
      calendar_events_cache: [
        {
          event_id: 'evt-1',
          summary: 'Damien call',
          start_utc: '2026-04-26T11:00:00Z',
          attendees_json: ['damien@example.com'],
        },
      ],
    });
    const r = await gatherTargetCandidates({
      pool: pool as unknown as Parameters<typeof gatherTargetCandidates>[0]['pool'],
      ownerId,
      mutationType: 'cancel_meeting',
      entityIds: [],
      recentText: 'cancel the Damien call',
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('meeting');
    expect(r[0]!.id).toBe('evt-1');
    expect(r[0]!.display).toContain('Damien call');
  });

  it('delete_task → loads from inbox_index', async () => {
    const pool = makePool({
      inbox_index: [{ id: 't-1', title: 'AlmI follow-up', status: 'pending' }],
    });
    const r = await gatherTargetCandidates({
      pool: pool as unknown as Parameters<typeof gatherTargetCandidates>[0]['pool'],
      ownerId,
      mutationType: 'delete_task',
      entityIds: [],
      recentText: 'arkivera AlmI-tasken',
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('task');
    expect(r[0]!.display).toContain('AlmI follow-up');
  });

  it('cancel_content_draft → loads from content_drafts', async () => {
    const pool = makePool({
      content_drafts: [
        { id: 'cd-1', platform: 'linkedin', body: 'New post about Tale Forge', status: 'draft' },
      ],
    });
    const r = await gatherTargetCandidates({
      pool: pool as unknown as Parameters<typeof gatherTargetCandidates>[0]['pool'],
      ownerId,
      mutationType: 'cancel_content_draft',
      entityIds: [],
      recentText: 'delete that content draft for LinkedIn',
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.kind).toBe('content_draft');
    expect(r[0]!.display).toContain('linkedin');
  });

  it('attendee match adds secondary_signal', async () => {
    const pool = makePool({
      calendar_events_cache: [
        {
          event_id: 'evt-1',
          summary: 'Damien call',
          start_utc: '2026-04-26T11:00:00Z',
          attendees_json: ['damien-entity-id'],
        },
      ],
    });
    const r = await gatherTargetCandidates({
      pool: pool as unknown as Parameters<typeof gatherTargetCandidates>[0]['pool'],
      ownerId,
      mutationType: 'cancel_meeting',
      entityIds: ['damien-entity-id'],
      recentText: 'cancel the Damien call',
    });
    expect(r[0]!.secondary_signal).toMatch(/attendee match/);
  });

  it('no candidates → empty array (handler short-circuits)', async () => {
    const pool = makePool({});
    const r = await gatherTargetCandidates({
      pool: pool as unknown as Parameters<typeof gatherTargetCandidates>[0]['pool'],
      ownerId,
      mutationType: 'cancel_meeting',
      entityIds: [],
      recentText: 'ta bort mötet',
    });
    expect(r).toEqual([]);
  });
});
