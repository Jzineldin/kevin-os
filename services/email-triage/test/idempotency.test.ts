/**
 * Email-triage persist idempotency tests (Plan 04-04 Task 2 + Gate 3 criterion 1).
 *
 * 3 tests covering:
 *   - findExistingDraftByMessage returns the row id when present
 *   - insertEmailDraftPending uses ON CONFLICT DO NOTHING and re-SELECTs
 *     the existing id on conflict
 *   - DUPLICATE_EMAIL_FIXTURES processed twice → only one INSERT roundtrip
 *     produces a fresh row (the second is a conflict, returns the same id)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DUPLICATE_EMAIL_FIXTURES } from '@kos/test-fixtures';

describe('email-triage persist idempotency', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('findExistingDraftByMessage returns id when present', async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: 'd-1' }] }),
    };
    const { findExistingDraftByMessage } = await import('../src/persist.js');
    const id = await findExistingDraftByMessage(
      pool as never,
      'kevin-taleforge',
      '<almi-1@almi.example>',
    );
    expect(id).toBe('d-1');
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0]?.[0]).toContain('SELECT id FROM email_drafts');
  });

  it('insertEmailDraftPending → re-SELECTs existing id on conflict', async () => {
    const pool = {
      query: vi
        .fn()
        // First call: INSERT ... ON CONFLICT DO NOTHING → no row returned
        .mockResolvedValueOnce({ rows: [] })
        // Second call: re-SELECT → returns the existing row
        .mockResolvedValueOnce({ rows: [{ id: 'd-existing' }] }),
    };
    const { insertEmailDraftPending } = await import('../src/persist.js');
    const id = await insertEmailDraftPending(pool as never, {
      ownerId: 'owner',
      captureId: 'cap-1',
      accountId: 'acc',
      messageId: 'msg-1',
      from: 'a@b.example',
      to: ['c@d.example'],
      subject: 's',
      receivedAt: '2026-04-25T07:00:00.000Z',
    });
    expect(id).toBe('d-existing');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('DUPLICATE_EMAIL_FIXTURES processed twice → both calls yield same draft id', async () => {
    // Simulate the SQL layer enforcing UNIQUE(account_id, message_id):
    //   - 1st insert → fresh row, returns 'd-fresh'
    //   - 2nd insert → conflict (no row returned by ON CONFLICT DO NOTHING)
    //     then re-SELECT returns 'd-fresh' (same row)
    const pool = {
      query: vi
        .fn()
        // call 1 INSERT → fresh
        .mockResolvedValueOnce({ rows: [{ id: 'd-fresh' }] })
        // call 2 INSERT → conflict (no rows)
        .mockResolvedValueOnce({ rows: [] })
        // call 3 re-SELECT → existing
        .mockResolvedValueOnce({ rows: [{ id: 'd-fresh' }] }),
    };
    const { insertEmailDraftPending } = await import('../src/persist.js');
    const [a, b] = DUPLICATE_EMAIL_FIXTURES;
    const id1 = await insertEmailDraftPending(pool as never, {
      ownerId: 'owner',
      captureId: a!.capture_id,
      accountId: a!.email.account_id,
      messageId: a!.email.message_id,
      from: a!.email.from,
      to: [...a!.email.to],
      subject: a!.email.subject,
      receivedAt: a!.email.received_at,
    });
    const id2 = await insertEmailDraftPending(pool as never, {
      ownerId: 'owner',
      captureId: b!.capture_id,
      accountId: b!.email.account_id,
      messageId: b!.email.message_id,
      from: b!.email.from,
      to: [...b!.email.to],
      subject: b!.email.subject,
      receivedAt: b!.email.received_at,
    });
    expect(id1).toBe('d-fresh');
    expect(id2).toBe('d-fresh');
    // Total 3 query calls: 2 INSERTs + 1 re-SELECT (the second insert
    // conflicted and triggered a SELECT roundtrip).
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});
