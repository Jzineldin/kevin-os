/**
 * Phase 7 Plan 07-02 Task 2 — weekly-review handler integration unit tests.
 *
 * All AWS / Anthropic / Notion / pg deps mocked. Tests:
 *   - Happy path: idempotent INSERT → loadContext (7-day) → Sonnet →
 *     replaceActiveThreadsSection → Daily Brief Log append → Telegram emit.
 *   - replaceActiveThreadsSection failure → Telegram still fires; result
 *     reflects rejection.
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
const loadHotEntitiesMock = vi.fn();
const loadWeekRecapHintMock = vi.fn();
const getPoolMock = vi.fn(async () => ({}) as never);
vi.mock('../src/persist.js', () => ({
  getPool: getPoolMock,
  insertAgentRunStarted: insertAgentRunStartedMock,
  updateAgentRunSuccess: updateAgentRunSuccessMock,
  updateAgentRunError: updateAgentRunErrorMock,
  loadHotEntities: loadHotEntitiesMock,
  loadWeekRecapHint: loadWeekRecapHintMock,
}));

const replaceActiveThreadsSectionMock = vi.fn();
const appendDailyBriefLogPageMock = vi.fn();
vi.mock('../src/notion.js', () => ({
  replaceActiveThreadsSection: replaceActiveThreadsSectionMock,
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

const VALID_REVIEW = {
  prose_summary: 'En produktiv vecka.',
  week_recap: ['Almi convertible signerat', 'TaleForge MAU 5k'],
  next_week_candidates: [
    { title: 'Outbehaving demo', why: 'investor pitch klar mån' },
  ],
  active_threads_snapshot: [
    { thread: 'Almi convertible', where: 'almi', status: 'signed' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  insertAgentRunStartedMock.mockResolvedValue(true);
  loadHotEntitiesMock.mockResolvedValue([
    { entity_id: A_UUID, name: 'Damien', mention_count: 22 },
  ]);
  loadWeekRecapHintMock.mockResolvedValue([
    { kind: 'mentions', n: 142 },
    { kind: 'emails', n: 87 },
    { kind: 'morning_briefs', n: 5 },
    { kind: 'day_closes', n: 5 },
  ]);
  loadContextMock.mockResolvedValue({
    kevin_context: {
      current_priorities: '',
      active_deals: 'Almi convertible',
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
      { type: 'tool_use', name: 'record_weekly_review', input: VALID_REVIEW },
    ],
    usage: { input_tokens: 1500, output_tokens: 700 },
  });
  ebSend.mockResolvedValue({});
  replaceActiveThreadsSectionMock.mockResolvedValue(undefined);
  appendDailyBriefLogPageMock.mockResolvedValue({ pageId: 'page-1' });
  updateAgentRunSuccessMock.mockResolvedValue(undefined);
  updateAgentRunErrorMock.mockResolvedValue(undefined);

  process.env.KEVIN_OWNER_ID = 'owner-test';
  process.env.NOTION_DAILY_BRIEF_LOG_DB_ID = 'daily-log-db-id';
  process.env.NOTION_KEVIN_CONTEXT_PAGE_ID = 'kevin-context-page-id';
});

describe('weekly-review handler', () => {
  it('happy path: idempotent INSERT → Sonnet → Active Threads replace → Daily Brief Log append → Telegram emit', async () => {
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});
    expect(result).toMatchObject({ week_recap_count: 2 });
    expect(bedrockCreate).toHaveBeenCalledTimes(1);
    expect(replaceActiveThreadsSectionMock).toHaveBeenCalledTimes(1);
    expect(appendDailyBriefLogPageMock).toHaveBeenCalledTimes(1);

    // replaceActiveThreadsSection received the snapshot from VALID_REVIEW.
    const args = replaceActiveThreadsSectionMock.mock.calls[0]!;
    expect(args[0]).toBe('kevin-context-page-id');
    expect(args[1]).toEqual(VALID_REVIEW.active_threads_snapshot);

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

  it('replaceActiveThreadsSection fails → Telegram still fires; result reflects rejection', async () => {
    replaceActiveThreadsSectionMock.mockRejectedValueOnce(new Error('Notion 429'));
    const { handler } = await import('../src/handler.js');
    const result = await (handler as unknown as (e: unknown) => Promise<unknown>)({});

    const outputPushCalls = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as any).input?.Entries ?? [];
      return entries.some(
        (e: any) => e.EventBusName === 'kos.output' && e.DetailType === 'output.push',
      );
    });
    expect(outputPushCalls).toHaveLength(1);
    expect((result as any).active_threads_status).toBe('rejected');
    expect((result as any).notion_log_status).toBe('fulfilled');
  });
});
