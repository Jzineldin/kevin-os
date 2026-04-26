/**
 * discord-brain-dump handler tests (Plan 10-04 Task 2).
 *
 * Coverage:
 *   1. No new messages → 0 PutEvents, cursor unchanged
 *   2. Cold-start (cursor=null) + N msgs → seeds cursor, emits 0
 *   3. Happy path: warm cursor + N msgs → emit + advance per message
 *   4. Deterministic capture_id: same (channel_id, message_id) → same id
 *   5. agent_runs idempotency: prior `ok` row → skip emit but advance cursor
 *   6. 401 from Discord → DiscordAuthError → exit success, cursor unchanged
 *   7. 429 from Discord → DiscordRateLimitError → exit success, cursor unchanged
 *   8. Per-message emit failure → cursor advances to last successful id only,
 *      then handler rethrows
 *   9. Cursor advance after each successful emit (not at end of loop)
 *  10. Schedule contract input shape `{ channel: 'brain-dump', owner_id }`
 *      validates correctly and resolves owner_id from input
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks declared BEFORE handler import (vi.mock hoisting) ---------------

// Sentry / tracing — noop.
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    configureScope: vi.fn(),
  },
}));

vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

// Secrets Manager — token resolution.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: 'BOT_TOKEN_TEST' }),
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

// Cursor module — in-memory.
const cursorState = {
  current: null as string | null,
  setCalls: [] as Array<{ channelId: string; messageId: string }>,
};
vi.mock('../src/cursor.js', () => ({
  getCursor: vi.fn(async (_channelId: string) => cursorState.current),
  setCursor: vi.fn(async (channelId: string, messageId: string) => {
    cursorState.current = messageId;
    cursorState.setCalls.push({ channelId, messageId });
  }),
}));

// Discord wrapper.
const discordState = {
  messages: [] as Array<{
    id: string;
    channel_id: string;
    author: { id: string; username: string; bot?: boolean };
    content: string;
    timestamp: string;
  }>,
  throwError: null as Error | null,
};
vi.mock('../src/discord.js', async () => {
  const actual = await vi.importActual<typeof import('../src/discord.js')>(
    '../src/discord.js',
  );
  return {
    // re-export real error classes so `instanceof` checks in the handler match
    DiscordAuthError: actual.DiscordAuthError,
    DiscordRateLimitError: actual.DiscordRateLimitError,
    DiscordTransientError: actual.DiscordTransientError,
    fetchNewMessages: vi.fn(async () => {
      if (discordState.throwError) throw discordState.throwError;
      return discordState.messages;
    }),
  };
});

// Persist — in-memory.
const persistState = {
  priorOk: new Set<string>(),
  inserted: [] as Array<{ ownerId: string; captureId: string; status: string }>,
  updated: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  emitted: [] as Array<{ Source: string; DetailType: string; Detail: string }>,
  insertFailsWith: null as Error | null,
  publishFailsAt: null as number | null,
  publishCount: 0,
};
vi.mock('../src/persist.js', async () => {
  const actual = await vi.importActual<typeof import('../src/persist.js')>(
    '../src/persist.js',
  );
  return {
    deterministicCaptureId: actual.deterministicCaptureId,
    findPriorOkRun: vi.fn(async (captureId: string) =>
      persistState.priorOk.has(captureId),
    ),
    insertAgentRun: vi.fn(async (row: { ownerId: string; captureId: string; status: string }) => {
      if (persistState.insertFailsWith) throw persistState.insertFailsWith;
      const id = `run-${persistState.inserted.length}`;
      persistState.inserted.push(row);
      return id;
    }),
    updateAgentRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      persistState.updated.push({ id, patch });
    }),
    publishDiscordCapture: vi.fn(async (detail: Record<string, unknown>) => {
      persistState.publishCount++;
      if (
        persistState.publishFailsAt !== null &&
        persistState.publishCount > persistState.publishFailsAt
      ) {
        throw new Error(`synthetic publish failure on call ${persistState.publishCount}`);
      }
      persistState.emitted.push({
        Source: 'kos.capture-discord-brain-dump',
        DetailType: 'capture.received',
        Detail: JSON.stringify(detail),
      });
    }),
    __resetForTests: vi.fn(),
    __setPoolForTests: vi.fn(),
    __setEbForTests: vi.fn(),
    getPool: actual.getPool,
  };
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const CHANNEL = '9876543210987654321';

function fakeMsg(id: string, content = `body-${id}`): {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
} {
  return {
    id,
    channel_id: CHANNEL,
    author: { id: '5555555555555555555', username: 'kevin', bot: false },
    content,
    timestamp: '2026-04-25T08:42:13.000+00:00',
  };
}

beforeEach(() => {
  cursorState.current = null;
  cursorState.setCalls = [];
  discordState.messages = [];
  discordState.throwError = null;
  persistState.priorOk = new Set();
  persistState.inserted = [];
  persistState.updated = [];
  persistState.emitted = [];
  persistState.insertFailsWith = null;
  persistState.publishFailsAt = null;
  persistState.publishCount = 0;

  process.env.AWS_REGION = 'eu-north-1';
  process.env.KOS_CAPTURE_BUS_NAME = 'kos.capture';
  process.env.DISCORD_BRAIN_DUMP_CHANNEL_ID = CHANNEL;
  process.env.DISCORD_BOT_TOKEN = 'BOT_TOKEN_INLINE';
  process.env.KEVIN_OWNER_ID = OWNER;
  delete process.env.DISCORD_BOT_TOKEN_SECRET_ARN;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discord-brain-dump handler', () => {
  it('returns zero processed when no new messages and cursor is warm', async () => {
    cursorState.current = 'warm-cursor-id';
    discordState.messages = [];

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number; cursor_after: string | null; cold_start_seeded: boolean }>)({
      channel: 'brain-dump',
      owner_id: OWNER,
      trigger_source: 'kos-discord-poll-scheduler',
    }));

    expect(result.processed).toBe(0);
    expect(persistState.emitted).toHaveLength(0);
    expect(result.cursor_after).toBe('warm-cursor-id');
    expect(cursorState.setCalls).toHaveLength(0);
    expect(result.cold_start_seeded).toBe(false);
  });

  it('cold-start (cursor=null) + N msgs → seeds cursor with newest id, emits zero', async () => {
    cursorState.current = null;
    discordState.messages = [fakeMsg('100'), fakeMsg('200'), fakeMsg('300')];

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number; cursor_after: string | null; cold_start_seeded: boolean }>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    }));

    expect(result.cold_start_seeded).toBe(true);
    expect(result.processed).toBe(0);
    expect(persistState.emitted).toHaveLength(0);
    expect(result.cursor_after).toBe('300');
    expect(cursorState.setCalls).toEqual([{ channelId: CHANNEL, messageId: '300' }]);
  });

  it('happy path: warm cursor + 2 msgs → emits 2, cursor advances per-msg', async () => {
    cursorState.current = '050';
    discordState.messages = [fakeMsg('100', 'almi loan'), fakeMsg('200', 'damien followup')];

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number; cursor_after: string | null }>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    }));

    expect(result.processed).toBe(2);
    expect(persistState.emitted).toHaveLength(2);
    // Cursor advances message-by-message (last call = newest id).
    expect(cursorState.setCalls.map((c) => c.messageId)).toEqual(['100', '200']);
    expect(result.cursor_after).toBe('200');

    // Each emit validates against CaptureReceivedDiscordTextSchema (handler does the parse).
    for (const ev of persistState.emitted) {
      expect(ev.Source).toBe('kos.capture-discord-brain-dump');
      expect(ev.DetailType).toBe('capture.received');
      const detail = JSON.parse(ev.Detail);
      expect(detail.channel).toBe('discord');
      expect(detail.kind).toBe('discord_text');
      expect(detail.channel_id).toBe(CHANNEL);
      expect(detail.message_id).toBeDefined();
      expect(detail.body).toBeDefined();
      expect(detail.author.id).toBeDefined();
      // capture_id is 26-char Crockford ULID-shape.
      expect(detail.capture_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it('deterministic capture_id: same (channel, message) → same id across runs', async () => {
    cursorState.current = '050';
    discordState.messages = [fakeMsg('100')];
    const { handler } = await import('../src/handler.js');

    await (handler as unknown as (e: unknown) => Promise<unknown>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    });
    const id1 = JSON.parse(persistState.emitted[0]!.Detail).capture_id;

    // Reset emit log + cursor to repeat the same input.
    persistState.emitted = [];
    persistState.publishCount = 0;
    cursorState.current = '050';

    await (handler as unknown as (e: unknown) => Promise<unknown>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    });
    const id2 = JSON.parse(persistState.emitted[0]!.Detail).capture_id;

    expect(id1).toBe(id2);
  });

  it('agent_runs idempotency: prior ok row → skipped, but cursor still advances', async () => {
    cursorState.current = '050';
    discordState.messages = [fakeMsg('100'), fakeMsg('200')];

    // Compute the deterministic capture_id for msg '100' and pre-populate
    // priorOk so the handler skips that one.
    const persist = await import('../src/persist.js');
    const id100 = persist.deterministicCaptureId(CHANNEL, '100');
    persistState.priorOk.add(id100);

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number; skipped: number; cursor_after: string | null }>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    }));

    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(1);
    expect(persistState.emitted).toHaveLength(1);
    // Cursor still walked through both ids (skipped one too).
    expect(cursorState.setCalls.map((c) => c.messageId)).toEqual(['100', '200']);
    expect(result.cursor_after).toBe('200');
  });

  it('Discord 401 → exit success with errors=1, cursor unchanged', async () => {
    cursorState.current = 'before';
    const { DiscordAuthError } = await import('../src/discord.js');
    discordState.throwError = new DiscordAuthError(401, 'token revoked');

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number; errors: number; cursor_after: string | null }>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    }));

    expect(result.errors).toBe(1);
    expect(result.processed).toBe(0);
    expect(result.cursor_after).toBe('before');
    expect(cursorState.setCalls).toHaveLength(0);
  });

  it('Discord 429 → exit success with errors=1, cursor unchanged', async () => {
    cursorState.current = 'before-429';
    const { DiscordRateLimitError } = await import('../src/discord.js');
    discordState.throwError = new DiscordRateLimitError(2_000);

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number; errors: number; cursor_after: string | null }>)({
      channel: 'brain-dump',
      owner_id: OWNER,
    }));

    expect(result.errors).toBe(1);
    expect(result.cursor_after).toBe('before-429');
    expect(cursorState.setCalls).toHaveLength(0);
  });

  it('Discord 5xx (transient) → handler throws so Lambda fails + Scheduler retries', async () => {
    cursorState.current = 'before-5xx';
    const { DiscordTransientError } = await import('../src/discord.js');
    discordState.throwError = new DiscordTransientError(503, 'upstream');

    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)({
        channel: 'brain-dump',
        owner_id: OWNER,
      }),
    ).rejects.toBeInstanceOf(DiscordTransientError);
    expect(cursorState.setCalls).toHaveLength(0);
  });

  it('per-message publish failure: cursor advances to last successful id, then rethrows', async () => {
    cursorState.current = '050';
    discordState.messages = [fakeMsg('100'), fakeMsg('200'), fakeMsg('300')];
    persistState.publishFailsAt = 1; // first emit succeeds, second throws

    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)({
        channel: 'brain-dump',
        owner_id: OWNER,
      }),
    ).rejects.toThrow(/synthetic publish failure/);

    // First message succeeded → cursor at '100'. Second failed → loop break.
    // Third never attempted.
    expect(cursorState.setCalls.map((c) => c.messageId)).toEqual(['100']);
    expect(persistState.emitted).toHaveLength(1);
  });

  it('falls back to KEVIN_OWNER_ID env when input lacks owner_id (manual invoke)', async () => {
    cursorState.current = 'warm';
    discordState.messages = [fakeMsg('100')];
    process.env.KEVIN_OWNER_ID = OWNER;

    const { handler } = await import('../src/handler.js');
    // Empty event — Scheduler retry on a misconfigured rule could deliver this.
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number }>)({}));
    expect(result.processed).toBe(1);
    expect(persistState.inserted[0]!.ownerId).toBe(OWNER);
  });

  it('throws if neither input nor env supplies owner_id', async () => {
    delete process.env.KEVIN_OWNER_ID;
    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)({}),
    ).rejects.toThrow(/owner_id/);
  });

  it('throws if DISCORD_BRAIN_DUMP_CHANNEL_ID env is missing', async () => {
    delete process.env.DISCORD_BRAIN_DUMP_CHANNEL_ID;
    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)({
        channel: 'brain-dump',
        owner_id: OWNER,
      }),
    ).rejects.toThrow(/DISCORD_BRAIN_DUMP_CHANNEL_ID/);
  });

  it('accepts the legacy MigrationStack input shape { owner_id, channel_ids }', async () => {
    cursorState.current = 'warm';
    discordState.messages = [fakeMsg('100')];

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<{ processed: number }>)({
      owner_id: OWNER,
      channel_ids: [CHANNEL],
    }));
    expect(result.processed).toBe(1);
  });
});
