import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforceAndIncrement } from '../src/cap.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Cap enforcement unit tests — we mock `DynamoDBDocumentClient.send` directly
 * rather than spinning up DynamoDB Local. The contract we care about is:
 *
 *  1. Quiet-hours is checked BEFORE the DynamoDB call (rejection doesn't burn
 *     a slot).
 *  2. Successive sends during active hours succeed until the cap is hit.
 *  3. The 4th send rejects via ConditionalCheckFailedException mapping.
 *  4. The UpdateCommand uses the canonical expression shape (ADD + cond).
 *
 * We pick a fixed UTC instant that is 10:00 Stockholm (winter CET = 09:00 UTC)
 * so isQuietHour() is false for all non-quiet assertions.
 */

// 09:00 UTC on 2026-01-15 == 10:00 Stockholm (winter CET).
const ACTIVE_UTC = new Date('2026-01-15T09:00:00Z');
// 21:00 UTC == 22:00 Stockholm (winter CET) → quiet window.
const QUIET_UTC = new Date('2026-01-15T21:00:00Z');

function mockDdb(
  sendImpl: (cmd: unknown) => Promise<unknown>,
): { client: DynamoDBDocumentClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(sendImpl);
  const client = { send } as unknown as DynamoDBDocumentClient;
  return { client, send };
}

describe('enforceAndIncrement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns quiet-hours during Stockholm 22:00 (without touching DynamoDB)', async () => {
    const { client, send } = mockDdb(async () => ({ Attributes: { count: 1 } }));
    const result = await enforceAndIncrement({
      tableName: 'cap',
      ddb: client,
      now: () => QUIET_UTC,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('quiet-hours');
    // Must NOT have consumed a slot in DynamoDB.
    expect(send).not.toHaveBeenCalled();
  });

  it('allows 1st send at 10:00 Stockholm', async () => {
    const { client, send } = mockDdb(async () => ({ Attributes: { count: 1 } }));
    const result = await enforceAndIncrement({
      tableName: 'cap',
      ddb: client,
      now: () => ACTIVE_UTC,
    });
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows 2nd and 3rd sends (cap = 3)', async () => {
    let current = 1;
    const { client } = mockDdb(async () => {
      current += 1;
      return { Attributes: { count: current } };
    });
    const r2 = await enforceAndIncrement({ tableName: 'cap', ddb: client, now: () => ACTIVE_UTC });
    const r3 = await enforceAndIncrement({ tableName: 'cap', ddb: client, now: () => ACTIVE_UTC });
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r2.count).toBe(2);
    expect(r3.count).toBe(3);
  });

  it('rejects 4th send with cap-exceeded (ConditionalCheckFailedException)', async () => {
    const { client } = mockDdb(async () => {
      const err = new Error('The conditional request failed');
      (err as Error & { name: string }).name = 'ConditionalCheckFailedException';
      throw err;
    });
    const result = await enforceAndIncrement({
      tableName: 'cap',
      ddb: client,
      now: () => ACTIVE_UTC,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('cap-exceeded');
  });

  it('UpdateCommand uses ADD #c :one + ConditionExpression :max and respects maxPerDay', async () => {
    const captured: unknown[] = [];
    const { client } = mockDdb(async (cmd: unknown) => {
      captured.push(cmd);
      return { Attributes: { count: 1 } };
    });
    await enforceAndIncrement({
      tableName: 'my-cap-table',
      ddb: client,
      now: () => ACTIVE_UTC,
      maxPerDay: 3,
    });
    expect(captured.length).toBe(1);
    const cmd = captured[0] as { input: Record<string, unknown> };
    const input = cmd.input;
    expect(input.TableName).toBe('my-cap-table');
    expect(input.UpdateExpression).toContain('ADD #c :one');
    expect(input.ConditionExpression).toContain('attribute_not_exists(#c)');
    expect(input.ConditionExpression).toContain('#c < :max');
    const vals = input.ExpressionAttributeValues as Record<string, unknown>;
    expect(vals[':max']).toBe(3);
    expect(vals[':one']).toBe(1);
    // pk should embed the Stockholm date (2026-01-15 at 10:00 Stockholm).
    const key = input.Key as { pk: string };
    expect(key.pk).toBe('telegram-cap#2026-01-15');
  });

  it('re-throws unknown DynamoDB errors (non-conditional-check)', async () => {
    const { client } = mockDdb(async () => {
      const err = new Error('ProvisionedThroughputExceededException');
      (err as Error & { name: string }).name = 'ProvisionedThroughputExceededException';
      throw err;
    });
    await expect(
      enforceAndIncrement({ tableName: 'cap', ddb: client, now: () => ACTIVE_UTC }),
    ).rejects.toThrow(/Provisioned/);
  });
});

/**
 * Plan 02-06 / §13 Pitfall-6 — is_reply bypass.
 *
 * Kevin-initiated synchronous replies (e.g. voice-capture's "✅ Saved to
 * Command Center · …" ack) MUST bypass BOTH the quiet-hours gate AND the
 * DynamoDB cap. They flow through the same enforceAndIncrement entry point
 * but short-circuit to `{allowed: true}` before either check runs.
 *
 * The production handler forwards `is_reply` from the EB detail onto
 * `enforceAndIncrement({ ..., isReply })`; these tests lock that contract in.
 */
describe('enforceAndIncrement — Plan 02-06 is_reply bypass (§13 / Pitfall 6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isReply=true at Stockholm 22:00 (quiet hours) → allowed without hitting DynamoDB', async () => {
    const { client, send } = mockDdb(async () => {
      throw new Error('DDB must not be called on is_reply bypass');
    });
    const res = await enforceAndIncrement({
      tableName: 'cap',
      isReply: true,
      ddb: client,
      now: () => QUIET_UTC,
    });
    expect(res).toEqual({ allowed: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('isReply=true during active hours → allowed without hitting DynamoDB (no slot consumed)', async () => {
    const { client, send } = mockDdb(async () => {
      throw new Error('DDB must not be called on is_reply bypass');
    });
    const res = await enforceAndIncrement({
      tableName: 'cap',
      isReply: true,
      ddb: client,
      now: () => ACTIVE_UTC,
    });
    expect(res).toEqual({ allowed: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('isReply=false at 22:00 → quiet-hours denial (existing Phase 1 behaviour preserved)', async () => {
    const { client, send } = mockDdb(async () => ({ Attributes: { count: 1 } }));
    const res = await enforceAndIncrement({
      tableName: 'cap',
      isReply: false,
      ddb: client,
      now: () => QUIET_UTC,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('quiet-hours');
    expect(send).not.toHaveBeenCalled();
  });
});
