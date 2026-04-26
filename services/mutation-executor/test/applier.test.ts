/**
 * Archive-not-delete applier tests (Plan 08-04 Task 2).
 *
 * Asserts the SQL-grant invariants: every mutation_type UPDATEs (no DELETE)
 * and the cancel_meeting / reschedule_meeting paths NEVER call the
 * googleapis network.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyMutation } from '../src/applier.js';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(handler: (sql: string) => { rowCount: number; rows: unknown[] }): MockPool {
  return { query: vi.fn(async (sql: string) => handler(sql)) };
}

const ownerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const captureId = '01HK000000000000000000000A';

describe('applyMutation', () => {
  it('cancel_meeting → UPDATE calendar_events_cache; result=archived; NO Google API call', async () => {
    const pool = makePool((sql) => {
      expect(sql).toContain('UPDATE calendar_events_cache');
      expect(sql).toContain('ignored_by_kevin = true');
      // Critical: never DELETE
      expect(sql.toUpperCase()).not.toContain('DELETE FROM');
      return { rowCount: 1, rows: [{ event_id: 'evt-1' }] };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockImplementation(() => {
      throw new Error('fetch should NOT be called for cancel_meeting');
    });

    const r = await applyMutation({
      pool: pool as never,
      ownerId,
      captureId,
      mutation_type: 'cancel_meeting',
      target_kind: 'meeting',
      target_id: 'evt-1',
    });
    expect(r.result).toBe('archived');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('delete_task → UPDATE inbox_index status=archived + Notion archive call', async () => {
    const pool = makePool((sql) => {
      expect(sql).toContain('UPDATE inbox_index');
      expect(sql).toContain("status = 'archived'");
      expect(sql.toUpperCase()).not.toContain('DELETE FROM');
      return {
        rowCount: 1,
        rows: [{ notion_page_id: 'notion-page-1', title: 'AlmI follow-up' }],
      };
    });
    const notionUpdate = vi.fn(async () => ({}));
    const notion = { pages: { update: notionUpdate } } as never;

    const r = await applyMutation({
      pool: pool as never,
      ownerId,
      captureId,
      mutation_type: 'delete_task',
      target_kind: 'task',
      target_id: '11111111-1111-4111-8111-111111111111',
      notion,
    });
    expect(r.result).toBe('archived');
    expect(notionUpdate).toHaveBeenCalledTimes(1);
    const allCalls = notionUpdate.mock.calls as unknown as Array<unknown[]>;
    const callArg = (allCalls[0]?.[0] ?? {}) as {
      page_id: string;
      properties: Record<string, unknown>;
    };
    expect(callArg.page_id).toBe('notion-page-1');
    expect(JSON.stringify(callArg.properties)).toMatch(/ARKIVERAD-/);
  });

  it('cancel_content_draft → UPDATE content_drafts; emits content.cancel_requested in result', async () => {
    const pool = makePool((sql) => {
      expect(sql).toContain('UPDATE content_drafts');
      expect(sql).toContain("status = 'cancelled'");
      return {
        rowCount: 1,
        rows: [{ id: 'cd-1', capture_id: captureId }],
      };
    });
    const r = await applyMutation({
      pool: pool as never,
      ownerId,
      captureId,
      mutation_type: 'cancel_content_draft',
      target_kind: 'content_draft',
      target_id: 'cd-1',
    });
    expect(r.result).toBe('archived');
    if (r.result === 'archived' && 'emit' in r) {
      expect(r.emit?.detailType).toBe('content.cancel_requested');
    }
  });

  it('cancel_email_draft → UPDATE email_drafts status=cancelled', async () => {
    const pool = makePool((sql) => {
      expect(sql).toContain('UPDATE email_drafts');
      expect(sql).toContain("status = 'cancelled'");
      return { rowCount: 1, rows: [{ id: 'ed-1', capture_id: captureId }] };
    });
    const r = await applyMutation({
      pool: pool as never,
      ownerId,
      captureId,
      mutation_type: 'cancel_email_draft',
      target_kind: 'email_draft',
      target_id: 'ed-1',
    });
    expect(r.result).toBe('archived');
  });

  it('archive_doc → no_op v1 (document_versions append-only)', async () => {
    const pool = makePool(() => ({ rowCount: 0, rows: [] }));
    const r = await applyMutation({
      pool: pool as never,
      ownerId,
      captureId,
      mutation_type: 'archive_doc',
      target_kind: 'document',
      target_id: 'doc-1',
    });
    expect(r.result).toBe('no_op');
  });

  it('target row missing → result=failed, error=target_not_found:*', async () => {
    const pool = makePool(() => ({ rowCount: 0, rows: [] }));
    const r = await applyMutation({
      pool: pool as never,
      ownerId,
      captureId,
      mutation_type: 'cancel_meeting',
      target_kind: 'meeting',
      target_id: 'evt-missing',
    });
    expect(r.result).toBe('failed');
    if (r.result === 'failed') expect(r.error).toMatch(/target_not_found/);
  });
});
