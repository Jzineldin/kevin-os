/**
 * Voice-capture handler unit tests (Plan 02-04 Task 2).
 *
 * Two behavioural tests:
 *   - happy path: writes Notion row, emits entity.mention.detected +
 *     output.push (is_reply=true)
 *   - D-21 idempotency: prior ok run → no calls
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

const pgState = { prior: false };
vi.mock('../src/persist.js', () => ({
  findPriorOkRun: vi.fn(async () => pgState.prior),
  insertAgentRun: vi.fn(async () => 'run-1'),
  updateAgentRun: vi.fn(async () => {}),
  loadKevinContextBlock: vi.fn(async () => '## ctx'),
}));

vi.mock('../src/notion.js', () => ({
  writeCommandCenterRow: vi.fn(async () => 'notion-page-abc'),
}));

vi.mock('../src/agent.js', () => ({
  runVoiceCaptureAgent: vi.fn(async () => ({
    output: {
      title: 'Ping Damien om convertible loan',
      type: 'task',
      urgency: 'med',
      body: 'Ping Damien om convertible loan detaljerna',
      project_hint: null,
      candidate_entities: [
        {
          mention_text: 'Damien',
          candidate_type: 'Person',
          context_snippet: 'convertible loan',
        },
      ],
    },
    usage: { inputTokens: 300, outputTokens: 80 },
  })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

const ULID = '01HABCDEFGHJKMNPQRSTVWXYZ0';

describe('voice-capture handler', () => {
  beforeEach(() => {
    ebSend.mockClear();
    pgState.prior = false;
    process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
  });

  const baseEvent = {
    detail: {
      capture_id: ULID,
      source_kind: 'voice',
      source_text: 'Ping Damien om convertible loan detaljerna',
      route: 'voice-capture',
      detected_type: 'task',
      urgency: 'med',
      reason: 'task',
      sender: { id: 1 },
      telegram: { chat_id: 1, message_id: 1 },
      routed_at: new Date().toISOString(),
    },
  };

  it('happy path: writes Notion row, emits entity.mention.detected + output.push (is_reply=true)', async () => {
    const { handler } = await import('../src/handler.js');
    const res = await (handler as unknown as (e: unknown) => Promise<unknown>)(
      baseEvent,
    );
    expect((res as { notion_page_id: string }).notion_page_id).toBe('notion-page-abc');

    const mentionCall = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('entity.mention.detected'),
    );
    expect(mentionCall).toBeDefined();
    const mentionDetail = JSON.parse(
      (mentionCall as unknown as [{ input: { Entries: { Detail: string }[] } }])[0]
        .input.Entries[0]!.Detail,
    );
    expect(mentionDetail.mention_text).toBe('Damien');
    expect(mentionDetail.candidate_type).toBe('Person');
    expect(mentionDetail.notion_command_center_page_id).toBe('notion-page-abc');

    const outputCall = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('output.push'),
    );
    expect(outputCall).toBeDefined();
    const outputDetail = JSON.parse(
      (outputCall as unknown as [{ input: { Entries: { Detail: string }[] } }])[0]
        .input.Entries[0]!.Detail,
    );
    expect(outputDetail.is_reply).toBe(true);
    expect(outputDetail.body).toContain('✅ Saved to Command Center');
    expect(outputDetail.telegram.reply_to_message_id).toBe(1);
  });

  it('idempotent: prior ok run → no PutEvents fires', async () => {
    pgState.prior = true;
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)(baseEvent);
    expect(ebSend).not.toHaveBeenCalled();
  });
});
