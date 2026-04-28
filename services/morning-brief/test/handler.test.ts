/**
 * Phase 7 Plan 07-01 Task 2 — handler integration unit tests.
 *
 * All AWS / Anthropic / Notion / pg dependencies are mocked. Tests verify:
 *   - Happy path emits exactly one output.push event + writes top3_membership
 *     + closes agent_runs status='ok'.
 *   - Idempotency short-circuit when prior ok run exists (no Bedrock call).
 *   - Bedrock failure: agent_runs error path + kos.system failure event +
 *     handler returns { status: 'error' } without throwing.
 *   - Notion write failure: handler logs but still emits Telegram + agent_runs
 *     records partial outcome.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks (must be hoisted before importing the handler) ----------------

const ebSend = vi.fn();
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = ebSend;
  },
  PutEventsCommand: class PutEventsCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const bedrockCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: class AnthropicBedrock {
    messages = { create: bedrockCreate };
  },
}));

const loadHotEntitiesMock = vi.fn();
vi.mock('../src/hot-entities.js', () => ({
  loadHotEntities: loadHotEntitiesMock,
}));

const insertAgentRunStartedMock = vi.fn();
const updateAgentRunSuccessMock = vi.fn();
const updateAgentRunErrorMock = vi.fn();
const writeTop3MembershipMock = vi.fn();
const loadDraftsReadyMock = vi.fn();
const loadDroppedThreadsMock = vi.fn();
const getPoolMock = vi.fn(async () => ({}) as never);
vi.mock('../src/persist.js', () => ({
  getPool: getPoolMock,
  insertAgentRunStarted: insertAgentRunStartedMock,
  updateAgentRunSuccess: updateAgentRunSuccessMock,
  updateAgentRunError: updateAgentRunErrorMock,
  writeTop3Membership: writeTop3MembershipMock,
  loadDraftsReady: loadDraftsReadyMock,
  loadDroppedThreads: loadDroppedThreadsMock,
}));

const replaceTodayPageBlocksMock = vi.fn();
const appendDailyBriefLogPageMock = vi.fn();
vi.mock('../src/notion.js', () => ({
  replaceTodayPageBlocks: replaceTodayPageBlocksMock,
  appendDailyBriefLogPage: appendDailyBriefLogPageMock,
}));

const loadContextMock = vi.fn();
vi.mock('@kos/context-loader', () => ({
  loadContext: loadContextMock,
  loadKevinContextMarkdown: vi.fn(async () => ''),
}));

const hybridQueryMock = vi.fn();
vi.mock('@kos/azure-search', () => ({
  hybridQuery: hybridQueryMock,
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => undefined),
  wrapHandler: <T extends (...args: any[]) => any>(fn: T) => fn,
}));

vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => undefined),
  flush: vi.fn(async () => undefined),
  tagTraceWithCaptureId: vi.fn(),
}));

const A_UUID = '11111111-2222-4333-8444-555555555555';

const VALID_BRIEF = {
  prose_summary: 'Lugn morgon.',
  top_three: [
    { title: 'Damien · Almi follow-up', entity_ids: [A_UUID], urgency: 'high' },
  ],
  dropped_threads: [],
  calendar_today: [],
  calendar_tomorrow: [],
  drafts_ready: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default success scaffolding.
  insertAgentRunStartedMock.mockResolvedValue(true);
  loadHotEntitiesMock.mockResolvedValue([
    { entity_id: A_UUID, name: 'Damien', mention_count: 12 },
  ]);
  loadDraftsReadyMock.mockResolvedValue([]);
  loadDroppedThreadsMock.mockResolvedValue([]);
  loadContextMock.mockResolvedValue({
    kevin_context: { current_priorities: '', active_deals: '', whos_who: '', blocked_on: '', recent_decisions: '', open_questions: '', last_updated: null },
    entity_dossiers: [],
    recent_mentions: [],
    semantic_chunks: [],
    linked_projects: [],
    assembled_markdown: '## Damien\nAlmi PM',
    elapsed_ms: 100,
    cache_hit: false,
    partial: false,
    partial_reasons: [],
  });
  bedrockCreate.mockResolvedValue({
    content: [
      { type: 'tool_use', name: 'record_morning_brief', input: VALID_BRIEF },
    ],
    usage: { input_tokens: 1000, output_tokens: 500 },
  });
  ebSend.mockResolvedValue({});
  replaceTodayPageBlocksMock.mockResolvedValue({ archivedCount: 5, appendedCount: 12 });
  appendDailyBriefLogPageMock.mockResolvedValue({ pageId: 'page-1' });
  writeTop3MembershipMock.mockResolvedValue(undefined);
  updateAgentRunSuccessMock.mockResolvedValue(undefined);
  updateAgentRunErrorMock.mockResolvedValue(undefined);

  process.env.KEVIN_OWNER_ID = 'owner-test';
  process.env.NOTION_TODAY_PAGE_ID = 'today-page-id';
  process.env.NOTION_DAILY_BRIEF_LOG_DB_ID = 'daily-log-db-id';
});

describe('morning-brief handler', () => {
  it('happy path: invokes Bedrock once, writes top3_membership, emits ONE output.push, agent_runs ok', async () => {
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});
    expect(result).toMatchObject({ top3_count: 1 });
    expect(bedrockCreate).toHaveBeenCalledTimes(1);
    expect(writeTop3MembershipMock).toHaveBeenCalledTimes(1);
    expect(replaceTodayPageBlocksMock).toHaveBeenCalledTimes(1);
    expect(appendDailyBriefLogPageMock).toHaveBeenCalledTimes(1);

    // Exactly one output.push to kos.output bus + agent_runs success.
    const outputPushCalls = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as any).input?.Entries ?? [];
      return entries.some(
        (e: any) => e.EventBusName === 'kos.output' && e.DetailType === 'output.push',
      );
    });
    expect(outputPushCalls).toHaveLength(1);
    expect(updateAgentRunSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('forwards telegram.chat_id on output.push when KEVIN_TELEGRAM_CHAT_ID env is set (fix 2026-04-28)', async () => {
    const prev = process.env.KEVIN_TELEGRAM_CHAT_ID;
    process.env.KEVIN_TELEGRAM_CHAT_ID = '165422223669067780';
    try {
      const { handler } = await import('../src/handler.js');
      await (handler as unknown as (e: unknown) => Promise<unknown>)({});
      const outputPushCall = ebSend.mock.calls.find((c) => {
        const entries = (c[0] as any).input?.Entries ?? [];
        return entries.some(
          (e: any) => e.DetailType === 'output.push',
        );
      });
      expect(outputPushCall).toBeDefined();
      const entry = (outputPushCall![0] as any).input.Entries.find(
        (e: any) => e.DetailType === 'output.push',
      );
      const detail = JSON.parse(entry.Detail);
      expect(detail.telegram).toEqual({
        chat_id: 165422223669067780,
      });
    } finally {
      if (prev === undefined) delete process.env.KEVIN_TELEGRAM_CHAT_ID;
      else process.env.KEVIN_TELEGRAM_CHAT_ID = prev;
    }
  });

  it('omits telegram field on output.push when KEVIN_TELEGRAM_CHAT_ID is unset (legacy path)', async () => {
    const prev = process.env.KEVIN_TELEGRAM_CHAT_ID;
    delete process.env.KEVIN_TELEGRAM_CHAT_ID;
    try {
      const { handler } = await import('../src/handler.js');
      await (handler as unknown as (e: unknown) => Promise<unknown>)({});
      const outputPushCall = ebSend.mock.calls.find((c) => {
        const entries = (c[0] as any).input?.Entries ?? [];
        return entries.some(
          (e: any) => e.DetailType === 'output.push',
        );
      });
      expect(outputPushCall).toBeDefined();
      const entry = (outputPushCall![0] as any).input.Entries.find(
        (e: any) => e.DetailType === 'output.push',
      );
      const detail = JSON.parse(entry.Detail);
      expect(detail.telegram).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.KEVIN_TELEGRAM_CHAT_ID = prev;
    }
  });

  it('idempotent: insertAgentRunStarted returns false → no Bedrock call, returns { skipped: duplicate }', async () => {
    insertAgentRunStartedMock.mockResolvedValueOnce(false);
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});
    expect(result).toEqual({ skipped: 'duplicate' });
    expect(bedrockCreate).not.toHaveBeenCalled();
    expect(writeTop3MembershipMock).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
  });

  it('Bedrock throws → agent_runs error + kos.system brief.generation_failed + returns { status: error }', async () => {
    bedrockCreate.mockReset();
    bedrockCreate.mockRejectedValueOnce(new Error('bedrock unavailable'));
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});
    expect((result as any).status).toBe('error');
    expect(updateAgentRunErrorMock).toHaveBeenCalledTimes(1);

    // Check a kos.system / brief.generation_failed event was emitted.
    const systemFailureCalls = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as any).input?.Entries ?? [];
      return entries.some(
        (e: any) =>
          e.EventBusName === 'kos.system' && e.DetailType === 'brief.generation_failed',
      );
    });
    expect(systemFailureCalls).toHaveLength(1);
  });

  it('Notion today write failure: agent_runs error path; Telegram still attempted (best-effort)', async () => {
    replaceTodayPageBlocksMock.mockRejectedValueOnce(new Error('Notion 429'));
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});
    // Promise.allSettled means notion-fail is captured but pipeline continues.
    // top3_membership written before Notion (durable side); Telegram emitted.
    expect(writeTop3MembershipMock).toHaveBeenCalledTimes(1);
    const outputPushCalls = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as any).input?.Entries ?? [];
      return entries.some(
        (e: any) => e.EventBusName === 'kos.output' && e.DetailType === 'output.push',
      );
    });
    expect(outputPushCalls).toHaveLength(1);
    expect((result as any).notion_today_status).toBe('rejected');
    expect((result as any).notion_log_status).toBe('fulfilled');
  });
});
