/**
 * Phase 7 Plan 07-02 Task 1 — day-close handler integration unit tests.
 *
 * All AWS / Anthropic / Notion / pg deps mocked. Tests:
 *   - Happy path: idempotent INSERT → loadContext → Sonnet → Notion 🏠 Today
 *     replace + Daily Brief Log append + Kevin Context append → Telegram emit.
 *   - Kevin Context append failure: handler logs (Sentry) but Telegram still
 *     fires; agent_runs records partial outcome.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const insertAgentRunStartedMock = vi.fn();
const updateAgentRunSuccessMock = vi.fn();
const updateAgentRunErrorMock = vi.fn();
const writeTop3MembershipMock = vi.fn();
const loadSlippedItemsForTodayMock = vi.fn();
const loadDecisionsHintMock = vi.fn();
const loadHotEntitiesMock = vi.fn();
const getPoolMock = vi.fn(async () => ({}) as never);
vi.mock('../src/persist.js', () => ({
  getPool: getPoolMock,
  insertAgentRunStarted: insertAgentRunStartedMock,
  updateAgentRunSuccess: updateAgentRunSuccessMock,
  updateAgentRunError: updateAgentRunErrorMock,
  writeTop3Membership: writeTop3MembershipMock,
  loadSlippedItemsForToday: loadSlippedItemsForTodayMock,
  loadDecisionsHint: loadDecisionsHintMock,
  loadHotEntities: loadHotEntitiesMock,
}));

const replaceTodayPageBlocksMock = vi.fn();
const appendDailyBriefLogPageMock = vi.fn();
const appendKevinContextSectionsMock = vi.fn();
vi.mock('../src/notion.js', () => ({
  replaceTodayPageBlocks: replaceTodayPageBlocksMock,
  appendDailyBriefLogPage: appendDailyBriefLogPageMock,
  appendKevinContextSections: appendKevinContextSectionsMock,
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
  prose_summary: 'Lugn dag.',
  top_three: [
    { title: 'Damien · Almi follow-up', entity_ids: [A_UUID], urgency: 'high' },
  ],
  dropped_threads: [],
  slipped_items: [
    { title: 'TaleForge investor reply', entity_ids: [A_UUID], reason: 'no email sent' },
  ],
  recent_decisions: ['Approved Almi convertible terms'],
  active_threads_delta: [{ thread: 'TaleForge → Speed', status: 'updated' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  insertAgentRunStartedMock.mockResolvedValue(true);
  loadHotEntitiesMock.mockResolvedValue([
    { entity_id: A_UUID, name: 'Damien', mention_count: 8 },
  ]);
  loadSlippedItemsForTodayMock.mockResolvedValue([
    { entity_id: A_UUID, title: 'TaleForge investor reply', urgency: 'med' },
  ]);
  loadDecisionsHintMock.mockResolvedValue([
    { occurred_at: '2026-04-25T09:32:00Z', context: 'Approved Almi convertible terms' },
  ]);
  loadContextMock.mockResolvedValue({
    kevin_context: {
      current_priorities: '',
      active_deals: '',
      whos_who: '',
      blocked_on: '',
      recent_decisions: '',
      open_questions: '',
      last_updated: null,
    },
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
      { type: 'tool_use', name: 'record_day_close_brief', input: VALID_BRIEF },
    ],
    usage: { input_tokens: 1000, output_tokens: 500 },
  });
  ebSend.mockResolvedValue({});
  replaceTodayPageBlocksMock.mockResolvedValue({ archivedCount: 5, appendedCount: 12 });
  appendDailyBriefLogPageMock.mockResolvedValue({ pageId: 'page-1' });
  appendKevinContextSectionsMock.mockResolvedValue(undefined);
  writeTop3MembershipMock.mockResolvedValue(undefined);
  updateAgentRunSuccessMock.mockResolvedValue(undefined);
  updateAgentRunErrorMock.mockResolvedValue(undefined);

  process.env.KEVIN_OWNER_ID = 'owner-test';
  process.env.NOTION_TODAY_PAGE_ID = 'today-page-id';
  process.env.NOTION_DAILY_BRIEF_LOG_DB_ID = 'daily-log-db-id';
  process.env.NOTION_KEVIN_CONTEXT_PAGE_ID = 'kevin-context-page-id';
});

describe('day-close handler', () => {
  it('happy path: idempotent INSERT → Sonnet → Kevin Context append → Notion + Telegram emit', async () => {
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});
    expect(result).toMatchObject({ top3_count: 1 });
    expect(bedrockCreate).toHaveBeenCalledTimes(1);
    expect(writeTop3MembershipMock).toHaveBeenCalledTimes(1);
    expect(replaceTodayPageBlocksMock).toHaveBeenCalledTimes(1);
    expect(appendDailyBriefLogPageMock).toHaveBeenCalledTimes(1);
    expect(appendKevinContextSectionsMock).toHaveBeenCalledTimes(1);

    // Kevin Context append received Recent decisions + Slipped items.
    const ctxCall = appendKevinContextSectionsMock.mock.calls[0]!;
    expect(ctxCall[0]).toBe('kevin-context-page-id');
    const ctxArgs = ctxCall[1] as { recentDecisions: string[]; slippedItems: any[] };
    expect(ctxArgs.recentDecisions).toEqual(['Approved Almi convertible terms']);
    expect(ctxArgs.slippedItems).toHaveLength(1);

    // Exactly one output.push to kos.output.
    const outputPushCalls = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as any).input?.Entries ?? [];
      return entries.some(
        (e: any) => e.EventBusName === 'kos.output' && e.DetailType === 'output.push',
      );
    });
    expect(outputPushCalls).toHaveLength(1);
    expect(updateAgentRunSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('Kevin Context append fails → Telegram still fires; result reflects rejection', async () => {
    appendKevinContextSectionsMock.mockRejectedValueOnce(new Error('Notion 429'));
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    // top3_membership written first (durable side); Telegram still emitted.
    expect(writeTop3MembershipMock).toHaveBeenCalledTimes(1);
    const outputPushCalls = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as any).input?.Entries ?? [];
      return entries.some(
        (e: any) => e.EventBusName === 'kos.output' && e.DetailType === 'output.push',
      );
    });
    expect(outputPushCalls).toHaveLength(1);
    expect((result as any).kevin_context_status).toBe('rejected');
    expect((result as any).notion_today_status).toBe('fulfilled');
  });
});
