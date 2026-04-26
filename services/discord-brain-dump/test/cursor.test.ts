/**
 * @kos/service-discord-brain-dump — cursor unit tests.
 *
 * Three behaviour cases covered:
 *   1. fresh / cold-start channel → getCursor returns null
 *   2. setCursor → getCursor round-trips the message ID + writes a
 *      monotonic TTL
 *   3. concurrent setCursor calls — last write wins (no ConditionExpression
 *      gating because each Scheduler fire processes monotonically newer
 *      messages, so a clobber is functionally equivalent to a re-replay)
 *
 * The DynamoDBDocumentClient is replaced with a tiny in-memory map that
 * speaks the same `.send(GetCommand|PutCommand)` surface — the cursor
 * module never touches the underlying HTTP client, so this is enough for
 * unit-level coverage.
 */
import { describe, it, expect } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getCursor, setCursor, type CursorRow } from '../src/cursor.js';

interface InMemoryStore {
  table: Map<string, CursorRow>;
}

/**
 * Drop-in DynamoDBDocumentClient stand-in. Speaks just enough of the
 * `.send` API for `GetCommand` + `PutCommand`. Returns the same shape
 * AWS SDK v3 would return so the cursor module's `out.Item` access works.
 */
function makeFakeDocClient(store: InMemoryStore) {
  return {
    async send(cmd: GetCommand | PutCommand) {
      if (cmd instanceof GetCommand) {
        const key = cmd.input.Key as { pk: string } | undefined;
        const pk = key?.pk;
        if (!pk) return { Item: undefined };
        return { Item: store.table.get(pk) };
      }
      if (cmd instanceof PutCommand) {
        const item = cmd.input.Item as CursorRow | undefined;
        if (!item) return {};
        store.table.set(item.pk, item);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
}

const TABLE = 'KosDiscordBrainDumpCursorTest';

describe('discord-brain-dump / cursor', () => {
  it('returns null for a fresh channel (no row yet)', async () => {
    const store: InMemoryStore = { table: new Map() };
    const client = makeFakeDocClient(store);
    const got = await getCursor('123456', {
      tableName: TABLE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
    expect(got).toBeNull();
  });

  it('round-trips set → get with monotonic TTL', async () => {
    const store: InMemoryStore = { table: new Map() };
    const client = makeFakeDocClient(store);
    const fixedNow = 1_761_400_000_000; // 2025-10-25T17:46:40Z
    await setCursor('123456', 'msg-001', {
      tableName: TABLE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      now: () => fixedNow,
    });
    const got = await getCursor('123456', {
      tableName: TABLE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
    expect(got).toBe('msg-001');
    const row = store.table.get('123456')!;
    expect(row.ttl).toBe(Math.floor(fixedNow / 1000) + 30 * 24 * 60 * 60);
    expect(row.updatedAt).toBe(new Date(fixedNow).toISOString());
  });

  it('concurrent set is last-write-wins', async () => {
    const store: InMemoryStore = { table: new Map() };
    const client = makeFakeDocClient(store);
    const opts = {
      tableName: TABLE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    };
    // simulate two concurrent fires racing — Promise.all preserves no
    // ordering guarantee, so we run them sequentially with monotonic IDs
    // to make the assertion deterministic.
    await setCursor('123456', 'msg-001', { ...opts, now: () => 1_000 });
    await setCursor('123456', 'msg-002', { ...opts, now: () => 2_000 });
    const got = await getCursor('123456', opts);
    expect(got).toBe('msg-002');
  });
});
