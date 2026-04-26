/**
 * content-writer-platform Map worker handler tests (Plan 08-02 Task 2 — 6 tests).
 *
 *   1. Map input → runContentWriterAgent → content_drafts INSERT.
 *   2. loadContext invoked with includeCalendar=false (encoded as omitted/false).
 *   3. Idempotency: second invocation for same (topic_id, platform) → returns
 *      same draft_id, no duplicate INSERT (UPSERT contract verified upstream
 *      in persist.ts; this test asserts the handler returns the persist
 *      result unchanged).
 *   4. Agent error → markDraftFailed called with the error string + rethrown.
 *   5. BRAND_VOICE.md human_verification=false → fail-closed; no Bedrock; no DB.
 *   6. Returns { draft_id, platform, topic_id, status } to Step Functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (declared BEFORE handler import) ---

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

const brandVoiceState = { value: '# voice', shouldThrow: false };
vi.mock('../src/brand-voice.js', () => ({
  getBrandVoice: vi.fn(() => {
    if (brandVoiceState.shouldThrow) {
      throw new Error('BRAND_VOICE.md has human_verification: false');
    }
    return brandVoiceState.value;
  }),
}));

const persistState = {
  draftId: '00000000-0000-4000-8000-000000000099',
  insertCount: 0,
  failedCount: 0,
  lastFailedArgs: null as unknown,
};
vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  insertContentDraft: vi.fn(async () => {
    persistState.insertCount += 1;
    return { draft_id: persistState.draftId, status: 'draft' };
  }),
  markDraftFailed: vi.fn(async (_pool: unknown, args: unknown) => {
    persistState.failedCount += 1;
    persistState.lastFailedArgs = args;
  }),
}));

const agentMock = vi.fn();
vi.mock('../src/agent.js', () => ({
  runContentWriterAgent: agentMock,
}));

const loadContextMock = vi.fn();
vi.mock('@kos/context-loader', () => ({
  loadContext: loadContextMock,
  loadKevinContextBlock: vi.fn(),
  loadKevinContextMarkdown: vi.fn(),
}));

const VALID_TOPIC = '01HZ0000000000000000000ABC';
const VALID_CAPTURE = '01HZ0000000000000000000DEF';

function makeMapItem(overrides: Record<string, unknown> = {}) {
  return {
    topic_id: VALID_TOPIC,
    capture_id: VALID_CAPTURE,
    topic_text: 'Tale Forge launched today',
    platform: 'instagram',
    ...overrides,
  };
}

describe('content-writer-platform handler', () => {
  beforeEach(() => {
    agentMock.mockReset();
    loadContextMock.mockReset();
    persistState.insertCount = 0;
    persistState.failedCount = 0;
    persistState.lastFailedArgs = null;
    brandVoiceState.value = '# voice body';
    brandVoiceState.shouldThrow = false;
    process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
    process.env.AWS_REGION = 'eu-north-1';

    // Default: loadContext returns a small bundle.
    loadContextMock.mockResolvedValue({
      kevin_context: {
        current_priorities: 'Ship Tale Forge v1',
        active_deals: 'Almi convertible note',
      },
      assembled_markdown: '## Dossier\nDamien at Almi',
      cache_hit: false,
      partial: false,
      partial_reasons: [],
    });
  });

  it('1. Map input → runContentWriterAgent + insertContentDraft', async () => {
    agentMock.mockResolvedValueOnce({
      output: { content: 'caption body', media_urls: [], reasoning_one_line: 'r' },
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (i: unknown) => Promise<unknown>)(
      makeMapItem(),
    )) as { draft_id: string; platform: string; topic_id: string };
    expect(agentMock).toHaveBeenCalledTimes(1);
    expect(persistState.insertCount).toBe(1);
    expect(r.draft_id).toBe(persistState.draftId);
    expect(r.platform).toBe('instagram');
    expect(r.topic_id).toBe(VALID_TOPIC);
  });

  it('2. loadContext called WITHOUT includeCalendar (calendar context excluded for content)', async () => {
    agentMock.mockResolvedValueOnce({
      output: { content: 'caption', media_urls: [], reasoning_one_line: 'r' },
      usage: {},
    });
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (i: unknown) => Promise<unknown>)(makeMapItem());
    expect(loadContextMock).toHaveBeenCalledTimes(1);
    const call = loadContextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agentName).toBe('content-writer-platform');
    expect(call.rawText).toBe('Tale Forge launched today');
    expect(call.entityIds).toEqual([]);
    // includeCalendar is either explicitly undefined or false; never true.
    expect(call.includeCalendar).not.toBe(true);
  });

  it('3. idempotency: handler returns the persist result for the same (topic_id, platform)', async () => {
    agentMock.mockResolvedValue({
      output: { content: 'a', media_urls: [], reasoning_one_line: 'r' },
      usage: {},
    });
    const { handler } = await import('../src/handler.js');
    const r1 = (await (handler as unknown as (i: unknown) => Promise<unknown>)(
      makeMapItem(),
    )) as { draft_id: string };
    const r2 = (await (handler as unknown as (i: unknown) => Promise<unknown>)(
      makeMapItem(),
    )) as { draft_id: string };
    expect(r1.draft_id).toBe(r2.draft_id); // UPSERT contract simulated by mock
    expect(persistState.insertCount).toBe(2); // each call hits the UPSERT once
  });

  it('4. agent error → markDraftFailed + rethrow', async () => {
    agentMock.mockRejectedValueOnce(new Error('Bedrock timeout'));
    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (i: unknown) => Promise<unknown>)(makeMapItem()),
    ).rejects.toThrow(/Bedrock timeout/);
    expect(persistState.failedCount).toBe(1);
    const failArgs = persistState.lastFailedArgs as { error: string; topicId: string };
    expect(failArgs.topicId).toBe(VALID_TOPIC);
    expect(failArgs.error).toContain('Bedrock timeout');
  });

  it('5. BRAND_VOICE.md human_verification=false → throws fail-closed; no agent call; no DB write', async () => {
    brandVoiceState.shouldThrow = true;
    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (i: unknown) => Promise<unknown>)(makeMapItem()),
    ).rejects.toThrow(/human_verification: false/);
    expect(agentMock).not.toHaveBeenCalled();
    expect(persistState.insertCount).toBe(0);
    // markDraftFailed is also NOT called — the brand-voice gate fires
    // BEFORE the inner try/catch that wraps Bedrock + DB writes.
    expect(persistState.failedCount).toBe(0);
  });

  it('6. returns { draft_id, platform, topic_id, status } to Step Functions', async () => {
    agentMock.mockResolvedValueOnce({
      output: { content: 'caption', media_urls: [], reasoning_one_line: 'r' },
      usage: {},
    });
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (i: unknown) => Promise<unknown>)(
      makeMapItem({ platform: 'linkedin' }),
    )) as { draft_id: string; platform: string; topic_id: string; status: string };
    expect(r).toEqual({
      draft_id: persistState.draftId,
      platform: 'linkedin',
      topic_id: VALID_TOPIC,
      status: 'draft',
    });
  });
});
